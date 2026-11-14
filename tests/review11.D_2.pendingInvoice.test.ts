/**
 * المراجعة ١١ · تدقيق إصلاح D-2 · طابور إصدار الفواتير المعلّقة: مسودةٌ قائمة بتاريخٍ معيب توقف الطابور وتُسقط دورة المزامنة
 *
 * ادّعاء الإصلاح (٣): «فحص مبكر بالحارس نفسه في كل موضعٍ يفحص قفل الربع المقدَّم بـisFiledDate مباشرة». لكن
 * src/domain/invoiceIssue.ts يفحص isFiledDate مباشرةً في موضعين لم يُضَف إليهما الحارس: setInvoiceStatusIssued (:96)
 * وissuePendingInvoices (:125)، وكذلك setInvoiceStatus (src/domain/invoices.ts:298).
 *
 * الأثر: فاتورةٌ حُفظت بلا اتصال قبل الإصلاح بتاريخ «2026-3-15» (الحقل القديم) تنتظر الإصدار. بعد كل مزامنة ناجحة يستدعي
 * cloud.ts:311 الطابور، فيجتاز «2026-3-15» فحص الربع المقدَّم (quarterId لا يعرفه)، ويُحجز لها رقمٌ من العدّاد، ثم يرفضها postEntry
 * بـRuleViolation فيُرمى الخطأ من الطابور: لا تصدر الفواتير التي بعدها أبداً، ويسقط باقي دورة المزامنة بعده (الإهلاك الآلي ورفع
 * الملفات ونشر نقل الوحدات وفحص العضوية في cloud.ts:313-320) في كل دورة. والطابور مصمَّمٌ ليتخطّى ما لا يصدر بتاريخه ولا يوقف ما بعده
 * (tests/verifyFixes63.test.ts · ٢: «تبقى معلّقة · وما بعدها يصدر»).
 *
 * السلوك الصحيح: المسودة بتاريخٍ معيب تبقى مسودةً معلّقة ظاهرةً يغيّر المستخدم تاريخها، ولا ترمي من الطابور، وما بعدها يصدر برقمه.
 * بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import type { DB } from '@/db/adapter';
import type { InvoiceInput } from '@/domain/invoices';
import { saveInvoiceIssued, issuePendingInvoices } from '@/domain/invoiceIssue';

const register = (db: DB) => db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
const inv = (issue: string): InvoiceInput => ({ customer: 'عميل مصطنع', customerVat: '', issue, due: issue, notes: '',
  // ١٠ ريالات وضريبتها ١٥٪: ١٬٠٠٠ + ١٥٠ = ١٬١٥٠ هللة
  lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 1000, taxPct: 15, taxCode: 'S' as const }] });

test('D-2 قائم: مسودة معلّقة بتاريخ «2026-3-15» لا توقف طابور الإصدار · وما بعدها يصدر', async () => {
  const db = memDb(); register(db);
  const off = { takeInvoiceSeq: async (): Promise<number> => { throw new Error('offline'); } };
  const r1 = await saveInvoiceIssued(db, off, inv('2026-03-15'), 'مستحقة');
  const r2 = await saveInvoiceIssued(db, off, inv('2026-04-02'), 'مستحقة');
  expect([r1.pending, r2.pending]).toEqual([true, true]);
  // كما حفظها الإصدار السابق: تاريخ الإصدار كما مرّ من الحقل (المسودة بلا قيد، فلا محفّز يجمّدها)
  db.run(`UPDATE invoices SET issue = '2026-3-15', due = '2026-3-15' WHERE id = ?`, [r1.id]);

  let n = 0;
  const on = { takeInvoiceSeq: async () => ++n };
  await expect(issuePendingInvoices(db, on)).resolves.toBe(1);
  expect(db.get(`SELECT status AS s FROM invoices WHERE id = ?`, [r1.id])).toEqual({ s: 'مسودة' });
  expect(db.get(`SELECT status AS s FROM invoices WHERE id = ?`, [r2.id])).not.toEqual({ s: 'مسودة' });
  // الصادرة بقيدها: مدين 1200 بالإجمالي ١٬١٥٠ هللة
  const total = db.get<{ t: number }>(`SELECT total_halalas AS t FROM invoices WHERE id = ?`, [r2.id])!.t;
  expect(Number(total)).toBe(1150);
  // ولا قيد بتاريخٍ معيب
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE date = '2026-3-15'`)!.n).toBe(0);
  db.close();
});
