/**
 * مدقق المرحلة ١ المستقل (المراجعة الشاملة 2026-11-13) · المزامنة · B-1 · بيانات مصطنعة كلها.
 *
 * العيب: حارس «الفاتورة الصادرة مقفلة» على جهاز المالك (engine.ts: issuedInvoiceSealed) يعدّ فاتورة العضو مكتملة السطور متى ساوى مجموعُ
 *   ما وصل من سطورها صافيها وضريبتها. والسطور تُطبَّق واحداً واحداً (applyOne)، فسطرٌ بسعرٍ صفر (بندٌ مجاني، أو سطرٌ تُرك فارغاً في
 *   نموذج الفاتورة: الشاشة لا تحذف الفارغ) يصل بعد السطر المسعَّر فيجد الفاتورة «مختومة» فيُرفض، ويرفع جهاز المالك «نسخته» منه، وهي
 *   شاهد حذف لأنه ليس عنده، فيُحذف السطر من السحابة ومن جهاز العضو نفسه.
 * السيناريو: عضو «كامل الفواتير» يصدر فاتورةً بثلاثة سطور: خدمة ١٬٠٠٠ ريال (١٥٪)، و«تركيب مجاني» بصفر، وسطرٌ فارغ بصفر · ويزامن.
 *   ترتيب السطور في الرفع والتطبيق بمعرّفها (عشوائي)، ودفعة العضو ثمانية صفوف، فيصل السطر الصفري بعد المسعَّر في دفعةٍ لاحقة أو في
 *   المرور نفسه بعده · والاختبار يثبّت الترتيب بحبس السطرين الصفريين حتى يسحب المالك ما قبلهما (holdBack كاختبار B-1 القائم).
 * اليوم: عند المالك سطرٌ واحد، ورفضان «الفاتورة الصادرة مقفلة» في حالة المزامنة لكتابةٍ لم يزوّر فيها أحد، والسطران محذوفان من
 *   السحابة ومن جهاز العضو: الفاتورة الصادرة تغيّرت بعد إصدارها (ما طُبع للعميل بثلاثة سطور، والمخزَّن بسطر).
 * الصحيح: فاتورة العضو كما أصدرها بسطورها الثلاثة على الجهازين وفي السحابة، ولا رفض · والمبالغ: صافي ١٠٠٬٠٠٠ هللة وضريبة ١٥٬٠٠٠.
 *   TZ=Asia/Riyadh npx jest tests/review12.sync.zeroPriceLine.test.ts
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit } from './helpers/fixtures';
import { enableSync, syncOnce, setSyncState } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { holdBack } from './helpers/rederive';
import { saveInvoice } from '@/domain/invoices';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteStore } from '@/sync/types';

const OWNER = 'OWNER-R12-ZL';
const dev = (db: DB) => getMeta(db, 'device_id')!;

/** جهاز عضوٍ منضمّ (طابوره فارغ، ومستنداته بقسمه وكاتبه كما يبنيها annotate) · كـ tests/review9.B.lockedParentFlows.test.ts */
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

const linesOf = (db: DB, id: string) => db.all<{ descr: string; price: number }>(
  `SELECT descr, price_halalas AS price FROM invoice_lines WHERE invoice_id = ? ORDER BY sort`, [id]).map((l) => [l.descr, Number(l.price)]);

test('B-1 · فاتورة عضوٍ صادرة فيها سطرٌ بسعرٍ صفر تصل جهاز المالك بسطورها كلها ولا يُحذف منها شيء', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, OWNER);
  owner.run(`UPDATE company SET vat_enabled = 1, name = 'منشأة مصطنعة', vatno = '300000000000003' WHERE id = 1`);
  const u = addUnit(owner, addProperty(owner, { name: 'عقار مصطنع' }), { unit_no: 'ZL-1' });
  await syncOnce(owner, r, dev(owner));

  const m = await joinMember(r, { owner: false, uid: 'M-R12-ZL', perms: { invoices: 3 }, allProps: true, props: [] } as Access);
  const id = saveInvoice(m.db, {
    customer: 'عميل مصطنع', customerVat: '', issue: '2026-04-10', due: '2026-04-30', notes: '', unitId: u, propertyId: null,
    lines: [
      { descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100_000, taxPct: 15, taxCode: 'S' },
      { descr: 'تركيب مجاني', qty: 1, priceHalalas: 0, taxPct: 15, taxCode: 'S' },
      { descr: '', qty: 1, priceHalalas: 0, taxPct: 15, taxCode: 'S' },
    ],
  }, 'مستحقة');
  const issued = [['خدمة مصطنعة', 100_000], ['تركيب مجاني', 0], ['', 0]];
  expect(linesOf(m.db, id)).toEqual(issued);
  await m.sync();
  // السطران الصفريان في الدفعة التالية: يسحب المالك الرأس وقيده والسطر المسعَّر أولاً
  const zeroIds = m.db.all<{ id: string }>(`SELECT id FROM invoice_lines WHERE invoice_id = ? AND price_halalas = 0`, [id]).map((x) => x.id);
  const late = holdBack(r, (d) => d.t === 'invoice_lines' && zeroIds.includes(d.k));
  expect(late.count).toBe(2);
  await syncOnce(owner, r, dev(owner));
  await syncOnce(owner, r, dev(owner));
  expect(linesOf(owner, id)).toEqual([['خدمة مصطنعة', 100_000]]);
  late.release();
  await syncOnce(owner, r, dev(owner));
  await syncOnce(owner, r, dev(owner));
  await m.sync();

  // الرأس كما صدر: ١٠٠٬٠٠٠ هللة صافياً و١٥٬٠٠٠ ضريبة
  expect(owner.get<{ s: number; t: number }>(`SELECT subtotal_halalas AS s, tax_halalas AS t FROM invoices WHERE id = ?`, [id]))
    .toEqual({ s: 100_000, t: 15_000 });
  // لا رفض لما كتبه التطبيق نفسه (اليوم: رفضان «الفاتورة الصادرة مقفلة»)
  expect(owner.all(`SELECT pk FROM sync_rejects WHERE tbl = 'invoice_lines'`)).toEqual([]);
  // والسطور الثلاثة على جهاز المالك وعلى جهاز العضو (اليوم: سطرٌ واحد على الجهازين، والسطران شاهدا حذفٍ في السحابة)
  expect(linesOf(owner, id)).toEqual(issued);
  expect(linesOf(m.db, id)).toEqual(issued);
  owner.close();
  m.db.close();
});
