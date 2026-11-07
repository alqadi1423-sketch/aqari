/**
 * التوجيه الثالث · ٠ · العطل المفتوح ٨ (قرار المالك 2026-11-07 «كل شيء يسويه الوكيل» · تحت القاعدة الدائمة للمال ١٠٠):
 * فحص «الرصيد الدائن للمستأجرين يطابق حسابه 2410» بعد «استعادة واعتمادها» حين يُضمّ قيدٌ مسّ 2410 بعد النسخة.
 * الأسلوب: رصيد كل مستأجرٍ في النسخة يُضاف إليه أثر القيود المضمومة في 2410 المنسوبة إليه (بعقد السطر أو بدفعته أو بمصدره)،
 * فيبقى الدفتر وسجلات المستأجرين متطابقين بالبناء · وما لا يُنسب إلى مستأجرٍ في النسخة (مستأجرٌ أُنشئ بعدها) يُحفظ مبلغه بالضبط
 * في علامة القيد، فيخرج من المطابقة بمبلغه وحده ويعود إليها إن عُكس · ولا يُخفى فرقٌ حقيقي (كما كان في 5b7f33d).
 * بيانات مصطنعة، والأرقام محسوبة يدوياً في كل اختبار.
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, recordRentPayment, recordBulkRentPayment, applyTenantCredit } from '@/domain/contracts/service';
import { postEntry, reverseEntryById } from '@/domain/accounting/post';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { keptForReview, dismissKeptReview } from '@/domain/accounting/orphans';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { mergeTenants } from '@/domain/tenants';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-d3-credit-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });

const CHECK = 'الرصيد الدائن للمستأجرين يطابق حسابه 2410';
const check2410 = (db: DB) => integrityChecks(db).find((c) => c.name === CHECK)!;
const credits = (db: DB) => Number(db.get<{ s: number }>(`SELECT COALESCE(SUM(credit_halalas), 0) AS s FROM tenants WHERE deleted_at IS NULL`)!.s);
const creditOf = (db: DB, tenantId: string) => Number(db.get<{ c: number }>(`SELECT credit_halalas AS c FROM tenants WHERE id = ?`, [tenantId])!.c);
const tenantOf = (db: DB, cid: string) => db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [cid])!.t;
const insts = (db: DB, cid: string) => db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);

/** عقدٌ شهري بقسطٍ ١٬٠٠٠ ريال (١٠٠٬٠٠٠ هللة) لمستأجرٍ مصطنع */
function contract(db: DB, who = { tenant: 'مستأجر مصطنع أ', idNumber: '1000000801', phone: '0500000801' }) {
  const u = addUnit(db, addProperty(db), { rent: 100000 });
  const cid = confirmContract(db, contractInput(u, { ...who, valueHalalas: 1200000, depositHalalas: 0, cycle: 'شهرية' }));
  return { cid, insts: insts(db, cid), tenant: tenantOf(db, cid) };
}
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}
async function restoreKeeping(env: TestBackupEnv, archive: string): Promise<DB> {
  const plan = await prepareRestore(env, archive);
  return (await commitRestore(env, plan)).db;
}

describe('العطل ٨ · رصيد المستأجر الدائن بعد «استعادة واعتمادها»', () => {
  test('٨ · فائضٌ على عقدٍ في النسخة بعدها: يُحمل رصيده مع دفعته · الدفتر ٢٠٠ والرصيد ٢٠٠ ويُستعمل · ولا مراجعة لرصيده', async () => {
    const env = newEnv();
    const k = contract(env.db);
    const archive = await backup(env);
    // ١٬٢٠٠ ريال على قسطٍ بألف: الفائض ٢٠٠ ريال (٢٠٬٠٠٠ هللة) رصيدٌ دائن
    recordBulkRentPayment(env.db, k.cid, { installmentIds: [k.insts[0]], date: '2026-03-02', notes: '', lines: [{ method: 'cash', amountHalalas: 120000 }] });
    expect([creditOf(env.db, k.tenant), accountBalance(env.db, '2410')]).toEqual([20000, 20000]);
    const db = await restoreKeeping(env, archive);
    expect([creditOf(db, k.tenant), accountBalance(db, '2410')]).toEqual([20000, 20000]);
    expect(check2410(db).ok).toBe(true);
    expect(keptForReview(db).map((x) => x.reason).join(' ')).not.toContain('رصيد المستأجر');
    // والرصيد المحمول يُستعمل كأي رصيد: ٢٠٠ ريال على القسط الثاني
    applyTenantCredit(db, k.cid, { installmentId: k.insts[1], amountHalalas: 20000, date: '2026-03-05' });
    expect([creditOf(db, k.tenant), accountBalance(db, '2410'), check2410(db).ok]).toEqual([0, 0, true]);
    env.closeLive();
  });

  test('٨ · مستأجرٌ وعقدٌ أُنشئا بعد النسخة وفائضٌ عليه (البذرة ٥٧٢): يخرج مبلغه بالضبط من المطابقة ويُذكر · ويعود إليها إن عُكس', async () => {
    const env = newEnv();
    contract(env.db); // مستأجرٌ قديم في النسخة بلا رصيد
    const archive = await backup(env);
    const k = contract(env.db, { tenant: 'مستأجر بعد النسخة مصطنع', idNumber: '1000000802', phone: '0500000802' });
    // ١٬٣٥٠ ريال على قسطٍ بألف: الفائض ٣٥٠ ريال (٣٥٬٠٠٠ هللة)
    const pay = recordBulkRentPayment(env.db, k.cid, { installmentIds: [k.insts[0]], date: '2026-03-02', notes: '', lines: [{ method: 'cash', amountHalalas: 135000 }] });
    const entryId = env.db.get<{ e: string }>(`SELECT journal_entry_id AS e FROM contract_payments WHERE id = ?`, [pay])!.e;
    const db = await restoreKeeping(env, archive);
    expect(db.get(`SELECT 1 FROM tenants WHERE id = ?`, [k.tenant])).toBeUndefined();
    expect([accountBalance(db, '2410'), credits(db)]).toEqual([35000, 0]);
    const c = check2410(db);
    expect(c.ok).toBe(true);
    expect(c.value).toBe('0.00 / 0.00 · خارجها قيود بلا مستند 350.00');
    expect(keptForReview(db).map((x) => x.id)).toEqual([entryId]);
    // «تمّت مراجعته» لا يعيده إلى المطابقة: مستأجره ليس في النسخة بعد
    dismissKeptReview(db, entryId);
    expect(check2410(db).ok).toBe(true);
    // وعكسه يعيد الدفتر إلى صفر فلا يُخرج شيء
    reverseEntryById(db, entryId, 'عكس قيدٍ بلا مستند مصطنع');
    expect([accountBalance(db, '2410'), check2410(db).ok, check2410(db).value]).toEqual([0, true, '0.00 / 0.00']);
    env.closeLive();
  });

  test('٨ · مستأجرٌ في النسخة وعقدٌ له بعدها: الفائض على الجديد يُنسب إلى المستأجر · واستعماله على القديم يُطفئه · صفر وصفر', async () => {
    const env = newEnv();
    const who = { tenant: 'مستأجر بعقدين مصطنع', idNumber: '1000000803', phone: '0500000803' };
    const old = contract(env.db, who);
    const archive = await backup(env);
    const neu = contract(env.db, who);
    expect(neu.tenant).toBe(old.tenant);
    recordBulkRentPayment(env.db, neu.cid, { installmentIds: [neu.insts[0]], date: '2026-03-02', notes: '', lines: [{ method: 'cash', amountHalalas: 125000 }] });
    applyTenantCredit(env.db, old.cid, { installmentId: old.insts[0], amountHalalas: 25000, date: '2026-03-03' });
    const db = await restoreKeeping(env, archive);
    expect([creditOf(db, old.tenant), accountBalance(db, '2410')]).toEqual([0, 0]);
    expect([check2410(db).ok, check2410(db).value]).toEqual([true, '0.00 / 0.00']);
    env.closeLive();
  });

  test('٨ · بنكٌ أُضيف بعد النسخة وفائضٌ عليه ثم استُعمل: الدفتر والرصيد صفر والفحص أخضر بلا ما يُخرج (ما ردّه المتحقق على 5b7f33d)', async () => {
    const env = newEnv();
    const k = contract(env.db);
    const archive = await backup(env);
    const bank = addBank(env.db);
    recordBulkRentPayment(env.db, k.cid, { installmentIds: [k.insts[0]], date: '2026-03-02', notes: '', lines: [{ method: 'bank', bankId: bank, amountHalalas: 120000 }] });
    applyTenantCredit(env.db, k.cid, { installmentId: k.insts[1], amountHalalas: 20000, date: '2026-03-03' });
    const db = await restoreKeeping(env, archive);
    expect([creditOf(db, k.tenant), accountBalance(db, '2410')]).toEqual([0, 0]);
    expect([check2410(db).ok, check2410(db).value]).toEqual([true, '0.00 / 0.00']);
    env.closeLive();
  });

  test('٨ · دمج مستأجرين بعد النسخة ثم فائض: الدمج لا يُستعاد وأثر القيد وحده يُحمل · لا ضعف الرصيد', async () => {
    const env = newEnv();
    const a = contract(env.db, { tenant: 'مستأجر يُدمج مصطنع', idNumber: '1000000804', phone: '0500000804' });
    const b = contract(env.db, { tenant: 'مستأجر يبقى مصطنع', idNumber: '1000000805', phone: '0500000805' });
    // رصيدٌ قديم ٥٠ ريالاً للأول قبل النسخة
    recordBulkRentPayment(env.db, a.cid, { installmentIds: [a.insts[0]], date: '2026-02-02', notes: '', lines: [{ method: 'cash', amountHalalas: 105000 }] });
    const archive = await backup(env);
    mergeTenants(env.db, b.tenant, [a.tenant], { allowDifferentIds: true });
    recordBulkRentPayment(env.db, b.cid, { installmentIds: [b.insts[0]], date: '2026-03-02', notes: '', lines: [{ method: 'cash', amountHalalas: 110000 }] });
    expect([creditOf(env.db, b.tenant), accountBalance(env.db, '2410')]).toEqual([15000, 15000]);
    const db = await restoreKeeping(env, archive);
    // النسخة: الأول ٥٠ والثاني صفر · ويُحمل أثر الفائض ١٠٠ ريال إلى الثاني وحده
    expect([creditOf(db, a.tenant), creditOf(db, b.tenant), accountBalance(db, '2410')]).toEqual([5000, 10000, 15000]);
    expect(check2410(db).ok).toBe(true);
    env.closeLive();
  });

  test('٨ · فرقٌ حقيقي لا يُخفى: قيدٌ يدوي على 2410 بلا مستأجر أحمرُ قبل الاستعادة وبعدها', async () => {
    const env = newEnv();
    contract(env.db);
    const archive = await backup(env);
    postEntry(env.db, { date: '2026-03-02', memo: 'قيد يدوي مصطنع على 2410',
      lines: [{ account: '1100', debit: 4000, credit: 0 }, { account: '2410', debit: 0, credit: 4000 }] });
    expect(check2410(env.db).ok).toBe(false);
    const db = await restoreKeeping(env, archive);
    expect([accountBalance(db, '2410'), credits(db), check2410(db).ok]).toEqual([4000, 0, false]);
    env.closeLive();
  });
});
