/**
 * المراجعة ١٢ · إصلاح مراجعة R12-BAK-3 · بيانات مصطنعة والأرقام بالهللة محسوبة باليد · المحفظة = 1100 − أرصدة البنوك.
 *
 * ١) الجهاز وحده مصدرٌ (بلا حساب): إيداعٌ حيّ في النسخة حُذف بعدها نهائياً فلا صفّ له على الجهاز ولا شاهد حذف · لا يُعرف أحُذف أم لم يكن
 *    على هذا الجهاز قط، فيعود كما في النسخة ولا يُحذف بالظن، لكنه يُعدّ ويُذكر في الحوار (keptRevivedMoves) فلا يعود بصمت.
 * ٢) اعتماد نسخةٍ استُعيدت قبل الدخول (planAdoptPending): النسخة على الجهاز تنتظر الاعتماد، فرسالة النقص تقول إنها لم تُعتمد ولم يُرفع
 *    منها شيء، لا «لم تُستعد النسخة وبياناتك كما هي».
 */
import * as path from 'node:path';
import { tempDir, rmrf, memDb } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addBank } from './helpers/fixtures';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { planKeepPosted, keepShortages } from '@/domain/backup/keepPosted';
import { ownerCashIn, depositCashToBank, pettyCashExpense } from '@/domain/cashOps';
import { deleteBankTx } from '@/domain/bankTx';
import { purgeFromTrash } from '@/domain/trash';
import { bankBalance, walletCashBalance } from '@/domain/accounting/ledger';
import { buildDoc } from '@/sync/engine';
import { openNodeDb } from '@/db/nodeAdapter';
import { fmt } from '@/domain/money';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

test('١) إيداعٌ حيّ في النسخة حُذف بعدها نهائياً على جهازٍ بلا حساب: يعود كما في النسخة ويُذكر في الحوار بعدده', async () => {
  const d = tempDir('aq-r12-revived-'); dirs.push(d);
  const env = makeBackupEnv(d);
  const bank = addBank(env.db, 'بنك عودةٍ مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(env.db, { bankId: bank, amountHalalas: 100_000, date: '2026-03-01' }); // البنك ١٠٠٬٠٠٠ والمحفظة ٠
  const archive = path.join(d, 'b.aqbk');
  await createBackup(env, archive);
  const dep = env.db.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ?`, [bank])!.id;
  deleteBankTx(env.db, dep);
  purgeFromTrash(env.db, 'bank_tx', dep); // البنك ٠ والمحفظة ١٠٠٬٠٠٠
  ownerCashIn(env.db, { amountHalalas: 50_000, date: '2026-03-05' }); // المحفظة ١٥٠٬٠٠٠
  expect([bankBalance(env.db, bank), walletCashBalance(env.db)]).toEqual([0, 150_000]);

  const plan = await prepareRestore(env, archive);
  expect(plan.keptRevivedMoves).toBe(1); // الإيداع وحده
  const db = (await commitRestore(env, plan)).db;
  // كما في النسخة: البنك ١٠٠٬٠٠٠ · المحفظة ١٠٠٬٠٠٠ + ٥٠٬٠٠٠ − ١٠٠٬٠٠٠ = ٥٠٬٠٠٠
  expect([bankBalance(db, bank), walletCashBalance(db)]).toEqual([100_000, 50_000]);
  env.closeLive();
});

test('٢) نقص المحفظة في اعتماد نسخةٍ مستعادة: الرسالة تقول لم تُعتمد ولم يُرفع منها شيء، لا لم تُستعد', () => {
  const d = tempDir('aq-r12-adopt-short-'); dirs.push(d);
  const a = memDb();
  const bank = addBank(a, 'بنك اعتمادٍ مصطنع', 0);
  ownerCashIn(a, { amountHalalas: 100_000, date: '2026-03-01' }); // المحفظة ١٠٠٬٠٠٠
  const backupFile = path.join(d, 'restored.db').replace(/\\/g, '/');
  a.exec(`VACUUM INTO '${backupFile}'`);
  pettyCashExpense(a, { amountHalalas: 100_000, descr: 'مصروف مصطنع', date: '2026-03-03' }); // رُفع إلى السحابة من جهازٍ آخر
  const petty = a.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'cash_op' ORDER BY no DESC LIMIT 1`)!.id;
  const snapshot = [buildDoc(a, 'journal_entries', petty, 'upsert', new Date().toISOString(), 'DEV-OTHER')];
  a.close();

  // النسخة المستعادة على هذا الجهاز ثم أُودع نقدها في البنك: المحفظة ٠
  const restored = openNodeDb(backupFile);
  depositCashToBank(restored, { bankId: bank, amountHalalas: 100_000, date: '2026-03-02' });
  expect(walletCashBalance(restored)).toBe(0);
  const keep = planKeepPosted(restored, { cloud: snapshot });
  expect(keep.entries.map((e) => e.id)).toEqual([petty]);
  // المحفظة بعد الضمّ ٠ − ١٠٠٬٠٠٠ = −١٠٠٬٠٠٠، ينقصها ١٠٠٬٠٠٠
  const msg = keepShortages(restored, keep, 'adopt').join(' · ');
  expect(msg).toContain('المحفظة');
  expect(msg).toContain(fmt(100_000));
  expect(msg).toContain('لم تُعتمد');
  expect(msg).not.toContain('لم تُستعد');
  // ومسار الاستعادة نفسه بالرسالة الأولى
  expect(keepShortages(restored, keep).join(' · ')).toContain('لم تُستعد');
  restored.close();
});
