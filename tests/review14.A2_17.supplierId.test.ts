/**
 * المراجعة الشاملة 2026-11-13 · A2.17 · الهجرة ٦٦: فاتورة الشراء مربوطةٌ بمعرّف المورد (purchases.supplier_id) · بيانات مصطنعة.
 *  - الهجرة تملؤه للقائم من مطابقة الاسم (بلا فراغات الطرفين، موردٌ حيّ واحد) وتتركه فارغاً لما التبس أو لم يطابق، ولا تلتقطه للرفع
 *  - الفاتورة الجديدة والمعدَّلة تحمله · ويُزامَن كسائر أعمدتها، وإعادة تسمية المورد ترفعه لكل فواتيره فيعرفها الجهاز الجديد
 *  - ورقة المورد وتقريره ومانع حذفه ومرشِّح الشراء بالمعرّف، وما لا معرّف له باسمه الحالي
 *   TZ=Asia/Riyadh npx jest tests/review14.A2_17.supplierId.test.ts
 */
import { memDb } from './helpers/testDb';
import { schemaAt, ins, fill } from './helpers/oldSchema';
import { MemoryRemote } from './helpers/memoryRemote';
import { migrate, currentSchemaVersion } from '@/db/migrations';
import { SCHEMA_VERSION } from '@/db/schema';
import { savePurchase, TS_EXCLUDED, type PurchaseInput } from '@/domain/purchases';
import { saveSupplier, supplierPurchasesSql } from '@/domain/suppliers';
import { fileVatReturn } from '@/domain/vatFilings';
import { vatReturnData } from '@/domain/vatReturn';
import { supplierReportData } from '@/domain/reportData';
import { linkedRefs } from '@/domain/refs';
import { enableSync, syncOnce, docId } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import { initI18n } from '@/i18n';
import type { DB } from '@/db/adapter';

beforeAll(() => { initI18n('ar'); });

const T = '2026-01-01T00:00:00.000Z';
const UID = 'OWNER-A2-17-SID';
const OLD = 'مورد قديم مصطنع';
const NEW = 'مورد جديد مصطنع';
const sidOf = (db: DB, id: string) => db.get<{ s: string | null }>(`SELECT supplier_id AS s FROM purchases WHERE id = ?`, [id])?.s ?? null;
const dev = (db: DB) => getMeta(db, 'device_id')!;
const purchase = (supplier: string, date: string): PurchaseInput => ({
  supplier, date, due: date, taxStatus: 'فاتورة ضريبية · قابلة للخصم', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: false, subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000,
} as PurchaseInput);
const supplier = (name: string, vat = '') => ({ name, vat, phone: '', category: 'صيانة', amountHalalas: null, utility: '' });

test('الهجرة ٦٦ على قاعدةٍ بالإصدار ٦٥: المعرّف من مطابقة الاسم الواحدة، والملتبس وما لا يطابق والمحذوف فارغ، ولا شيء يُلتقط للرفع', () => {
  const db = schemaAt(':memory:', 65);
  fill(db);
  // الالتقاط مفعّل كجهازٍ متصل: الهجرة لا ترفع الفواتير كلها بوقت الترقية فتغلب تعديلاً أحدث من جهازٍ آخر
  db.run(`INSERT OR REPLACE INTO sync_ctl (k, v) VALUES ('capture', 1)`);
  db.run(`DELETE FROM sync_outbox`);
  ins(db, 'suppliers', { id: 'S1', name: 'مورد أ مصطنع', created_at: T });
  ins(db, 'suppliers', { id: 'S2', name: '  مورد ب مصطنع ', created_at: T });
  ins(db, 'suppliers', { id: 'S3', name: 'مورد مكرر مصطنع', created_at: T });
  ins(db, 'suppliers', { id: 'S4', name: 'مورد مكرر مصطنع', created_at: T });
  ins(db, 'suppliers', { id: 'S5', name: 'مورد محذوف مصطنع', created_at: T, deleted_at: T });
  ins(db, 'suppliers', { id: 'S6', name: 'مورد ج مصطنع', created_at: T, archived: 1 });
  const p = (id: string, name: string) => ins(db, 'purchases', {
    id, no: 'PUR-' + id, supplier_name: name, date: '2026-01-10', subtotal_halalas: 1000, total_halalas: 1000, created_at: T,
  });
  p('P1', 'مورد أ مصطنع');
  p('P2', ' مورد أ مصطنع  ');
  p('P3', 'مورد ب مصطنع');
  p('P4', 'مورد مكرر مصطنع');
  p('P5', 'مورد محذوف مصطنع');
  p('P6', 'مورد بلا بطاقة مصطنع');
  p('P7', 'مورد ج مصطنع');
  db.run(`DELETE FROM sync_outbox`);

  migrate(db);
  expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
  // الهجرة ٦٦ جرت (والهجرات بعدها تبني عليها · ٦٧ مسودة البنك) · وأثرها مفحوصٌ بالأعمدة والقيم أدناه
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(66);
  expect(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'].map((id) => sidOf(db, id))).toEqual(['S1', 'S1', 'S2', null, null, null, 'S6']);
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_outbox WHERE tbl = 'purchases'`)!.n).toBe(0);
  expect(db.get<{ v: number }>(`SELECT v FROM sync_ctl WHERE k = 'capture'`)!.v).toBe(1);
  // والفهرس للبحث بالمورد
  expect(db.get(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ix_purchases_supplier'`)).toBeTruthy();
  // والملتبس يُرى بالاسم عند كلا الموردين كما كان (لا معرّف له)
  const n = (sid: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM purchases p WHERE ${supplierPurchasesSql('p')}`, [sid, sid])!.n;
  expect([n('S1'), n('S2'), n('S3'), n('S4'), n('S6')]).toEqual([2, 1, 1, 1, 1]);
  db.close();
});

test('الفاتورة الجديدة والمعدَّلة تحمل معرّف موردها، وغير المطابقة بلا معرّف', () => {
  const db = memDb();
  const a = saveSupplier(db, null, supplier(OLD));
  const b = saveSupplier(db, null, supplier(NEW));
  const p = savePurchase(db, { ...purchase(' ' + OLD + ' ', '2026-02-10'), taxStatus: TS_EXCLUDED, taxHalalas: 0, totalHalalas: 100000 });
  expect(sidOf(db, p)).toBe(a);
  savePurchase(db, { ...purchase(NEW, '2026-02-10'), taxStatus: TS_EXCLUDED, taxHalalas: 0, totalHalalas: 100000 }, p);
  expect(sidOf(db, p)).toBe(b);
  savePurchase(db, { ...purchase('بائع عابر مصطنع', '2026-02-10'), taxStatus: TS_EXCLUDED, taxHalalas: 0, totalHalalas: 100000 }, p);
  expect(sidOf(db, p)).toBeNull();
  db.close();
});

test('مزامنة: المعرّف يصل الجهاز الآخر · وإعادة التسمية بعد التقديم ترفعه لفاتورةٍ رُفعت بلا معرّف، فيراها الجهاز الجديد تحت موردها', async () => {
  const a = memDb();
  a.run(`UPDATE company SET vat_enabled = 1, vatno = '300000000000003' WHERE id = 1`);
  const remote = new MemoryRemote();
  enableSync(a, UID);
  const sid = saveSupplier(a, null, supplier(OLD, '311111111100003'));
  const q1 = savePurchase(a, purchase(OLD, '2026-02-10'));
  await syncOnce(a, remote, dev(a));
  expect(remote.docs.get(docId('purchases', q1))!.d!.supplier_id).toBe(sid);

  const b = memDb();
  enableSync(b, UID);
  await syncOnce(b, remote, dev(b));
  expect(sidOf(b, q1)).toBe(sid);

  // فاتورةٌ رُفعت من إصدارٍ قبل الهجرة ٦٦ (مستندها بلا المعرّف) وملأته هجرة الجهاز «أ» محلياً بلا رفع
  const q0 = savePurchase(a, purchase(OLD, '2026-03-01'));
  await syncOnce(a, remote, dev(a));
  const legacy = remote.docs.get(docId('purchases', q0))!;
  delete legacy.d!.supplier_id;
  fileVatReturn(a, 2026, 1, '2026-04-15');
  await syncOnce(a, remote, dev(a));
  const filed = vatReturnData(a, 2026, 1).schedules;

  saveSupplier(a, sid, supplier(NEW, '311111111100003'));
  await syncOnce(a, remote, dev(a));
  expect(remote.docs.get(docId('purchases', q0))!.d!.supplier_id).toBe(sid);
  expect(remote.docs.get(docId('purchases', q0))!.d!.supplier_name).toBe(OLD);

  // جهازٌ جديد يسحب كل شيء: الفاتورتان تحت موردهما باسمه الجديد، والكشف المقدَّم كما كان، والمورد الجديد بالاسم القديم لا يرث شيئاً
  const c = memDb();
  enableSync(c, UID);
  await syncOnce(c, remote, dev(c));
  expect(supplierReportData(c, sid, null, '2026-12-31')!.totals).toEqual(supplierReportData(a, sid, null, '2026-12-31')!.totals);
  expect(supplierReportData(c, sid, null, '2026-12-31')!.totals).toMatchObject({ count: 2, outstanding: 230000 });
  expect(vatReturnData(c, 2026, 1).schedules).toEqual(filed);
  const other = saveSupplier(c, null, supplier(OLD));
  expect(supplierReportData(c, other, null, '2026-12-31')!.totals).toMatchObject({ count: 0 });
  expect(linkedRefs(c, 'supplier', other).some((r) => r.label === 'فاتورة شراء')).toBe(false);
  expect(linkedRefs(c, 'supplier', sid).find((r) => r.label === 'فاتورة شراء')?.count).toBe(2);
  for (const d of [a, b, c]) d.close();
});
