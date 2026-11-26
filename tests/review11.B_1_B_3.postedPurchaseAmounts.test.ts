/**
 * المدقق المستقل على إصلاح B-1 · عالٍ · src/sync/engine.ts: lockedParentIssue (LOCKED_PARENT_TABLES بلا purchases) · rulesGen.ts
 * (lockedUpdateTables بلا purchases) · src/domain/vatReturn.ts (البند ٧ من رأس فاتورة الشراء)
 *
 * السيناريو (بيانات مصطنعة): المنشأة مسجّلة، والمالك سجّل فاتورة شراءٍ «قابلة للخصم» بصافي ١٬٠٠٠ ريال وضريبة ١٥٠ (قيدها مرحَّل، و1270
 * مدينٌ بـ ١٥٠) وزامنها. عضوٌ له «كامل» المشتريات يكتب صفّها في السحابة بصافي ١٠٠٬٠٠٠ وضريبة ١٥٬٠٠٠ بلا قيد عكسٍ ولا قيدٍ جديد.
 * القاعدة تقبله، وجهاز المالك يطبّقه بلا رفض: البند ٧ في الإقرار (ضريبة المدخلات القابلة للخصم) يصير ١٥٬٠٠٠ والدفتر ١٥٠.
 *
 * لماذا يهم: التقرير يضعه في B-1 نفسه («ومثله … عضو كامل المشتريات يغيّر صافي فاتورة شراءٍ مرحّلة وضريبتها بلا قيود التصحيح. البند ٧
 * في الإقرار يُقرأ من رأس الفاتورة، فيختلف عن الدفتر»)، وفي إصلاحه ١: «وفي purchases المرحّلة: تغيّر الصافي أو الضريبة من عضوٍ بلا قيد
 * عكسٍ في الوارد نفسه يُرفض». والإصلاح لم يمسّه، فيُخصم في الإقرار المقدَّم أضعاف ما في الدفتر.
 *
 * السلوك الصحيح: جهاز المالك يرفض تغيّر صافي فاتورة الشراء المرحّلة أو ضريبتها من عضوٍ بلا قيد عكسٍ وقيدٍ جديد لها (ويعيد نسخته)،
 * فيبقى البند ٧ بقيمته في الدفتر.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce, buildDoc } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { savePurchase } from '@/domain/purchases';
import { vatReturnData } from '@/domain/vatReturn';
import type { Access } from '@/domain/access/access';

test('B-1 · «كامل» المشتريات لا يغيّر صافي فاتورة شراءٍ مرحّلة وضريبتها بلا قيد', async () => {
  const db = memDb();
  const r = new MemoryRemote();
  enableSync(db, 'OWNER-R11P');
  const dev = getMeta(db, 'device_id')!;
  db.run(`UPDATE company SET vat_enabled = 1, name = 'منشأة مصطنعة', vatno = '300000000000003' WHERE id = 1`);
  db.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['R11P-S', 'مورد مصطنع', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  const id = savePurchase(db, {
    date: '2026-04-10', due: '2026-05-10', incorpItem: '', amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false,
    unitId: null, propertyId: null, meterId: null, meterReading: null, supplier: 'مورد مصطنع', category: 'صيانة',
    taxStatus: 'فاتورة ضريبية · قابلة للخصم', subtotalHalalas: 100_000, taxHalalas: 15_000, totalHalalas: 115_000,
  } as never);
  await syncOnce(db, r, dev);
  const item7 = () => vatReturnData(db, 2026, 2).items.find((x) => x.no === '7')!;
  const before = item7();
  expect(before).toMatchObject({ amountHalalas: 100_000, taxHalalas: 15_000 });

  const m: Access = { owner: false, uid: 'MEMBER-R11P', perms: { purchases: 3 }, allProps: true, props: [] };
  const cur = buildDoc(db, 'purchases', id, 'upsert', new Date().toISOString(), 'DEV-M');
  const forged = annotate(db, { ...cur, dev: 'DEV-M', d: { ...cur.d!, subtotal_halalas: 10_000_000, tax_halalas: 1_500_000, total_halalas: 11_500_000 } }, m).doc;
  expect(forged.op).toBe('purchases');
  r.inject(forged);
  await syncOnce(db, r, dev);
  await syncOnce(db, r, dev);

  const after = item7();
  const row = db.get<{ s: number; t: number }>(`SELECT subtotal_halalas AS s, tax_halalas AS t FROM purchases WHERE id = ?`, [id])!;
  // eslint-disable-next-line no-console
  console.log('B-1 المشتريات · البند ٧ قبل:', before.taxHalalas, '· بعد:', after.taxHalalas, '· الرأس:', row);
  expect(row).toEqual({ s: 100_000, t: 15_000 });
  expect(after).toEqual(before);
  db.close();
});
