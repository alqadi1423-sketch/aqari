/**
 * المراجعة الشاملة 2026-11-13 · A2.17 · منخفض · src/domain/suppliers.ts (saveSupplier) · بيانات مصطنعة.
 *
 * ما كان: تغيير اسم المورد يعيد كتابة اسمه في كل فواتير شرائه، ومنها المقفلة في ربعٍ قُدِّم إقراره، فيتغير الكشف المساند لإقرارٍ مقدَّم بعد
 * تقديمه.
 * إصلاحٌ أول (59afe08) أبقى الاسم القديم في الفواتير المقفلة، فانقطعت عن موردها: كل ورقة المورد وتقريره ومانع حذفه تربط المشتريات
 * بالاسم الحالي، فسقطت فاتورةٌ غير مسدَّدة من مستحقه، وصار المورد قابلاً للحذف، ومن يُنشأ بالاسم القديم يرثها (المدقق المستقل للمرحلة ٣).
 * الإصلاح (الهجرة ٦٦): الفاتورة مربوطةٌ بمعرّف المورد (purchases.supplier_id)، فالمقفلة تُبقي اسمه يوم تقديم إقرارها لقطةً ولا تنقطع عنه.
 */
import { memDb } from './helpers/testDb';
import { savePurchase, type PurchaseInput } from '@/domain/purchases';
import { saveSupplier } from '@/domain/suppliers';
import { fileVatReturn } from '@/domain/vatFilings';
import { vatReturnData } from '@/domain/vatReturn';
import { supplierReportData } from '@/domain/reportData';
import { linkedRefs } from '@/domain/refs';
import { initI18n } from '@/i18n';
import type { DB } from '@/db/adapter';

beforeAll(() => { initI18n('ar'); });

const OLD = 'مورد قديم مصطنع';
const NEW = 'مورد جديد مصطنع';
const purchase = (date: string): PurchaseInput => ({
  supplier: OLD, date, due: date, taxStatus: 'فاتورة ضريبية · قابلة للخصم', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: false, subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000,
} as PurchaseInput);
const nameOf = (db: DB, id: string) => db.get<{ n: string }>(`SELECT supplier_name AS n FROM purchases WHERE id = ?`, [id])!.n;
const sidOf = (db: DB, id: string) => db.get<{ s: string | null }>(`SELECT supplier_id AS s FROM purchases WHERE id = ?`, [id])!.s;
const purchaseRefs = (db: DB, sid: string) => linkedRefs(db, 'supplier', sid).find((r) => r.label === 'فاتورة شراء')?.count ?? 0;

test('A2.17 (المدقق المستقل): تغيير اسم المورد لا يُسقط فاتورةً مقفلة من تقريره ومستحقه، ولا يورثها مورداً جديداً بالاسم القديم', () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1, vatno = '300000000000003' WHERE id = 1`);
  const sid = saveSupplier(db, null, { name: OLD, vat: '311111111100003', phone: '', category: 'صيانة', amountHalalas: null, utility: '' });
  const q1 = savePurchase(db, purchase('2026-02-10'));
  const q2 = savePurchase(db, purchase('2026-05-10'));
  fileVatReturn(db, 2026, 1, '2026-04-15');
  const before = supplierReportData(db, sid, null, '2026-12-31')!.totals;
  expect(before).toMatchObject({ count: 2, outstanding: 230000 });
  saveSupplier(db, sid, { name: NEW, vat: '311111111100003', phone: '', category: 'صيانة', amountHalalas: null, utility: '' });
  // تقريره كما كان: العدد والإجمالي والمسدَّد والمستحق · ومانع حذفه يعدّ الفاتورتين
  expect(supplierReportData(db, sid, null, '2026-12-31')!.totals).toEqual(before);
  expect(purchaseRefs(db, sid)).toBe(2);
  // كلتاهما مربوطة بمعرّفه · والمقفلة تُبقي اسمه يوم تقديم إقرارها، والمفتوحة تتبع اسمه الجديد
  expect([sidOf(db, q1), sidOf(db, q2)]).toEqual([sid, sid]);
  expect([nameOf(db, q1), nameOf(db, q2)]).toEqual([OLD, NEW]);
  // موردٌ جديد بالاسم القديم لا فواتير له، ولا يمنع حذفه شيء
  const other = saveSupplier(db, null, { name: OLD, vat: '', phone: '', category: '', amountHalalas: null, utility: '' });
  expect(supplierReportData(db, other, null, '2026-12-31')!.totals).toMatchObject({ count: 0, total: 0, outstanding: 0 });
  expect(purchaseRefs(db, other)).toBe(0);
  expect(supplierReportData(db, sid, null, '2026-12-31')!.totals).toEqual(before);
  db.close();
});

test('A2.17: الكشف المساند للإقرار المقدَّم لا يتغيّر بتغيير اسم المورد بعد تقديمه، ولا بإعادته', () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1, vatno = '300000000000003' WHERE id = 1`);
  const sid = saveSupplier(db, null, { name: OLD, vat: '311111111100003', phone: '', category: 'صيانة', amountHalalas: null, utility: '' });
  savePurchase(db, purchase('2026-02-10'));
  savePurchase(db, purchase('2026-03-20'));
  fileVatReturn(db, 2026, 1, '2026-04-15');
  const filed = vatReturnData(db, 2026, 1).schedules;
  expect(filed.deductiblePurchases.map((p) => p.supplier)).toEqual([OLD, OLD]);
  saveSupplier(db, sid, { name: NEW, vat: '311111111100003', phone: '', category: 'صيانة', amountHalalas: null, utility: '' });
  expect(vatReturnData(db, 2026, 1).schedules).toEqual(filed);
  saveSupplier(db, sid, { name: 'مورد ثالث مصطنع', vat: '311111111100003', phone: '', category: 'صيانة', amountHalalas: null, utility: '' });
  expect(vatReturnData(db, 2026, 1).schedules).toEqual(filed);
  expect(supplierReportData(db, sid, null, '2026-12-31')!.totals).toMatchObject({ count: 2 });
  db.close();
});
