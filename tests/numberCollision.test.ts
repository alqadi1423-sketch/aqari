/**
 * المراجعة الخارجية ٧ · النتيجة ٥ (قرار المالك «رابعاً ٣»: «إعادة الترقيم عند تعارض الرقم»): جهازان رقّما قبل الدخول ·
 * قائمة القبول: «posted A/B: 2 2، نقد متساوٍ، rejected 0» · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { postManualEntry } from '@/domain/accounting/post';
import { savePurchase, type PurchaseInput } from '@/domain/purchases';
import { accountBalance } from '@/domain/accounting/ledger';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'owner-5';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const posted = (db: DB) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE status = 'مرحّل'`)!.n);
const purchase = (amount: number): PurchaseInput => ({
  supplier: 'مورد مصطنع', date: '2026-03-15', due: '2026-04-15', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: true, subtotalHalalas: amount, taxHalalas: 0, totalHalalas: amount,
});

test('٥ جهازان رحّلا JE-0001 قبل الدخول: بعد الانضمام القيدان على كلٍّ منهما ونقدٌ متساوٍ ولا رفض', async () => {
  const r = new MemoryRemote();
  const a = memDb(); const b = memDb();
  const ea = postManualEntry(a, { date: '2026-01-01', memo: 'م', lines: [{ account: '1100', debit: 100000, credit: 0 }, { account: '3100', debit: 0, credit: 100000 }] })!;
  const eb = postManualEntry(b, { date: '2026-01-01', memo: 'م', lines: [{ account: '1100', debit: 200000, credit: 0 }, { account: '3100', debit: 0, credit: 200000 }] })!;
  expect(ea.no).toBe(eb.no);
  enableSync(a, UID); enableSync(b, UID);
  await sync(a, r); await sync(b, r); await sync(a, r); await sync(b, r);
  for (const db of [a, b]) {
    expect(posted(db)).toBe(2);
    expect(accountBalance(db, '1100')).toBe(300000);
    expect(db.all(`SELECT reason FROM sync_rejects`)).toEqual([]);
  }
  const nos = (db: DB) => db.all<{ id: string; no: string }>(`SELECT id, no FROM journal_entries ORDER BY id`);
  expect(nos(a)).toEqual(nos(b));
  a.close(); b.close();
});

test('٥ وفاتورتا شراءٍ برقمٍ واحد قبل الدخول كذلك', async () => {
  const r = new MemoryRemote();
  const a = memDb(); const b = memDb();
  const pa = savePurchase(a, purchase(10000));
  const pb = savePurchase(b, purchase(20000));
  const no = (db: DB, id: string) => db.get<{ no: string }>(`SELECT no FROM purchases WHERE id = ?`, [id])!.no;
  expect(no(a, pa)).toBe(no(b, pb));
  enableSync(a, UID); enableSync(b, UID);
  await sync(a, r); await sync(b, r); await sync(a, r); await sync(b, r);
  for (const db of [a, b]) {
    expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM purchases`)!.n)).toBe(2);
    expect(db.all(`SELECT reason FROM sync_rejects`)).toEqual([]);
  }
  expect(no(a, pa)).toBe(no(b, pa));
  expect(no(a, pb)).toBe(no(b, pb));
  a.close(); b.close();
});
