/**
 * التصميم ٤: القيد المرحّل لا يُحذف بالاستعادة · ما رُحّل بعد النسخة يُضمّ إليها برقمه ومستنده ما أمكن،
 * ويُعرض قبل التأكيد، وما لم يُحمل مستنده يظهر في المراجعة · بيانات مصطنعة.
 */
import * as path from 'node:path';
import { tempDir, rmrf, memDb } from './helpers/testDb';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { MemoryRemote } from './helpers/memoryRemote';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { postEntry, reverseEntryById } from '@/domain/accounting/post';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore, abortRestore } from '@/domain/backup/restore';
import { planKeepPosted } from '@/domain/backup/keepPosted';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { keptForReview, dismissKeptReview } from '@/domain/accounting/orphans';
import { semanticIssues } from '@/domain/backup/semantic';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { setDeviceLetter, deviceLetter } from '@/domain/numbering';
import { enableSync, syncOnce, readCloud, planFromSnapshot, adoptAsCloudTruth } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-keep-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });

const healthy = (db: DB) => {
  expect(semanticIssues(db)).toEqual([]);
  for (const c of integrityChecks(db)) expect(`${c.name}: ${c.ok}`).toBe(`${c.name}: true`);
};
const manual = (db: DB, amount: number, date = '2026-03-01') => postEntry(db, {
  date, memo: 'قيد يدوي', lines: [{ account: '1100', debit: amount, credit: 0 }, { account: '3100', debit: 0, credit: amount }] })!;
const paidOf = (db: DB, id: string) => Number(db.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = ?`, [id])!.p);

function contract(db: DB) {
  const u = addUnit(db, addProperty(db), { rent: 100000 });
  const cid = confirmContract(db, contractInput(u, { valueHalalas: 1200000, depositHalalas: 0 }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  return { cid, insts };
}
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}

test('قيد يدوي ودفعة بعد النسخة يبقيان برقميهما · والدفعة تُحمل بتوزيعها وحركة بنكها فلا يفارق المسدَّد الدفتر', async () => {
  const env = newEnv();
  const k = contract(env.db);
  const bank = addBank(env.db);
  const archive = await backup(env);
  const m = manual(env.db, 7000);
  const pay = recordRentPayment(env.db, k.cid, { installmentId: k.insts[0], period: 'م', date: '2026-03-02', notes: '', discountHalalas: 0,
    lines: [{ method: 'bank', bankId: bank, amountHalalas: 100000 }] });
  const payEntry = env.db.get<{ e: string; no: string }>(
    `SELECT e.id AS e, e.no FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id WHERE p.id = ?`, [pay])!;

  const plan = await prepareRestore(env, archive);
  expect(plan.kept.map((x) => x.no).sort()).toEqual([m.no, payEntry.no].sort());
  expect(plan.kept.every((x) => x.from === 'device' && x.newNo === null && x.review === null)).toBe(true);
  expect(plan.kept.find((x) => x.id === payEntry.e)!.carried).toEqual(expect.arrayContaining(['الدفعة', 'حركة البنك']));
  const res = await commitRestore(env, plan);
  const db = res.db;
  expect(db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ?`, [m.id])!.no).toBe(m.no);
  expect(paidOf(db, k.insts[0])).toBe(100000);
  expect(Number(db.get<{ s: number }>(`SELECT SUM(amount_halalas) AS s FROM bank_tx WHERE bank_id = ?`, [bank])!.s)).toBe(100000);
  expect(keptForReview(db)).toEqual([]);
  healthy(db);
  env.closeLive();
});

test('الإلغاء يترك البيانات كما هي · لا شيء من الضمّ يمسّ القاعدة الحية قبل التأكيد', async () => {
  const env = newEnv();
  const archive = await backup(env);
  manual(env.db, 5000);
  const before = env.db.all(`SELECT id, no, reversed_by FROM journal_entries ORDER BY id`);
  const plan = await prepareRestore(env, archive);
  expect(plan.kept).toHaveLength(1);
  abortRestore(env, plan.stagingDir);
  expect(env.db.all(`SELECT id, no, reversed_by FROM journal_entries ORDER BY id`)).toEqual(before);
  env.closeLive();
});

test('إلغاء دفعة بعد النسخة: قيده العكسي يبقى ويُربط بأصله، والدفعة تُحمل ملغاةً، والبنك بحركته السالبة', async () => {
  const env = newEnv();
  const k = contract(env.db);
  const bank = addBank(env.db);
  const pay = recordRentPayment(env.db, k.cid, { installmentId: k.insts[0], period: 'م', date: '2026-03-02', notes: '', discountHalalas: 0,
    lines: [{ method: 'bank', bankId: bank, amountHalalas: 100000 }] });
  const archive = await backup(env);
  cancelPayment(env.db, pay, { date: '2026-03-10', reason: 'سُجّلت خطأً' });

  const plan = await prepareRestore(env, archive);
  expect(plan.kept).toHaveLength(1);
  expect(plan.kept[0].carried).toEqual(expect.arrayContaining(['الدفعة', 'ربطه بأصله', 'حركة البنك']));
  const db = (await commitRestore(env, plan)).db;
  expect(db.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [pay])!.c).toBe('2026-03-10');
  expect(paidOf(db, k.insts[0])).toBe(0);
  expect(Number(db.get<{ s: number }>(`SELECT SUM(amount_halalas) AS s FROM bank_tx WHERE bank_id = ?`, [bank])!.s)).toBe(0);
  const orig = db.get<{ rb: string | null }>(`SELECT e.reversed_by AS rb FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id WHERE p.id = ?`, [pay])!;
  expect(orig.rb).toBe(plan.kept[0].id);
  healthy(db);
  env.closeLive();
});

test('دفعة عقدها ليس في النسخة: قيدها يبقى ويُدرج في المراجعة · و«تمّت مراجعته» يخرجه', async () => {
  const env = newEnv();
  const archive = await backup(env);
  const k = contract(env.db);
  recordRentPayment(env.db, k.cid, { installmentId: k.insts[0], period: 'م', date: '2026-03-02', notes: '', discountHalalas: 0,
    lines: [{ method: 'cash', amountHalalas: 100000 }] });
  const plan = await prepareRestore(env, archive);
  const rent = plan.kept.filter((x) => x.review);
  expect(rent).toHaveLength(1);
  expect(rent[0].review).toContain('عقدها ليس في النسخة');
  const db = (await commitRestore(env, plan)).db;
  expect(db.get(`SELECT 1 FROM contracts WHERE id = ?`, [k.cid])).toBeUndefined();
  expect(accountBalance(db, '1100')).toBe(100000); // النقد في الدفتر كما قُبض
  expect(keptForReview(db).map((x) => x.reason)).toEqual([rent[0].review]);
  dismissKeptReview(db, rent[0].id);
  expect(keptForReview(db)).toEqual([]);
  healthy(db);
  env.closeLive();
});

test('قيد وعكسه بعد النسخة يبقيان معاً بلا مراجعة · أثرهما صفر', async () => {
  const env = newEnv();
  const archive = await backup(env);
  const e = manual(env.db, 9000);
  reverseEntryById(env.db, e.id, undefined, '2026-03-05');
  const plan = await prepareRestore(env, archive);
  expect(plan.kept).toHaveLength(2);
  expect(plan.kept.every((x) => !x.review)).toBe(true);
  const db = (await commitRestore(env, plan)).db;
  expect(db.get<{ rb: string | null }>(`SELECT reversed_by AS rb FROM journal_entries WHERE id = ?`, [e.id])!.rb).toBeTruthy();
  expect(accountBalance(db, '1100')).toBe(0);
  healthy(db);
  env.closeLive();
});

test('رقمٌ مستعمل في النسخة لقيد آخر: القيد المضموم يأخذ رقماً جديداً ويُذكر القديم في بيانه', async () => {
  // جهاز جديد بدأ بقيدٍ ثم استعاد نسخة جهازه القديم · كلاهما JE-0001
  const old = newEnv();
  manual(old.db, 1000, '2026-01-01');
  const archive = await backup(old);
  old.closeLive();
  const fresh = newEnv();
  const mine = manual(fresh.db, 2500, '2026-03-01');
  expect(mine.no).toBe('JE-0001');
  const plan = await prepareRestore(fresh, archive);
  expect(plan.kept).toEqual([expect.objectContaining({ no: 'JE-0001', newNo: 'JE-0002' })]);
  const db = (await commitRestore(fresh, plan)).db;
  const row = db.get<{ no: string; memo: string }>(`SELECT no, memo FROM journal_entries WHERE id = ?`, [mine.id])!;
  expect(row.no).toBe('JE-0002');
  expect(row.memo).toContain('JE-0001');
  healthy(db);
  fresh.closeLive();
});

test('حرف الجهاز في الترقيم يبقى للجهاز لا للنسخة', async () => {
  const env = newEnv();
  const archive = await backup(env); // نسخة بلا حرف
  setDeviceLetter(env.db, 'C');
  const plan = await prepareRestore(env, archive);
  const db = (await commitRestore(env, plan)).db;
  expect(deviceLetter(db)).toBe('C');
  env.closeLive();
});

test('قيود في السحابة من جهاز آخر وليست في النسخة تُضمّ قبل الاعتماد · فلا يمنعه شيء ولا يُحذف قيد', async () => {
  const r = new MemoryRemote();
  const env = newEnv();
  enableSync(env.db, 'U');
  const k = contract(env.db);
  await syncOnce(env.db, r, getMeta(env.db, 'device_id')!);
  const archive = await backup(env);
  // جهاز آخر يقبض دفعة ويرحّل قيداً بعد النسخة
  const other = memDb();
  enableSync(other, 'U');
  await syncOnce(other, r, getMeta(other, 'device_id')!);
  recordRentPayment(other, k.cid, { installmentId: k.insts[1], period: 'م', date: '2026-03-02', notes: '', discountHalalas: 0,
    lines: [{ method: 'cash', amountHalalas: 100000 }] });
  manual(other, 3000);
  await syncOnce(other, r, getMeta(other, 'device_id')!);

  const snap = await readCloud(r);
  const plan = await prepareRestore(env, archive, undefined, { cloud: async () => snap.docs });
  expect(plan.kept).toHaveLength(2);
  expect(plan.kept.every((x) => x.from === 'cloud' && !x.review)).toBe(true);
  const db = (await commitRestore(env, plan)).db;
  const cloudPlan = planFromSnapshot(db, snap);
  expect(cloudPlan.immutable.entries).toBe(0);
  expect(cloudPlan.tombstones.filter((t) => t.t === 'contract_payments')).toEqual([]);
  adoptAsCloudTruth(db, 'U', cloudPlan);
  await syncOnce(db, r, getMeta(db, 'device_id')!);
  await syncOnce(other, r, getMeta(other, 'device_id')!);
  expect(paidOf(db, k.insts[1])).toBe(100000);
  expect(paidOf(other, k.insts[1])).toBe(100000);
  expect(other.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n)
    .toBe(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n);
  healthy(db);
  healthy(other);
  env.closeLive();
  other.close();
});

test('لا شيء بعد النسخة: لا ضمّ', async () => {
  const env = newEnv();
  manual(env.db, 1000);
  const archive = await backup(env);
  const plan = await prepareRestore(env, archive);
  expect(plan.kept).toEqual([]);
  abortRestore(env, plan.stagingDir);
  expect(planKeepPosted(env.db, { device: env.db }).entries).toEqual([]);
  env.closeLive();
});

test('قيد تأمين عقدٍ ليس في النسخة: يبقى معلَّماً، وفحوص الدفتر لا تمنع النسخ، ويُعكس من مصدره الغائب', async () => {
  const env = newEnv();
  const archive = await backup(env);
  const u = addUnit(env.db, addProperty(env.db), { rent: 100000 });
  confirmContract(env.db, contractInput(u, { valueHalalas: 1200000, depositHalalas: 210000 }));
  const plan = await prepareRestore(env, archive);
  expect(plan.kept.map((x) => x.review)).toEqual([expect.stringContaining('مستنده ليس في النسخة')]);
  const db = (await commitRestore(env, plan)).db;
  healthy(db);
  await backup(env); // لا يمنعه فحص التأمينات
  const [item] = keptForReview(db);
  const a = entrySourceAction(db, item.id);
  if (a?.kind !== 'op') throw new Error('op');
  expect(a.label).toBe('عكس القيد');
  a.run('2026-04-01', 'لا عقد له');
  expect(keptForReview(db)).toEqual([]);
  expect(accountBalance(db, '2400')).toBe(0);
  healthy(db);
  env.closeLive();
});

test('دفعة على جهاز آخر لعقدٍ حذفته الاستعادة قبل أن تُرفع: الحذف يغلب على الدفعة، وقيدها يبقى معلَّماً على الجهازين ويتطابقان', async () => {
  const r = new MemoryRemote();
  const env = newEnv();
  enableSync(env.db, 'U');
  const archive = await backup(env); // قبل العقد
  const k = contract(env.db);
  await syncOnce(env.db, r, getMeta(env.db, 'device_id')!);
  const other = memDb();
  enableSync(other, 'U');
  await syncOnce(other, r, getMeta(other, 'device_id')!);
  // الجهاز الآخر يقبض ولا يرفع بعد
  recordRentPayment(other, k.cid, { installmentId: k.insts[0], period: 'م', date: '2026-03-02', notes: '', discountHalalas: 0,
    lines: [{ method: 'cash', amountHalalas: 100000 }] });

  const snap = await readCloud(r);
  const plan = await prepareRestore(env, archive, undefined, { cloud: async () => snap.docs });
  const db = (await commitRestore(env, plan)).db;
  adoptAsCloudTruth(db, 'U', planFromSnapshot(db, snap));
  for (let i = 0; i < 3; i++) {
    await syncOnce(db, r, getMeta(db, 'device_id')!);
    await syncOnce(other, r, getMeta(other, 'device_id')!);
  }
  for (const x of [db, other]) {
    expect(x.get(`SELECT 1 FROM contracts WHERE id = ?`, [k.cid])).toBeUndefined();
    expect(Number(x.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments`)!.n)).toBe(0);
    expect(accountBalance(x, '1100')).toBe(100000); // القبض في الدفتر لم يضع
    expect(keptForReview(x).map((i) => i.reason)).toEqual([expect.stringContaining('مستنده ليس في البيانات')]);
    expect(Number(x.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects`)!.n)).toBe(0);
    healthy(x);
  }
  env.closeLive();
  other.close();
});
