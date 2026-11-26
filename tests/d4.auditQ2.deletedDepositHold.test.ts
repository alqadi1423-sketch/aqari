/**
 * المدقق Q2 · الجولة الثانية والعشرون · على 260be7b · حارس «الإيداع الواحد يسند تحصيلاً واحداً» يقرأ حركة المطابقة اليدوية بنسختها هنا
 * ولو كان حذفها في الوارد معه، فإيداعٌ نقديٌّ محذوف يحجز السطر ويُرفض التحصيل الحقيقي · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditQ2.deletedDepositHold.test.ts
 *
 * Q2-1 · عالٍ · src/sync/engine.ts:725-727 (liveDepositCollection · txNo: «if (t0) return t0.del == null ? … : null» يقرأ الحركة هنا أولاً ولا
 * ينظر إلى نسختها في الوارد) مع engine.ts:741-742 (توسيع الجولة ٢١ · O2-2: الحركة بلا رقم قيد تحجز ما طابقته) وengine.ts:2070-2072 (المحجوز
 * يُرفض) وsrc/db/syncTables.ts:47,63 (القيود تُطبَّق قبل حركات البنك):
 * المالك قرأ كشف أكتوبر (إيداعٌ واحد 2,500 يوم 1 أكتوبر) وظنّه إيداع نقده: سجّل «إيداع نقد في البنك» 2,500 وطابق به السطر، ثم تزامن ·
 * المحاسب (البنوك ٣ والتحصيل ٣) يتحقق: الإيداع حوالةُ سالم، والإيداع النقدي لم يحدث (النقد ما زال في المحفظة) · فيحذف حركة الإيداع النقدي
 * (deleteBankTx يعيد السطر مفتوحاً · U19) ثم يعتمد السطر تحصيلاً لقسط سالم، ويرفع ذلك كله مرةً واحدة · المالك يسحب: قيد سالم يُفحص قبل أن
 * تُطبَّق حركة البنك المحذوفة، فالحارس يجد السطر هنا مطابَقاً بحركةٍ «حيّة» بلا قيد فيرفض قيد سالم نهائياً «تحصيلٌ ثانٍ»، ثم يُطبَّق الحذف ·
 * والضابط (جُرّب): لو رفع المحاسب الحذف قبل الاعتماد لقُبل التحصيل · فالحكم بترتيب الرفع وحده.
 * لماذا يهم: تحصيلٌ حقيقي يسقط من دفاتر المالك: البنك في الدفاتر 0 والكشف 2,500 والسطر مفتوح، وقسط سالم «قائم» وقد دفع، وحركة التحصيل
 * مرفوضةٌ معه، وجهاز المحاسب يعرض الدفعة حيّة · وهو أثر توسيع الجولة ٢١ نفسه: قبله لم تكن الحركة بلا قيد تحجز · وليس من «جهازي المالك بلا
 * حَكَم» (§٥ · ٢): الكاتب عضو والحَكَم جهاز المالك.
 * السلوك الصحيح: حركةٌ نسختها في الوارد محذوفة لا تحجز ما طابقته (أو يُنتظر تطبيقها كما يُنتظر عكس القيد · K2-3)، فبأي ترتيب رفعٍ: تحصيل
 * سالم مقبول، ودفعتان حيّتان (ماجد نقداً وسالم)، والبنك 2,500، والسطر مطابَقٌ بحركة تحصيل سالم، ولا مرفوض.
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
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org, profile: { name: 'محاسب مصطنع' } })]);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [org]);
  const sync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(db, r, getMeta(db, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  return { db, sync };
}
const tick = () => new Promise((res) => setTimeout(res, 20));

async function run(deleteSyncedFirst: boolean) {
  const ORG = 'owner-q2-1' + (deleteSyncedFirst ? 'f' : 't');
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع Q2-1', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع Q2-1' });
  const contracts: string[] = [];
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    contracts.push(confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'Q21-' + n }), {
      tenant, idNumber: '100000950' + n, phone: '050000950' + n, valueHalalas: 3000000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    })));
  }
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/01', 'ايداع مصطنع', '', '2,500.00', '2,500.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(O, bank, g, { name: 'oct-q2-1.csv', hash: 'q2-1-oct' });
  const firstInst = (db: DB, c: string) => db.get<{ id: string; due: string }>(
    `SELECT id, due_date AS due FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!;

  // المالك: دفعة ماجد نقداً، ثم «إيداع نقد في البنك» يطابق به السطر (ظنّاً)
  const inst = firstInst(O, contracts[0]);
  recordRentPayment(O, contracts[0], { installmentId: inst.id, period: periodLabel(inst.due), date: '2026-10-01',
    lines: [{ method: 'cash', amountHalalas: 250000 }], discountHalalas: 0, notes: '' });
  depositCashToBank(O, { bankId: bank, amountHalalas: 250000, date: '2026-10-01' });
  const [m] = matchSuggestions(O, bank);
  approveMatch(O, m.line.id, m.tx.id);
  const lineId = m.line.id;
  await ownerSync();

  // المحاسب: يحذف الإيداع النقدي الذي لم يحدث، ثم يعتمد السطر تحصيلاً لقسط سالم
  const acct = memberDevice(r, ORG, 'member-q2-1', { banks: 3, collect: 3 });
  await acct.sync(); await acct.sync();
  deleteBankTx(acct.db, m.tx.id);
  if (deleteSyncedFirst) { await acct.sync(); await ownerSync(); await acct.sync(); }
  approveCollection(acct.db, lineId, { kind: 'installments', contractId: contracts[1], installmentIds: [firstInst(acct.db, contracts[1]).id] });
  const collectTx = acct.db.get<{ tx: string }>(`SELECT bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [lineId])!.tx;
  await tick();
  await acct.sync();
  await ownerSync(); await ownerSync(); await acct.sync(); await ownerSync();

  const view = {
    livePayments: O.all<{ c: string }>(`SELECT contract_id AS c FROM contract_payments WHERE cancelled_at IS NULL ORDER BY c`).map((x) => x.c),
    bank: bankBalance(O, bank),
    lineTx: O.get<{ tx: string | null }>(`SELECT bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [lineId])!.tx,
    rejected: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects`)!.n),
  };
  O.close(); acct.db.close();
  return { view, contracts: [...contracts].sort(), collectTx };
}

test('Q2-1 · [ضابط] المحاسب رفع حذف الإيداع النقدي قبل الاعتماد: تحصيل سالم مقبول والبنك 2,500', async () => {
  const { view, contracts, collectTx } = await run(true);
  expect(view).toEqual({ livePayments: contracts, bank: 250000, lineTx: collectTx, rejected: 0 });
});

test('Q2-1 · [عالٍ] حذف الإيداع النقدي والاعتماد في رفعٍ واحد: تحصيل سالم مقبول والبنك 2,500', async () => {
  const { view, contracts, collectTx } = await run(false);
  // (الواقع على 260be7b: قيد سالم وحركته مرفوضان، ودفعة ماجد وحدها، والبنك 0، والسطر مفتوح)
  expect(view).toEqual({ livePayments: contracts, bank: 250000, lineTx: collectTx, rejected: 0 });
});
