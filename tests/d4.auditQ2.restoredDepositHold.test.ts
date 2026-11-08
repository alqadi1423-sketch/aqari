/**
 * المدقق Q2 · الجولة الثانية والعشرون · على 260be7b · حارس «الإيداع الواحد يسند تحصيلاً واحداً» يقرأ حركة المطابقة اليدوية بنسختها هنا
 * المحذوفة ولو كانت مستعادةً حيّةً في الوارد، فلا تحجز المطابقةُ الواردة بها الإيداعَ ويُقبل تحصيلٌ ثانٍ · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditQ2.restoredDepositHold.test.ts
 *
 * Q2-2 · متوسط · src/sync/engine.ts:725-727 (liveDepositCollection · txNo: «if (t0) return t0.del == null ? … : null»: الحركة المحذوفة هنا
 * «لا حركة» ولو كانت نسختها في الوارد حيّة) مع engine.ts:741 («if (no == null …) continue») وengine.ts:783 (taken < cap يقبل):
 * المالك طابق إيداع الكشف (2,500 يوم 1 أكتوبر) بإيداع نقده، ثم حذف حركة الإيداع النقدي خطأً (فعاد السطر مفتوحاً) وتزامن · محاسبٌ ومحصِّل
 * (البنوك ٣ والتحصيل ٣) يسحبان · المحصِّل بلا اتصال يرى السطر مفتوحاً فيعتمده لقسط سالم · والمحاسب بعده بلا اتصال يستعيد الإيداع النقدي من
 * السلة ويطابق به السطر · يرفع المحصِّل ثم المحاسب (نسخة السطر عنده أحدث فتغلب) · المالك يسحب: الحارس يجد السطر في الوارد مطابَقاً
 * بالإيداع النقدي، لكن الحركة هنا محذوفة فلا تُعدّ، فيُقبل قيد سالم، ثم تُستعاد الحركة ويُطابَق بها السطر · والضابط (جُرّب): لو لم يحذفها
 * المالك (حركةٌ حيّة هنا وطابقها المحاسب) لرُفض قيد سالم (O2-2) · فالحذف والاستعادة وحدهما يفتحان التحصيل الثاني.
 * لماذا يهم: إيداعٌ واحد 2,500 يصير في دفاتر المالك إيداعاً نقدياً وتحصيلاً لسالم معاً: البنك في الدفاتر 5,000 والكشف 2,500، وقسط سالم
 * «مدفوع» ولم يدفع، ولا شيء في «المرفوض» · هو الصنف الذي أغلقه توسيع الجولة ٢١ (O2-2) بحركةٍ نسختها الحيّة في الوارد · وليس من «جهازي
 * المالك بلا حَكَم» (§٥ · ٢): الكاتبان عضوان والحَكَم جهاز المالك.
 * السلوك الصحيح: الحركة تُقرأ بأحدث نسخها (الوارد قبل ما هنا، كما يُقرأ السطر · I2-1)، فالمستعادة حيّةً في الوارد تحجز ما طابقته: قيد سالم
 * مرفوض، ودفعة ماجد وحدها حيّة، والبنك 2,500، والسطر مطابَقٌ بالإيداع النقدي.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';
import { periodLabel } from '@/domain/dates';
import { depositCashToBank } from '@/domain/cashOps';
import { deleteBankTx } from '@/domain/bankTx';
import { restoreFromTrash } from '@/domain/trash';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, matchSuggestions, approveMatch } from '@/domain/bankStatement/store';
import { approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditO2.cashDepositHold.test.ts */
function memberDevice(r: MemoryRemote, org: string, uid: string, perms: Access['perms']) {
  const M: Access = { owner: false, uid, perms, allProps: true, props: [] };
  const db = memDb();
  enableSync(db, uid);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org, profile: { name: 'عضو مصطنع' } })]);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [org]);
  const sync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(db, r, getMeta(db, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  return { db, sync };
}
const tick = () => new Promise((res) => setTimeout(res, 20));

async function run(ownerDeleted: boolean) {
  const ORG = 'owner-q2-2' + (ownerDeleted ? 'd' : 'k');
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع Q2-2', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع Q2-2' });
  const contracts: string[] = [];
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    contracts.push(confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'Q22-' + n }), {
      tenant, idNumber: '100000960' + n, phone: '050000960' + n, valueHalalas: 3000000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    })));
  }
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/01', 'ايداع نقدي مصطنع', '', '2,500.00', '2,500.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(O, bank, g, { name: 'oct-q2-2.csv', hash: 'q2-2-oct' });
  const firstInst = (db: DB, c: string) => db.get<{ id: string; due: string }>(
    `SELECT id, due_date AS due FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!;

  // المالك: دفعة ماجد نقداً وإيداعها في البنك · ثم (في الحالة المعيبة) يطابق بها السطر ويحذف الحركة خطأً
  const inst = firstInst(O, contracts[0]);
  recordRentPayment(O, contracts[0], { installmentId: inst.id, period: periodLabel(inst.due), date: '2026-10-01',
    lines: [{ method: 'cash', amountHalalas: 250000 }], discountHalalas: 0, notes: '' });
  depositCashToBank(O, { bankId: bank, amountHalalas: 250000, date: '2026-10-01' });
  const [m] = matchSuggestions(O, bank);
  const lineId = m.line.id;
  const cashTx = m.tx.id;
  if (ownerDeleted) { approveMatch(O, lineId, cashTx); deleteBankTx(O, cashTx); }
  await ownerSync();

  const acct = memberDevice(r, ORG, 'member-q2-2-acct', { banks: 3, collect: 3 });
  const col = memberDevice(r, ORG, 'member-q2-2-col', { banks: 3, collect: 3 });
  await acct.sync(); await acct.sync(); await col.sync(); await col.sync();
  // المحصِّل بلا اتصال: السطر مفتوح فيعتمده لقسط سالم
  approveCollection(col.db, lineId, { kind: 'installments', contractId: contracts[1], installmentIds: [firstInst(col.db, contracts[1]).id] });
  await tick();
  // المحاسب بعده بلا اتصال: يستعيد الإيداع النقدي (إن كان محذوفاً) ويطابق به السطر
  if (ownerDeleted) restoreFromTrash(acct.db, 'bank_tx', cashTx);
  approveMatch(acct.db, lineId, cashTx);
  await tick();
  await col.sync();
  await tick();
  await acct.sync();
  await ownerSync(); await ownerSync(); await acct.sync(); await col.sync(); await ownerSync();

  const view = {
    livePayments: O.all<{ c: string }>(`SELECT contract_id AS c FROM contract_payments WHERE cancelled_at IS NULL`).map((x) => x.c),
    bank: bankBalance(O, bank),
    lineTx: O.get<{ tx: string | null }>(`SELECT bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [lineId])!.tx,
    rejectedEntries: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'journal_entries'`)!.n),
  };
  O.close(); acct.db.close(); col.db.close();
  return { view, contracts, cashTx };
}

test('Q2-2 · [ضابط] الإيداع النقدي حيٌّ هنا وطابقه المحاسب: تحصيل المحصِّل من الكشف مرفوض', async () => {
  const { view, contracts, cashTx } = await run(false);
  expect(view).toEqual({ livePayments: [contracts[0]], bank: 250000, lineTx: cashTx, rejectedEntries: 1 });
});

test('Q2-2 · [متوسط] الإيداع النقدي محذوفٌ هنا ومستعادٌ في الوارد وطابقه المحاسب: تحصيل المحصِّل مرفوض والبنك 2,500', async () => {
  const { view, contracts, cashTx } = await run(true);
  // (الواقع على 260be7b: دفعتان حيّتان، والبنك 500,000، والسطر مطابَقٌ بالإيداع النقدي، ولا مرفوض)
  expect(view).toEqual({ livePayments: [contracts[0]], bank: 250000, lineTx: cashTx, rejectedEntries: 1 });
});
