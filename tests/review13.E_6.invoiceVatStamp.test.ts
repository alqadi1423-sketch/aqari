/**
 * المراجعة الشاملة 2026-11-13 · E-6: إعادة طباعة الفاتورة الضريبية تُخرج ما صدر (القاعدة ٩٩) · الهجرة ٦٤ تحفظ في الفاتورة وضعها الضريبي
 * (`vat_registered`) ورقم البائع الضريبي (`seller_vatno`) ساعة الإصدار وساعة الإشعار الدائن، والطباعة تقرأ منهما لا من مفتاح اليوم.
 * الأرقام الذهبية بالهللات: صافي 1,000,000 وضريبة 15٪ 150,000 وإجمالي 1,150,000 · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { saveInvoice, saveCreditNote, setInvoiceStatus, invoiceVatStamp } from '@/domain/invoices';
import { buildInvoiceDoc, type CompanyInfo } from '@/domain/printDocs';
import { SCHEMA_VERSION, MIGRATIONS } from '@/db/schema';
import { openNodeDb } from '@/db/nodeAdapter';
import { migrate } from '@/db/migrations';
import { seed } from '@/db/seed';

const VATNO = '300000000000003';
const NEW_VATNO = '311111111111113';
const T = '2026-03-05';
const line = (pct: number) => ({ descr: 'إيجار مكتب مصطنع', qty: 1, priceHalalas: 1_000_000, taxPct: pct });
const inv = (pct: number) => ({ customer: 'عميل مصطنع', customerVat: '', issue: T, due: T, notes: '', lines: [line(pct)] });
const company = (db: ReturnType<typeof memDb>, on: boolean, vatno = VATNO) =>
  db.run(`UPDATE company SET vat_enabled = ?, vatno = ?, name = 'منشأة مصطنعة' WHERE id = 1`, [on ? 1 : 0, vatno]);

test('E-6 الهجرة ٦٤: عمودا الوضع الضريبي في الفواتير', () => {
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(64);
  expect(MIGRATIONS[63]).toMatch(/vat_registered/);
  const db = memDb();
  const cols = db.all<{ name: string }>(`PRAGMA table_info(invoices)`).map((c) => c.name);
  expect(cols).toEqual(expect.arrayContaining(['vat_registered', 'seller_vatno']));
  db.close();
});

test('E-6 فاتورةٌ صدرت والمنشأة مسجّلة، ثم أُطفئت الضريبة وتغيّر الرقم: تُطبع ضريبيةً برقمها يوم صدرت وسطر ضريبتها 150,000 هللة', () => {
  const db = memDb();
  company(db, true);
  const id = saveInvoice(db, inv(15), 'مستحقة');
  const row = db.get<{ s: number; t: number; tot: number }>(`SELECT subtotal_halalas s, tax_halalas t, total_halalas tot FROM invoices WHERE id = ?`, [id])!;
  expect([Number(row.s), Number(row.t), Number(row.tot)]).toEqual([1_000_000, 150_000, 1_150_000]);
  company(db, false, NEW_VATNO);
  expect(invoiceVatStamp(db, id)).toEqual({ vatRegistered: true, sellerVatNo: VATNO });
  const co: CompanyInfo = { name: 'منشأة مصطنعة', vatno: NEW_VATNO, cr: '', phone: '', address: '', vatEnabled: false };
  const html = buildInvoiceDoc(co, {
    no: 'INV-2026-0001', customerName: 'عميل مصطنع', customerVat: '', issue: T, due: T, notes: '',
    subtotalHalalas: 1_000_000, taxHalalas: 150_000, totalHalalas: 1_150_000, lines: [line(15)], ...invoiceVatStamp(db, id),
  }, '05/03/2026 10:00');
  expect(html).toContain('فاتورة ضريبية');
  expect(html).toContain(VATNO);
  expect(html).not.toContain(NEW_VATNO);
  expect(html).toContain('1,500.00');
  db.close();
});

test('E-6 فاتورةٌ صدرت قبل التسجيل ثم فُعّلت الضريبة: تبقى «فاتورة» بلا رقمٍ ضريبي ولا رمز', () => {
  const db = memDb();
  company(db, false);
  const id = saveInvoice(db, inv(0), 'مستحقة');
  company(db, true);
  expect(invoiceVatStamp(db, id)).toEqual({ vatRegistered: false, sellerVatNo: '' });
  const co: CompanyInfo = { name: 'منشأة مصطنعة', vatno: VATNO, cr: '', phone: '', address: '', vatEnabled: true };
  const html = buildInvoiceDoc(co, {
    no: 'INV-2026-0002', customerName: 'عميل مصطنع', customerVat: '', issue: T, due: T, notes: '',
    subtotalHalalas: 1_000_000, taxHalalas: 0, totalHalalas: 1_000_000, lines: [line(0)], ...invoiceVatStamp(db, id),
  }, '05/03/2026 10:00');
  expect(html).not.toContain('فاتورة ضريبية');
  expect(html).not.toContain(VATNO);
  expect(html).not.toContain('class="qr"');
  db.close();
});

test('E-6 المسودة لا تُختم، وتُختم حين تصدر · والإشعار الدائن يرث ختم فاتورته', () => {
  const db = memDb();
  company(db, true);
  const id = saveInvoice(db, inv(15), 'مسودة');
  expect(db.get<{ v: number | null }>(`SELECT vat_registered v FROM invoices WHERE id = ?`, [id])!.v).toBeNull();
  setInvoiceStatus(db, id, 'مستحقة');
  expect(db.get<{ v: number; n: string }>(`SELECT vat_registered v, seller_vatno n FROM invoices WHERE id = ?`, [id])).toEqual({ v: 1, n: VATNO });
  company(db, false, NEW_VATNO);
  const cn = saveCreditNote(db, id, { date: T, reason: 'خصم مصطنع', subtotalHalalas: 100_000 } as never);
  expect(db.get<{ v: number; n: string }>(`SELECT vat_registered v, seller_vatno n FROM invoices WHERE id = ?`, [cn])).toEqual({ v: 1, n: VATNO });
  db.close();
});

test('E-6 الفواتير القائمة قبل الهجرة: ضريبتها غير صفرية فمسجّلة، وإلا حال المنشأة يوم الترقية · والمسودة بلا ختم', () => {
  // قاعدةٌ ببنية الإصدار ٦٣ وبياناتها، ثم الترقية
  const db = openNodeDb(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  db.transaction(() => { for (let v = 0; v < 63; v++) db.exec(MIGRATIONS[v]); db.exec('PRAGMA user_version = 63'); });
  db.exec('PRAGMA foreign_keys = ON');
  db.run(`INSERT OR IGNORE INTO company (id, name) VALUES (1, 'منشأة مصطنعة')`);
  company(db, false);
  db.run(`INSERT INTO invoices (id, no, customer_name, issue, due, status, subtotal_halalas, tax_halalas, total_halalas, created_at)
          VALUES ('I1', 'INV-2026-9101', 'عميل مصطنع', ?, ?, 'مستحقة', 1000000, 150000, 1150000, ?)`, [T, T, new Date().toISOString()]);
  db.run(`INSERT INTO invoices (id, no, customer_name, issue, due, status, subtotal_halalas, tax_halalas, total_halalas, created_at)
          VALUES ('I2', 'INV-2026-9102', 'عميل مصطنع', ?, ?, 'مستحقة', 1000000, 0, 1000000, ?)`, [T, T, new Date().toISOString()]);
  db.run(`INSERT INTO invoices (id, no, customer_name, issue, due, status, subtotal_halalas, tax_halalas, total_halalas, created_at)
          VALUES ('I3', 'TMP-1', 'عميل مصطنع', ?, ?, 'مسودة', 1000000, 150000, 1150000, ?)`, [T, T, new Date().toISOString()]);
  migrate(db);
  seed(db);
  const got = db.all<{ id: string; v: number | null }>(`SELECT id, vat_registered v FROM invoices ORDER BY id`);
  expect(got).toEqual([{ id: 'I1', v: 1 }, { id: 'I2', v: 0 }, { id: 'I3', v: null }]);
  db.close();
});
