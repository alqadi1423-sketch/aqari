/**
 * A2.17 (الهجرة ٦٦) × ما بقي من ربط فاتورة الشراء بمعرّف موردها · المدقق المستقل للمرحلة ٣ · بيانات مصطنعة.
 *
 * متوسط · src/sync/engine.ts (تطبيق مستند purchases): جهازٌ بإصدارٍ أقدم (بلا supplier_id) يعدّل مورد الفاتورة من «أ» إلى «ب»، فمستنده بلا
 * المعرّف · والأجهزة على ٦٧ كانت تُبقي معرّف «أ» واسم «ب» (upsertRow يترك ما لا يحمله المستند): الفاتورة تحت «أ»، وتغيير اسم «أ» بعدها
 * يكتب اسمه الجديد عليها فتصير فاتورة «ب» فاتورةَ «أ» بلا أثر.
 * السلوك الصحيح: مستندٌ بلا المعرّف واسم مورده غير اسمه هنا يُربط بالمورد الحيّ الواحد بالاسم الجديد (وإلا بلا معرّف) · والاسم نفسه
 * (لقطة المقفلة في إقرارٍ مقدَّم) يُبقي معرّفه.
 *   TZ=Asia/Riyadh npx jest tests/review14.A2_17.supplierIdLegacy.test.ts
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { savePurchase, payPurchase, unmarkPurchasePaid, TS_EXCLUDED, type PurchaseInput } from '@/domain/purchases';
import { fileVatReturn } from '@/domain/vatFilings';
import { ownerCashIn } from '@/domain/cashOps';
import { saveSupplier } from '@/domain/suppliers';
import { supplierReportData } from '@/domain/reportData';
import { enableSync, syncOnce, docId } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import { initI18n } from '@/i18n';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

beforeAll(() => { initI18n('ar'); });

const UID = 'OWNER-A2-17-LEGACY';
const A = 'مورد أ مصطنع';
const B = 'مورد ب مصطنع';
const row = (db: DB, id: string) => db.get<{ s: string | null; n: string }>(`SELECT supplier_id AS s, supplier_name AS n FROM purchases WHERE id = ?`, [id]);
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const purchase = (supplier: string, date: string): PurchaseInput => ({
  supplier, date, due: date, taxStatus: TS_EXCLUDED, category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: false, subtotalHalalas: 100000, taxHalalas: 0, totalHalalas: 100000,
} as PurchaseInput);
const supplier = (name: string) => ({ name, vat: '', phone: '', category: 'صيانة', amountHalalas: null, utility: '' });
/** ما يرفعه جهازٌ بإصدارٍ أقدم للفاتورة بعد تعديلها: بلا supplier_id */
function legacyEdit(r: MemoryRemote, id: string, d: Record<string, unknown>): void {
  const cur = r.docs.get(docId('purchases', id))!;
  const { supplier_id: _s, ...rest } = cur.d!;
  r.inject({ ...cur, u: new Date(Date.now() + 1000).toISOString(), dev: 'dev-old-65', d: { ...rest, ...d } } as RemoteDoc);
}

test('إصدارٌ أقدم ينقل الفاتورة إلى مورد آخر: تُربط بالمورد الجديد، ولا يكتب تغيير اسم القديم عليها اسمه', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  const sa = saveSupplier(a, null, supplier(A));
  const sb = saveSupplier(a, null, supplier(B));
  const p = savePurchase(a, purchase(A, '2026-05-10'));
  const q = savePurchase(a, purchase(A, '2026-05-11'));
  await sync(a, r);
  const b = memDb();
  enableSync(b, UID);
  await sync(b, r);
  expect(row(b, p)).toEqual({ s: sa, n: A });

  // الجهاز الأقدم: «ب» للأولى · والثانية يعدّل غير المورد (الاسم نفسه) فتبقى مربوطةً بموردها
  legacyEdit(r, p, { supplier_name: B });
  legacyEdit(r, q, { category: 'كهرباء' });
  await sync(b, r);
  expect(row(b, p)).toEqual({ s: sb, n: B });
  expect(row(b, q)).toEqual({ s: sa, n: A });
  expect(supplierReportData(b, sb, null, '2026-12-31')!.totals).toMatchObject({ count: 1 });
  expect(supplierReportData(b, sa, null, '2026-12-31')!.totals).toMatchObject({ count: 1 });

  // تغيير اسم «أ» على الجهاز الآخر لا يمسّ فاتورة «ب»
  await sync(a, r);
  saveSupplier(a, sa, supplier('مورد أ بعد التسمية مصطنع'));
  expect(row(a, p)).toEqual({ s: sb, n: B });
  expect(row(a, q)).toEqual({ s: sa, n: 'مورد أ بعد التسمية مصطنع' });
  await sync(a, r);
  await sync(b, r);
  expect(row(b, p)).toEqual({ s: sb, n: B });

  // واسمٌ لا يطابق مورداً حيّاً واحداً: بلا معرّف (يُرى باسمه)
  legacyEdit(r, p, { supplier_name: 'بائع عابر مصطنع' });
  await sync(b, r);
  expect(row(b, p)).toEqual({ s: null, n: 'بائع عابر مصطنع' });
  a.close();
  b.close();
});

/*
 * منخفض · src/domain/purchases.ts (savePurchase) مع app/purchases.tsx: نموذج التعديل يملأ المورد من اسم الفاتورة، والحفظ يعيد حساب المعرّف
 * من الاسم · فاتورةٌ أبقت لقطة اسمها القديم (سُدِّدت في ربعٍ قُدِّم إقراره، ثم تُرجع سدادها وعُدّلت) كانت تفقد معرّف موردها.
 * السلوك الصحيح: التعديل بالاسم المخزَّن نفسه يُبقي المعرّف القائم.
 */
test('تعديل فاتورةٍ أبقت اسم موردها القديم بالاسم نفسه يُبقيها مربوطةً بموردها', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 500000, date: '2026-01-01' });
  const sid = saveSupplier(db, null, supplier(A));
  // فاتورة الربع الثاني سُدِّدت مقدَّماً في الربع الأول، ثم قُدِّم إقراره
  const p = savePurchase(db, purchase(A, '2026-04-10'));
  payPurchase(db, p, 'cash', null, '2026-03-20');
  fileVatReturn(db, 2026, 1, '2026-04-15');
  saveSupplier(db, sid, supplier('مورد أ بعد التسمية مصطنع'));
  expect(row(db, p)).toEqual({ s: sid, n: A });
  // يُتراجع عن سدادها ثم تُعدَّل من النموذج باسمها المخزَّن
  unmarkPurchasePaid(db, p);
  savePurchase(db, { ...purchase(A, '2026-04-10'), subtotalHalalas: 90000, totalHalalas: 90000 }, p);
  expect(row(db, p)).toEqual({ s: sid, n: A });
  expect(supplierReportData(db, sid, null, '2026-12-31')!.totals).toMatchObject({ count: 1, total: 90000 });
  // واسمٌ آخر يُعاد حسابه منه
  savePurchase(db, { ...purchase('مورد أ بعد التسمية مصطنع', '2026-04-10'), subtotalHalalas: 90000, totalHalalas: 90000 }, p);
  expect(row(db, p)).toEqual({ s: sid, n: 'مورد أ بعد التسمية مصطنع' });
  db.close();
});
