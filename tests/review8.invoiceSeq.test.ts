/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ١٢: الرقم المحجوز كان يُفرَّغ خارج معاملة استعماله، فإغلاق التطبيق بين حفظ الفاتورة
 * وتفريغه يترك رقماً مستعملاً محجوزاً: تفشل كل فاتورة بعده على الجهاز، أو يتكرر رقمها في سنة جديدة · بيانات مصطنعة.
 * وتتمة المراجعة الأخيرة: المحجوز الذي لم يُستعمل كان يُهمل إن وصل بالمزامنة رقمٌ أعلى أصدره جهازٌ آخر، فيبقى رقمه فجوةً في التسلسل.
 */
import { memDb } from './helpers/testDb';
import { saveInvoiceIssued, setInvoiceStatusIssued, issueCreditNote, INV_RESERVED_KEY } from '@/domain/invoiceIssue';
import { saveInvoice, type InvoiceInput } from '@/domain/invoices';
import { fileVatReturn } from '@/domain/vatFilings';
import type { DB } from '@/db/adapter';

const inv = (issue: string): InvoiceInput => ({ customer: 'عميل مصطنع', customerVat: '', issue, due: issue, notes: '',
  lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 10000, taxPct: 15, taxCode: 'S' }] });
/** عدّاد سحابةٍ مصطنع: كل طلبٍ رقمٌ بعد أعلى ما رآه وما يعرفه الجهاز */
const counter = () => { let n = 0; return { takeInvoiceSeq: async (floor: number) => (n = Math.max(n, floor) + 1) }; };
const reserved = (db: ReturnType<typeof memDb>) => db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [INV_RESERVED_KEY])?.value ?? null;
const nos = (db: ReturnType<typeof memDb>) => db.all<{ no: string }>(`SELECT no FROM invoices ORDER BY created_at, no`).map((r) => r.no);

test('١٢ رقمٌ محجوز بقي بعد استعماله (أُغلق التطبيق قبل تفريغه) لا يُعاد: الفاتورة التالية برقمٍ جديد', async () => {
  const db = memDb();
  const src = counter();
  await saveInvoiceIssued(db, src, inv('2026-02-10'), 'مستحقة');
  // ما يتركه الإغلاق بين الحفظ والتفريغ
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')`, [INV_RESERVED_KEY]);
  const r = await saveInvoiceIssued(db, src, inv('2026-02-11'), 'مستحقة');
  expect(r.pending).toBe(false);
  expect(nos(db)).toEqual(['INV-2026-0001', 'INV-2026-0002']);
  expect(reserved(db)).toBeNull();
  db.close();
});

test('١٢ ولا يتكرر الرقم في سنة جديدة', async () => {
  const db = memDb();
  const src = counter();
  await saveInvoiceIssued(db, src, inv('2026-12-30'), 'مستحقة');
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')`, [INV_RESERVED_KEY]);
  await saveInvoiceIssued(db, src, inv('2027-01-02'), 'مستحقة');
  expect(nos(db)).toEqual(['INV-2026-0001', 'INV-2027-0002']);
  db.close();
});

test('١٢ والتفريغ مع الحفظ في معاملة واحدة: الفاتورة والإشعار لا يتركان المحجوز', async () => {
  const db = memDb();
  const src = counter();
  const { id } = await saveInvoiceIssued(db, src, inv('2026-02-10'), 'مستحقة');
  expect(reserved(db)).toBeNull();
  await issueCreditNote(db, src, id, { date: '2026-02-12', subtotalHalalas: 1000, reason: 'تصحيح مصطنع' });
  expect(reserved(db)).toBeNull();
  // وحفظٌ فشل بعد أخذ الرقم لا يفرّغ المحجوز: تأخذه الفاتورة التالية فلا فجوة · (تتمة المراجعة الأخيرة: كان الفشل هنا بمدخلٍ مرفوض،
  // وصار المدخل المرفوض يُفحص قبل الحجز فلا يأخذ رقماً، فالفشل بعد الحجز عطلُ كتابة)
  await expect(saveInvoiceIssued(brokenWrite(db), src, inv('2026-02-13'), 'مستحقة')).rejects.toThrow('عطل كتابة مصطنع');
  expect(reserved(db)).toBe('3');
  await saveInvoiceIssued(db, src, inv('2026-02-14'), 'مستحقة');
  expect(nos(db)).toContain('INV-2026-0003');
  expect(reserved(db)).toBeNull();
  db.close();
});

/* ═══════════ تتمة · المراجعة الأخيرة: المحجوز الذي لم يُستعمل لا يُهمل لأن جهازاً آخر أصدر رقماً أعلى ═══════════ */

/** ما يصل بالمزامنة: صفّ فاتورةٍ أصدرها جهازٌ آخر يُنسخ برقمه (قيده لا يلزم هنا) */
const syncRow = (from: DB, to: DB, id: string) => {
  const r: Record<string, unknown> = { ...from.get<Record<string, unknown>>(`SELECT * FROM invoices WHERE id = ?`, [id])!, journal_entry_id: null };
  const cols = Object.keys(r);
  to.run(`INSERT INTO invoices (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => r[c] as never));
};
/** عطلٌ في الكتابة المحلية بعد أخذ الرقم (أو إغلاقٌ قبلها) */
const brokenWrite = (db: DB): DB => ({ ...db, run: (sql, p) => { if (sql.includes('INSERT INTO invoices')) throw new Error('عطل كتابة مصطنع'); db.run(sql, p); } });
const register = (db: DB) => db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
const seqs = (db: DB) => db.all<{ no: string }>(`SELECT no FROM invoices`).map((r) => Number(r.no.slice(9))).sort((a, b) => a - b);

test('١٢ تتمة: رقمٌ محجوز لم تُكتب فاتورته يأخذه الإصدار التالي ولو أصدر جهازٌ آخر رقماً أعلى وصل بالمزامنة · فلا فجوة', async () => {
  const A = memDb(); const B = memDb();
  const src = counter();
  await saveInvoiceIssued(A, src, inv('2026-02-10'), 'مستحقة');
  await saveInvoiceIssued(A, src, inv('2026-02-11'), 'مستحقة');
  await expect(saveInvoiceIssued(brokenWrite(A), src, inv('2026-02-12'), 'مستحقة')).rejects.toThrow('عطل كتابة مصطنع');
  expect(reserved(A)).toBe('3');
  // الجهاز الثاني يصدر الرابع ويصل إلى الأول
  const b = await saveInvoiceIssued(B, src, inv('2026-02-13'), 'مستحقة');
  expect(nos(B)).toEqual(['INV-2026-0004']);
  syncRow(B, A, b.id);
  await saveInvoiceIssued(A, src, inv('2026-02-14'), 'مستحقة');
  await saveInvoiceIssued(A, src, inv('2026-02-15'), 'مستحقة');
  expect(seqs(A)).toEqual([1, 2, 3, 4, 5]);
  expect(reserved(A)).toBeNull();
  A.close(); B.close();
});

test('١٢ تتمة: والإشعار الدائن كذلك يأخذ المحجوز · والمحجوز الذي صدر به إشعارٌ على الجهاز يُهمل', async () => {
  const A = memDb(); const B = memDb();
  const src = counter();
  const { id } = await saveInvoiceIssued(A, src, inv('2026-02-10'), 'مستحقة');
  await expect(saveInvoiceIssued(brokenWrite(A), src, inv('2026-02-12'), 'مستحقة')).rejects.toThrow('عطل كتابة مصطنع');
  expect(reserved(A)).toBe('2');
  const b = await saveInvoiceIssued(B, src, inv('2026-02-13'), 'مستحقة');
  syncRow(B, A, b.id);
  await issueCreditNote(A, src, id, { date: '2026-02-14', subtotalHalalas: 1000, reason: 'تصحيح مصطنع' });
  expect(seqs(A)).toEqual([1, 2, 3]);
  // ما يتركه إغلاقٌ بين كتابة الإشعار وتفريغ محجوزه (قبل البند ١٢): مستعملٌ فيُهمل ولا يتكرر
  A.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, '2')`, [INV_RESERVED_KEY]);
  await saveInvoiceIssued(A, src, inv('2026-02-15'), 'مستحقة');
  expect(seqs(A)).toEqual([1, 2, 3, 4]);
  A.close(); B.close();
});

test('١٢ تتمة: كتابةٌ ستُرفض حتماً بمدخلاتها لا تحجز رقماً · فلا يُترك رقمٌ معلّقاً على الجهاز', async () => {
  const A = memDb(); const B = memDb();
  register(A);
  const src = counter();
  const { id } = await saveInvoiceIssued(A, src, inv('2026-02-10'), 'مستحقة');
  fileVatReturn(A, 2026, 1, '2026-04-05');
  // تاريخ إصدارٍ في ربعٍ قُدِّم إقراره
  await expect(saveInvoiceIssued(A, src, inv('2026-03-20'), 'مستحقة')).rejects.toThrow();
  // رمزٌ خاضع بنسبة صفر (البند ٦)
  const bad = { ...inv('2026-04-13'), lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100, taxPct: 0, taxCode: 'S' as const }] };
  await expect(saveInvoiceIssued(A, src, bad, 'مستحقة')).rejects.toThrow();
  // إشعارٌ بتاريخٍ قبل فاتورته، وإشعارٌ في الربع المقدَّم، وإشعارٌ بلا سبب أو بلا مبلغ
  await expect(issueCreditNote(A, src, id, { date: '2026-02-01', subtotalHalalas: 1000, reason: 'تصحيح مصطنع' })).rejects.toThrow();
  await expect(issueCreditNote(A, src, id, { date: '2026-03-01', subtotalHalalas: 1000, reason: 'تصحيح مصطنع' })).rejects.toThrow();
  await expect(issueCreditNote(A, src, id, { date: '2026-04-14', subtotalHalalas: 1000, reason: ' ' })).rejects.toThrow();
  await expect(issueCreditNote(A, src, id, { date: '2026-04-14', subtotalHalalas: 0, reason: 'تصحيح مصطنع' })).rejects.toThrow();
  // ومسودةٌ في الربع المقدَّم لا تصدر
  const draft = saveInvoice(A, inv('2026-03-21'), 'مسودة');
  await expect(setInvoiceStatusIssued(A, src, draft, 'مستحقة')).rejects.toThrow();
  expect(reserved(A)).toBeNull();
  // العدّاد لم يتقدم: الجهاز الثاني يأخذ الثاني
  await saveInvoiceIssued(B, src, inv('2026-04-15'), 'مستحقة');
  expect(nos(B)).toEqual(['INV-2026-0002']);
  A.close(); B.close();
});
