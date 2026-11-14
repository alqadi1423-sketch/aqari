/**
 * المدقق المستقل على إصلاح B-1 (ب) · متوسط · src/sync/engine.ts: lockedParentIssue (فرع contract_installments: «يُقبل ما دام العقد هنا
 * بلا أقساط … أو أقساطه هنا كلها من كاتب هذا القسط»)
 *
 * السيناريو (بيانات مصطنعة): عضوٌ N له «إدخال» العقود يؤكّد عقداً جديداً لوحدةٍ في عقاره (١٢ قسطاً) ويرفعه. جهاز المالك يسحب بعد أن
 * وصله رأس العقد وقبل أن يصل أي قسطٍ منه (دفعة العضو ثمانية صفوف بترتيب الجداول، أو انقطع رفعه بعد الدفعة الأولى). عضوٌ آخر M له
 * «إدخال» العقود في العقار نفسه يرى العقد في السحابة فيكتب له قسطاً بـ ٥٠٬٠٠٠ ريال. جهاز المالك يقبله (العقد عنده بلا أقساط)، ثم
 * تصل أقساط N الاثنا عشر فيرفضها كلها (في الجدول قسطٌ كاتبه غير N) ويرفع شواهد حذفها: يبقى للعقد قسط M وحده.
 *
 * لماذا يهم: «أول كاتب» ليس صاحب العقد، فعضوٌ يسبق صاحب العقد بقسطٍ واحد يملك جدول عقدٍ ليس له ويُسقط جدوله الحقيقي من كل جهاز ·
 * وكاتب العقد معروفٌ على جهاز المالك (row_by للعقد الجديد = N)، فلا حاجة إلى التخمين بأول قسط.
 *
 * السلوك الصحيح: قسط M يُرفض (العقد ليس له: كاتبه N)، وأقساط N الاثنا عشر تُقبل، فيبقى جدول العقد كما أكّده صاحبه.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { holdBack } from './helpers/rederive';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce, setSyncState } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract } from '@/domain/contracts/service';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteDoc, RemoteStore } from '@/sync/types';

const OWNER = 'OWNER-R11T';
const dev = (db: DB) => getMeta(db, 'device_id')!;

async function joinMember(r: MemoryRemote, a: Access) {
  const db = memDb();
  enableSync(db, a.uid!);
  db.run(`DELETE FROM sync_outbox`);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: OWNER, profile: { name: 'عضو مصطنع' } })]);
  setSyncState(db, 'org', OWNER);
  const remote: RemoteStore = {
    pull: (c, l) => r.pull(c, l), write: (d) => r.write(d), clockSample: () => r.clockSample(),
    reserveBlocks: (q) => r.reserveBlocks(q), takeInvoiceSeq: (f) => r.takeInvoiceSeq(f), memberMode: true,
    annotate: (d, doc) => annotate(d, doc, a).doc,
  };
  await syncOnce(db, remote, dev(db));
  return { db, sync: () => syncOnce(db, remote, dev(db)) };
}

test('B-1 (ب) · قسطٌ يسبق به عضوٌ صاحبَ العقد إلى جهاز المالك لا يملك جدول عقده', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, OWNER);
  const p = addProperty(owner, { name: 'عقار مصطنع' });
  const u = addUnit(owner, p, { unit_no: 'R11T-1' });
  await syncOnce(owner, r, dev(owner));
  const pulls = async () => { await syncOnce(owner, r, dev(owner)); await syncOnce(owner, r, dev(owner)); };

  const n = await joinMember(r, { owner: false, uid: 'MEMBER-R11T-N', perms: { contracts: 2, tenants: 2, props: 1 }, allProps: false, props: [p] });
  const c = confirmContract(n.db, contractInput(u, { tenant: 'مستأجر مصطنع ت', idNumber: '1000000601', phone: '0555550601' }) as never);
  await n.sync();
  const own = n.db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY sort`, [c]).map((x) => x.id);
  expect(own.length).toBe(12);
  // أقساط N في الطريق: وصل رأس العقد وحده
  const late = holdBack(r, (d) => d.t === 'contract_installments' && own.includes(d.k));
  expect(late.count).toBe(12);
  await pulls();
  expect(owner.get<{ s: string }>(`SELECT status AS s FROM contracts WHERE id = ?`, [c])?.s).toBeDefined();

  // عضوٌ آخر بـ«إدخال» العقود في العقار نفسه
  const m: Access = { owner: false, uid: 'MEMBER-R11T-M', perms: { contracts: 2 }, allProps: false, props: [p] };
  const k = 'R11T-FORGED';
  const forged = annotate(owner, {
    id: 'contract_installments__' + k, t: 'contract_installments', k, u: new Date().toISOString(), dev: 'DEV-M', del: false,
    d: { id: k, contract_id: c, due_date: '2026-12-01', amount_halalas: 5_000_000, status: 'مستحقة', sort: 99 },
  } as RemoteDoc, m).doc;
  expect(forged).toMatchObject({ op: 'contracts', by: 'MEMBER-R11T-M' });
  r.inject(forged);
  await pulls();
  late.release();
  await pulls();

  const insts = owner.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ?`, [c]).map((x) => x.id);
  // eslint-disable-next-line no-console
  console.log('B-1 (ب) أقساط في الطريق · عند المالك:', insts.length, '· فيها المزوَّر:', insts.includes(k));
  expect(insts.includes(k)).toBe(false);
  expect(insts.sort()).toEqual([...own].sort());
  owner.close(); n.db.close();
});
