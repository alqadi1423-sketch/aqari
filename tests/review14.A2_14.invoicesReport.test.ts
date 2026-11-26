/**
 * المراجعة الشاملة 2026-11-13 · A2.14 · منخفض · src/domain/reportData.ts (invoicesReportData) · src/services/reportExport.ts · بيانات مصطنعة.
 *
 * ما كان: تقرير الفواتير بلا شرط الحالة، فتدخل المسودات (برقمها المؤقت TMP) «الإجمالي العام» ويُطبع رقمها المؤقت، والقرار: الرقم المؤقت
 * «لا يُطبع» · والإشعار الدائن يظهر كفاتورة.
 * الإصلاح: المسودات خارج التقرير ومجاميعه، والرقم بـinvoiceNoLabel، والإشعار الدائن بنوعه.
 * الأرقام الذهبية: فاتورة صادرة ١٬٠٠٠٫٠٠ + ١٥٠٫٠٠ = ١٬١٥٠٫٠٠، وإشعار دائن عليها ٢٠٠٫٠٠ + ٣٠٫٠٠ = −٢٣٠٫٠٠، ومسودة ٥٠٠٫٠٠ ·
 * التقرير: صفّان، والإجمالي العام ٩٢٠٫٠٠ (= ذمة الفاتورة في 1200).
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { saveInvoice, saveCreditNote, type InvoiceInput } from '@/domain/invoices';
import * as reportData from '@/domain/reportData';
import { accountBalance } from '@/domain/accounting/ledger';
import { initI18n } from '@/i18n';

beforeAll(() => { initI18n('ar'); });

const inv = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
  customer: 'عميل تقرير مصطنع', customerVat: '', issue: '2026-02-10', due: '2026-03-10', notes: '',
  lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100000, taxPct: 15 }], ...over,
});

test('A2.14 المسودات خارج تقرير الفواتير ومجاميعه · والإشعار الدائن بنوعه وصافي الإجمالي = الذمة', () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1, vatno = '300000000000003' WHERE id = 1`);
  const id = saveInvoice(db, inv(), 'مستحقة');
  saveCreditNote(db, id, { date: '2026-02-20', reason: 'خصم مصطنع', subtotalHalalas: 20000 });
  saveInvoice(db, inv({ lines: [{ descr: 'مسودة مصطنعة', qty: 1, priceHalalas: 50000, taxPct: 15 }] }), 'مسودة');
  const d = reportData.invoicesReportData(db, '2026-01-01', '2026-12-31');
  expect(d.rows.map((r) => Number(r.total_halalas))).toEqual([-23000, 115000]);
  expect(d.grand).toEqual({ count: 2, total: 92000 });
  expect(d.grand.total).toBe(accountBalance(db, '1200'));
  expect(d.rows.some((r) => r.status === 'مسودة' || r.no.startsWith('TMP'))).toBe(false);
  const label = (reportData as unknown as { invoiceReportNo: (r: { no: string; kind?: string | null }) => string }).invoiceReportNo;
  const cn = d.rows.find((r) => Number(r.total_halalas) < 0)!;
  expect(label(cn)).toBe('إشعار دائن ' + cn.no);
  expect(label({ no: 'TMP-ABC-1', kind: 'invoice' })).toBe('مسودة بلا رقم');
  db.close();
});

test('A2.14 التصدير يطبع الرقم بنوعه لا الرقم الخام', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'reportExport.ts'), 'utf8');
  const block = src.slice(src.indexOf('function invoicesBlock('), src.indexOf('}', src.indexOf("['الإجمالي العام'")));
  expect(block).toMatch(/invoiceReportNo\(r\)/);
  expect(block).not.toMatch(/rows: d\.rows\.map\(\(r\) => \[r\.no,/);
});
