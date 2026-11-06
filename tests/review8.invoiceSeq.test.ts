/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ١٢: الرقم المحجوز كان يُفرَّغ خارج معاملة استعماله، فإغلاق التطبيق بين حفظ الفاتورة
 * وتفريغه يترك رقماً مستعملاً محجوزاً: تفشل كل فاتورة بعده على الجهاز، أو يتكرر رقمها في سنة جديدة · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { saveInvoiceIssued, issueCreditNote, INV_RESERVED_KEY } from '@/domain/invoiceIssue';
import type { InvoiceInput } from '@/domain/invoices';

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
  // وحفظٌ فشل لا يفرّغ المحجوز: تأخذه الفاتورة التالية فلا فجوة
  const bad = { ...inv('2026-02-13'), lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100, taxPct: 0, taxCode: 'S' as const }] };
  await expect(saveInvoiceIssued(db, src, bad, 'مستحقة')).rejects.toThrow();
  expect(reserved(db)).toBe('3');
  await saveInvoiceIssued(db, src, inv('2026-02-14'), 'مستحقة');
  expect(nos(db)).toContain('INV-2026-0003');
  expect(reserved(db)).toBeNull();
  db.close();
});
