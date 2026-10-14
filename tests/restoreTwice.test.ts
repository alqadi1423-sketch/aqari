/**
 * المراجعة الخارجية ٧ · النتيجة ٤: الاستعادة من السلة ليست متساوية الأثر · فاتورة الشراء والمبيعات يُرحَّلان مرتين ·
 * وقائمة القبول: «live purchase entries A/B: 1 1؛ restoreInvoice على فاتورة حية يرمي» · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { savePurchase, deletePurchase, type PurchaseInput } from '@/domain/purchases';
import { saveInvoice, restoreInvoice } from '@/domain/invoices';
import { restoreFromTrash } from '@/domain/trash';
import { postEntry, reverseEntryById } from '@/domain/accounting/post';
import { integrityChecks } from '@/domain/accounting/integrity';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'owner-4';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const live = (db: DB, src: string, id: string) => Number(db.get<{ n: number }>(
  `SELECT COUNT(*) AS n FROM journal_entries WHERE src_type = ? AND src_id = ? AND status = 'مرحّل' AND reversed_by IS NULL AND deleted_at IS NULL`, [src, id])!.n);
const purchase = (): PurchaseInput => ({
  supplier: 'مورد مصطنع', date: '2026-03-15', due: '2026-04-15', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: true, subtotalHalalas: 100000, taxHalalas: 0, totalHalalas: 100000,
});
const invoice = () => ({ customer: 'عميل مصطنع', customerVat: '', issue: '2026-03-15', due: '2026-04-15', notes: '',
  lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 50000, taxPct: 0 }] });

async function twoDevices(create: (db: DB) => string, del: (db: DB, id: string) => void, table: string, src: string) {
  const r = new MemoryRemote();
  const a = memDb(); const b = memDb();
  enableSync(a, UID); enableSync(b, UID);
  const id = create(a);
  await sync(a, r); await sync(b, r);
  del(a, id);
  await sync(a, r); await sync(b, r);
  // بلا اتصال: كلٌّ يستعيدها
  restoreFromTrash(a, table, id);
  restoreFromTrash(b, table, id);
  await sync(a, r); await sync(b, r); await sync(a, r); await sync(b, r);
  for (const db of [a, b]) {
    expect(live(db, src, id)).toBe(1);
    expect(integrityChecks(db).filter((c) => !c.ok)).toEqual([]);
  }
  a.close(); b.close();
}

test('٤ (أ) فاتورة شراء تُستعاد على جهازين بلا اتصال: قيدٌ حي واحد على كلٍّ منهما', () =>
  twoDevices((db) => savePurchase(db, purchase()), deletePurchase, 'purchases', 'purchase'));

/** الصادرة لا تُحذف الآن (قرار المالك على #30) · وفي السلة ما حذفه إصدارٌ أقدم: قيدها معكوس وهي محذوفة */
const oldDelete = (db: DB, id: string) => {
  const e = db.get<{ e: string }>(`SELECT journal_entry_id AS e FROM invoices WHERE id = ?`, [id])!.e;
  reverseEntryById(db, e, 'حذف بإصدارٍ أقدم');
  db.run(`UPDATE invoices SET deleted_at = '2026-03-20T00:00:00.000Z' WHERE id = ?`, [id]);
};
test('٤ (أ) وفاتورة مبيعات صادرة في السلة من إصدارٍ أقدم كذلك', () =>
  twoDevices((db) => saveInvoice(db, invoice(), 'مستحقة'), oldDelete, 'invoices', 'invoice'));

test('٤ (ب) استعادة فاتورةٍ حية ترمي ولا تُرحَّل ثانيةً · وكذلك الشراء والسلة', () => {
  const db = memDb();
  const inv = saveInvoice(db, invoice(), 'مستحقة');
  expect(() => restoreInvoice(db, inv)).toThrow();
  expect(live(db, 'invoice', inv)).toBe(1);
  const pid = savePurchase(db, purchase());
  expect(() => restoreFromTrash(db, 'purchases', pid)).toThrow();
  expect(() => restoreFromTrash(db, 'suppliers', db.get<{ id: string }>(`SELECT id FROM suppliers LIMIT 1`)!.id)).toThrow();
  db.close();
});

test('مرآة واحدة لكل أصل بالربط: مرآةٌ ثانية لأصلٍ معكوس ومعها أصلٌ حي تُحمِّر الفحص (العدّ وحده لا يراها)', () => {
  const db = memDb();
  const lines = [{ account: '1200', debit: 50000, credit: 0 }, { account: '4200', debit: 0, credit: 50000 }];
  const o1 = postEntry(db, { date: '2026-01-01', memo: 'م', srcType: 'invoice', srcId: 'INV-Y', lines })!;
  reverseEntryById(db, o1.id);
  postEntry(db, { date: '2026-01-02', memo: 'م', srcType: 'invoice', srcId: 'INV-Y', lines });
  const check = () => integrityChecks(db).find((c) => c.name === 'مرآة واحدة لكل أصل')!;
  expect(check().ok).toBe(true);
  postEntry(db, { date: '2026-01-03', memo: 'مرآة ثانية', srcType: 'invoice_rev', srcId: 'INV-Y',
    lines: [{ account: '1200', debit: 0, credit: 50000 }, { account: '4200', debit: 50000, credit: 0 }] });
  expect(check().ok).toBe(false);
  db.close();
});
