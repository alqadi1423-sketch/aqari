/**
 * المراجعة الخارجية ٧ · النتيجة ٣ (قرار المالك «رابعاً ٣» 2026-10-10: «تفرّد (المصدر ومعرّفه)، وفحص «مرآة واحدة لكل أصل»»):
 * جهازان يلغيان الدفعة نفسها بلا اتصال فيُرحَّل عاكسان لأصلٍ واحد · فلا يبقى على كل جهازٍ إلا عاكسٌ واحد (فحص العاكس الوارد
 * واحداً لواحد · sync/engine.ts) والنقد كما كان قبل الدفعة · وفحص المطابقة «مرآة واحدة لكل أصل» يحمرّ إن حُقن عاكسٌ ثانٍ ·
 * وقائمة القبول: «rent_rev حي واحد على الجهازين و1100 = 0؛ فحص مرآة لكل أصل أحمر عند حقن ثانية» · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'owner-3';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const MIRROR_CHECK = 'مرآة واحدة لكل أصل';
/** مصدر قيد الدفعة (معرّف مصدره ليس معرّف الدفعة) */
const srcOf = (db: DB, pay: string) => db.get<{ s: string }>(
  `SELECT e.src_id AS s FROM journal_entries e JOIN contract_payments p ON p.journal_entry_id = e.id WHERE p.id = ?`, [pay])!.s;
const liveRevs = (db: DB, src: string) => Number(db.get<{ n: number }>(
  `SELECT COUNT(*) AS n FROM journal_entries WHERE src_type = 'rent_rev' AND src_id = ? AND status = 'مرحّل'`, [src])!.n);

test('٣ جهازان يلغيان الدفعة نفسها بلا اتصال: عاكسٌ واحد على كلٍّ منهما · والنقد كما قبل الدفعة · والمطابقة سليمة', async () => {
  const r = new MemoryRemote();
  const a = memDb(); const b = memDb();
  enableSync(a, UID); enableSync(b, UID);
  const cid = confirmContract(a, contractInput(addUnit(a, addProperty(a, { name: 'عقار مصطنع' })),
    { tenant: 'مستأجر مصطنع', idNumber: '1000000301', phone: '0500000301', start: '2026-01-01', depositHalalas: 0 }));
  const cashBefore = accountBalance(a, '1100');
  const inst = a.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  const pay = recordRentPayment(a, cid, { installmentId: inst, period: 'الأولى', date: '2026-01-05', lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  await sync(a, r); await sync(b, r);
  const src = srcOf(a, pay);
  // بلا اتصال: كلٌّ يلغيها
  cancelPayment(a, pay, { date: '2026-01-06', reason: 'إلغاء مصطنع' });
  cancelPayment(b, pay, { date: '2026-01-06', reason: 'إلغاء مصطنع' });
  await sync(a, r); await sync(b, r); await sync(a, r); await sync(b, r);
  for (const db of [a, b]) {
    expect(liveRevs(db, src)).toBe(1);
    expect(accountBalance(db, '1100')).toBe(cashBefore);
    expect(integrityChecks(db).filter((c) => !c.ok)).toEqual([]);
  }
  a.close(); b.close();
});

test('٣ فحص «مرآة واحدة لكل أصل» يحمرّ بعاكسٍ ثانٍ محقون · ودفعةٌ حية قيدها معكوس لا تُعدّ «لها قيد»', () => {
  const db = memDb();
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار مصطنع' })),
    { tenant: 'مستأجر مصطنع', idNumber: '1000000302', phone: '0500000302', start: '2026-01-01', depositHalalas: 0 }));
  const inst = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  const pay = recordRentPayment(db, cid, { installmentId: inst, period: 'الأولى', date: '2026-01-05', lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  const check = (name: string) => integrityChecks(db).find((c) => c.name === name)!;
  expect(check(MIRROR_CHECK).ok).toBe(true);
  const e = db.get<{ id: string }>(`SELECT journal_entry_id AS id FROM contract_payments WHERE id = ?`, [pay])!.id;
  // عاكسٌ مرحّل حقيقي بلا إلغاء الدفعة (كما يصل من جهازٍ آخر): الدفعة حيةٌ وقيدها معكوس
  const lines = db.all<{ account_code: string; debit_halalas: number; credit_halalas: number }>(`SELECT account_code, debit_halalas, credit_halalas FROM journal_lines WHERE entry_id = ?`, [e]);
  const inject = (k: string) => {
    db.run(`INSERT INTO journal_entries (id, no, date, memo, status, auto, src_type, src_id, created_at) VALUES (?,?,?,?,'قيد الإنشاء',1,'rent_rev',?,'x')`, [k, 'JE-' + k, '2026-01-07', 'م', srcOf(db, pay)]);
    for (const [i, l] of lines.entries()) db.run(`INSERT INTO journal_lines (id, entry_id, account_code, descr, debit_halalas, credit_halalas) VALUES (?,?,?,?,?,?)`,
      [k + i, k, l.account_code, '', l.credit_halalas, l.debit_halalas]);
    db.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = ?`, [k]);
  };
  inject('X1');
  db.run(`UPDATE journal_entries SET reversed_by = 'X1' WHERE id = ?`, [e]);
  expect(check('كل دفعة محصَّلة لها قيد مرحّل').ok).toBe(false);
  expect(check(MIRROR_CHECK).ok).toBe(true);
  inject('X2');
  expect(check(MIRROR_CHECK).ok).toBe(false);
  db.close();
});
