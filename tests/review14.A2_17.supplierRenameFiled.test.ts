/**
 * المراجعة الشاملة 2026-11-13 · A2.17 · منخفض · src/domain/suppliers.ts (saveSupplier) · بيانات مصطنعة.
 *
 * ما كان: تغيير اسم المورد يعيد كتابة اسمه في كل فواتير شرائه، ومنها المقفلة في ربعٍ قُدِّم إقراره، فيتغير الكشف المساند لإقرارٍ مقدَّم بعد
 * تقديمه.
 * إصلاحٌ أول (59afe08) أبقى الاسم القديم في الفواتير المقفلة، فانقطعت عن موردها: كل ورقة المورد وتقريره ومانع حذفه تربط المشتريات
 * بالاسم الحالي، فسقطت فاتورةٌ غير مسدَّدة من مستحقه، وصار المورد قابلاً للحذف، ومن يُنشأ بالاسم القديم يرثها (المدقق المستقل للمرحلة ٣).
 * فعاد الاسم يتبع المورد في كل فواتيره (قرار المالك 2026-10-09)، وA2.17 ينتظر ربط المشتريات بمعرّف المورد (هجرة).
 */
import { memDb } from './helpers/testDb';
import { savePurchase, type PurchaseInput } from '@/domain/purchases';
import { saveSupplier } from '@/domain/suppliers';
import { fileVatReturn } from '@/domain/vatFilings';
import { supplierReportData } from '@/domain/reportData';
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

test('A2.17 (المدقق المستقل): تغيير اسم المورد لا يُسقط فاتورةً مقفلة من تقريره ومستحقه، ولا يورثها مورداً جديداً بالاسم القديم', () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1, vatno = '300000000000003' WHERE id = 1`);
  const sid = saveSupplier(db, null, { name: OLD, vat: '311111111100003', phone: '', category: 'صيانة', amountHalalas: null, utility: '' });
  const q1 = savePurchase(db, purchase('2026-02-10'));
  const q2 = savePurchase(db, purchase('2026-05-10'));
  fileVatReturn(db, 2026, 1, '2026-04-15');
  const before = supplierReportData(db, sid, null, '2026-12-31')!.totals;
  saveSupplier(db, sid, { name: NEW, vat: '311111111100003', phone: '', category: 'صيانة', amountHalalas: null, utility: '' });
  expect(supplierReportData(db, sid, null, '2026-12-31')!.totals).toEqual(before);
  expect([nameOf(db, q1), nameOf(db, q2)]).toEqual([NEW, NEW]);
  // موردٌ جديد بالاسم القديم لا فواتير له
  const other = saveSupplier(db, null, { name: OLD, vat: '', phone: '', category: '', amountHalalas: null, utility: '' });
  expect(supplierReportData(db, other, null, '2026-12-31')!.totals).toMatchObject({ count: 0 });
  db.close();
});
