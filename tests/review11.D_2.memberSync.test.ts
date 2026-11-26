/**
 * المراجعة ١١ · تدقيق إصلاح D-2 · المزامنة: جهاز المالك لا يفحص صيغة تاريخ قيد العضو
 *
 * الإصلاح وضع الحارس (requireISODate) في postEntry وrequireOpenPeriod على الجهاز الكاتب وحده. أما قيد التحصيل الذي يكتبه عضوٌ
 * ويصل جهاز المالك بالمزامنة فيُفحص في src/sync/engine.ts (memberRentCheck ← rentCheckAgainst) بقفل الربع عبر
 * filingRecordedAt(date) ← quarterId، وهو يعيد null لتاريخٍ بغير صيغته («2026-2-01»)، فلا يُرفض، ويُطبَّق القيد في دفتر المالك
 * بتاريخٍ لا يقع في شهرٍ ولا ربع، وفي ربعٍ قُدِّم إقراره. وهذا هو خطأ D-2 نفسه من طريق المزامنة: عضوٌ بإصدارٍ أقدم (حقله يمرّر
 * المكتوب كما هو) يكتب الدفعة، والمشروع يعدّ جهاز المالك الحَكَم على كتابة العضو (الجولة ٣٥ (أ٤): «كان يُفحص على الجهاز الكاتب
 * وحده»).
 *
 * السلوك الصحيح: قيد العضو بتاريخٍ ليس بصيغة YYYY-MM-DD ويومٍ قائمٍ في شهره يُرفض على جهاز المالك ولا يدخل دفتره، كما يُرفض
 * القيد نفسه بتاريخه الصحيح «2026-02-01» في الربع المقدَّم (tests/deriveRent.test.ts · أ٤). بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce } from '@/sync/engine';
import { fileVatReturn } from '@/domain/vatFilings';
import { getMeta } from '@/repos/settings';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

const UID = 'owner-d2';
const MEMBER = 'member-d2';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const docsOf = (r: MemoryRemote, t: string) => [...r.docs.values()].filter((d) => d.t === t);

/** العضو يحصّل دفعةً في الربع الأول، والمالك يقدّم إقراره، ثم يصل قيد العضو ودفعته بالتاريخ المعطى · يعيد معرّف القيد */
async function memberPaysIn(date: string) {
  const r = new MemoryRemote();
  const owner = memDb();
  const dev = memDb();
  enableSync(owner, UID);
  enableSync(dev, UID);
  const cid = confirmContract(owner, contractInput(addUnit(owner, addProperty(owner, { name: 'عقار مزامنة مصطنع' })),
    { tenant: 'مستأجر مزامنة مصطنع', idNumber: '1000000911', phone: '0500000911', start: '2026-01-01', depositHalalas: 0 }));
  await sync(owner, r);
  await sync(dev, r);
  const inst = dev.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  recordRentPayment(dev, cid, { installmentId: inst.id, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  fileVatReturn(owner, 2026, 1, '2026-04-15');
  await sync(owner, r);
  await sync(dev, r);
  // العضو بإصدارٍ أقدم كتب التاريخ بيده «2026-2-01»: الدفعة وقيدها بالتاريخ نفسه (rentEntryIssue يطابقهما)
  const bad = date;
  const pay = docsOf(r, 'contract_payments').pop()!;
  r.inject({ ...pay, by: MEMBER, d: { ...pay.d!, date: bad } } as RemoteDoc);
  const e = docsOf(r, 'journal_entries').filter((d) => d.d?.src_type === 'rent').pop()!;
  r.inject({ ...e, by: MEMBER, d: { ...e.d!, date: bad } } as RemoteDoc);
  await sync(owner, r);
  await sync(owner, r);
  return { owner, dev, k: e.k };
}

test('D-2 عبر المزامنة (الضابط): قيد العضو بتاريخه الصحيح «2026-02-01» في الربع المقدَّم يُرفض على جهاز المالك', async () => {
  const { owner, dev, k } = await memberPaysIn('2026-02-01');
  expect(owner.get(`SELECT 1 FROM journal_entries WHERE id = ? AND status = 'مرحّل'`, [k])).toBeFalsy();
  owner.close(); dev.close();
});

test('D-2 عبر المزامنة: والقيد نفسه بتاريخ «2026-2-01» (عضوٌ بإصدارٍ أقدم) يُرفض كذلك ولا يدخل دفتر المالك', async () => {
  const bad = '2026-2-01';
  const { owner, dev, k } = await memberPaysIn(bad);
  // لا قيد في دفتر المالك بتاريخٍ بغير صيغته · ولا قيد العضو مرحّلاً في الربع المقدَّم
  expect(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE date = ?`, [bad])!.n).toBe(0);
  expect(owner.get(`SELECT 1 FROM journal_entries WHERE id = ? AND status = 'مرحّل'`, [k])).toBeFalsy();
  owner.close(); dev.close();
});
