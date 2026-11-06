/**
 * المراجعة الشاملة (المتحقق المستقل · عيبٌ خارج البنود وُجد ببذور الاختبار العشوائي ٥٧٢ و٧٠١ و٧٧٦): تحصيلٌ جماعي بفائضٍ صار رصيداً
 * دائناً للمستأجر بعد النسخة، ثم «استعادة واعتمادها» تضمّ قيده المرحّل · ورصيد المستأجر الدائن رقمٌ على صفّه لا يُحمل (keepPosted.ts)،
 * فيُعلَّم القيد للمراجعة · وكان فحص «الرصيد الدائن للمستأجرين يطابق حسابه 2410» يقيس 2410 بالقيد المعلَّم كله، خلاف فحصَي 2400 و1250
 * اللذين يُخرجان القيد المعلَّم (markedNetOn)، فيبقى أحمر بعد كل استعادةٍ كهذه · ولا يُخرج إلا ما ضمّته الاستعادة: ما وصل بالمزامنة
 * ومستنده محذوف بقي رصيد مستأجره على صفّه (البذرة ١٣٩) · بيانات مصطنعة.
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, recordBulkRentPayment } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { keptForReview, dismissKeptReview, markOrphans } from '@/domain/accounting/orphans';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { semanticIssues } from '@/domain/backup/semantic';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-keptcredit-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });

const CHECK = 'الرصيد الدائن للمستأجرين يطابق حسابه 2410';
const healthy = (db: DB) => {
  expect(semanticIssues(db)).toEqual([]);
  for (const c of integrityChecks(db)) expect(`${c.name}: ${c.ok} (${c.value})`).toBe(`${c.name}: true (${c.value})`);
};
const creditSum = (db: DB) => Number(db.get<{ s: number }>(`SELECT COALESCE(SUM(credit_halalas), 0) AS s FROM tenants WHERE deleted_at IS NULL`)!.s);

function contract(db: DB) {
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { rent: 100000 });
  const cid = confirmContract(db, contractInput(u, { valueHalalas: 1200000, depositHalalas: 0, tenant: 'مستأجر مصطنع', idNumber: '1000000081', phone: '0500000081' }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  return { cid, insts };
}
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}
/** تحصيلٌ جماعي على قسطين بفائض ٢٠٠٫٠٠ يصير رصيداً دائناً للمستأجر */
const overpay = (db: DB, k: { cid: string; insts: string[] }) => recordBulkRentPayment(db, k.cid, {
  installmentIds: k.insts.slice(0, 2), date: '2026-03-02', notes: '', lines: [{ method: 'cash', amountHalalas: 220000 }] });

test('عيبٌ جديد (المتحقق المستقل) عقدٌ وتحصيلٌ بفائضٍ بعد النسخة ثم الاستعادة: قيده يبقى معلَّماً · وفحص 2410 لا يقيسه برصيد المستأجرين', async () => {
  const env = newEnv();
  const archive = await backup(env);
  const k = contract(env.db);
  overpay(env.db, k);
  expect(accountBalance(env.db, '2410')).toBe(20000);
  const plan = await prepareRestore(env, archive);
  expect(plan.kept.filter((x) => x.review).map((x) => x.review)).toEqual([expect.stringContaining('عقدها ليس في النسخة')]);
  const db = (await commitRestore(env, plan)).db;
  // الفائض في الدفتر كما قُبض · والمستأجر ليس في النسخة
  expect(accountBalance(db, '2410')).toBe(20000);
  expect(creditSum(db)).toBe(0);
  healthy(db);
  // و«تمّت مراجعته» يبقيه خارج المطابقة لأن مستنده غائب
  dismissKeptReview(db, keptForReview(db)[0].id);
  healthy(db);
  env.closeLive();
});

test('عيبٌ جديد (المتحقق المستقل) والعقد في النسخة والتحصيل بفائضٍ بعدها: الدفعة تُحمل والرصيد لا يُحمل فيُعلَّم · وفحص 2410 يُخرجه ويذكره', async () => {
  const env = newEnv();
  const k = contract(env.db);
  const archive = await backup(env);
  overpay(env.db, k);
  const plan = await prepareRestore(env, archive);
  const kept = plan.kept.filter((x) => x.review);
  expect(kept.map((x) => x.review)).toEqual([expect.stringContaining('رصيد المستأجر الدائن لم يُحمل')]);
  const db = (await commitRestore(env, plan)).db;
  expect(accountBalance(db, '2410')).toBe(20000);
  expect(creditSum(db)).toBe(0);
  healthy(db);
  expect(integrityChecks(db).find((c) => c.name === CHECK)!.value).toContain('خارجها قيود بلا مستند');
  env.closeLive();
});

test('عيبٌ جديد (المتحقق المستقل) وعكس القيد المعلَّم من الدفتر: عكسه خارج المطابقة معه · والفحص يبقى سليماً', async () => {
  const env = newEnv();
  const archive = await backup(env);
  const k = contract(env.db);
  overpay(env.db, k);
  const plan = await prepareRestore(env, archive);
  const db = (await commitRestore(env, plan)).db;
  const [item] = keptForReview(db);
  const a = entrySourceAction(db, item.id);
  if (a?.kind !== 'op') throw new Error('op');
  expect(a.label).toBe('عكس القيد');
  a.run('2026-04-01', 'لا عقد له');
  expect(keptForReview(db)).toEqual([]);
  expect(accountBalance(db, '2410')).toBe(0);
  healthy(db);
  env.closeLive();
});

test('عيبٌ جديد (المتحقق المستقل) وقيدٌ علّمته المزامنة لغياب دفعته ورصيد مستأجره على صفّه: يبقى داخل مطابقة 2410', async () => {
  const env = newEnv();
  const db = env.db;
  const k = contract(db);
  const pay = overpay(db, k);
  expect(creditSum(db)).toBe(20000);
  // دفعته حذفها واردٌ (استعادةٌ على جهاز آخر حذفت مستندها) · وصفّ المستأجر بقي برصيده كما كتبه هذا الجهاز
  db.transaction(() => {
    db.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'applying'`);
    db.run(`DELETE FROM payment_allocations WHERE payment_id = ?`, [pay]);
    db.run(`DELETE FROM payment_lines WHERE payment_id = ?`, [pay]);
    db.run(`DELETE FROM contract_payments WHERE id = ?`, [pay]);
    db.run(`UPDATE sync_ctl SET v = 0 WHERE k = 'applying'`);
  });
  expect(markOrphans(db, 'وصل بالمزامنة')).toBe(1);
  const c = integrityChecks(db).find((x) => x.name === CHECK)!;
  expect(`${c.ok} (${c.value})`).toBe('true (200.00 / 200.00)');
  env.closeLive();
});
