/**
 * المدقق O2 · الجولة الحادية والعشرون · على ec1b970 · حارس «الإيداع الواحد يسند تحصيلاً واحداً» لا يعدّ المطابقة اليدوية بحركة إيداعٍ نقدي
 * (حركةٌ بلا قيد)، فيقبل تحصيلاً من الكشف لإيداعٍ طابقه المالك بإيداع نقده · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditO2.cashDepositHold.test.ts
 *
 * O2-2 · عالٍ · src/sync/engine.ts:735-740 (liveDepositCollection: «const e = no && ... ? db.get(... journal_entries WHERE no = ?) : undefined»:
 * المطابقة اليدوية تُعدّ إن كان لحركتها قيدٌ حيّ وحده، وحركة «إيداع نقدي من المحفظة» بلا قيد · src/domain/cashOps.ts:42-47 «journal_no ''»)
 * مع engine.ts:774-777 (taken < cap يقبل):
 * المالك قرأ كشف أكتوبر (إيداعٌ واحد 2,500 يوم 1 أكتوبر، بيانه «إيداع نقدي» لا يسمّي أحداً) وتزامن معه المحصِّل (البنوك ٣ والتحصيل ٣) ·
 * المحصِّل بلا اتصال يرى الإيداع مفتوحاً فيعتمده لقسط سالم · والمالك (قبل أن يصله ذلك) سجّل دفعة ماجد نقداً 2,500، ثم «إيداع نقد في البنك»
 * 2,500 يوم 1 أكتوبر، ويعتمد اقتراح المطابقة فيطابق السطر بحركة الإيداع النقدي، ويرفع · المحصِّل يرفع، والمالك يسحب: الحارس يجد السطر هنا
 * مطابَقاً يدوياً، لكن حركته بلا رقم قيد فلا تُعدّ، فيُقبل تحصيل سالم · والسطر يبقى مطابَقاً بالإيداع النقدي (مطابقة المالك أحدث) · ولو طابقه
 * المالك بحركة تحصيلٍ بنكي (قيدٌ حيّ) لرُفض تحصيل سالم (G2-2، وهو الضابط هنا · جُرّب).
 * لماذا يهم: إيداع النقد المحصَّل في البنك هو المسار المعتاد لمن يقبض الإيجار نقداً · والإيداع الواحد 2,500 يصير في دفاتر المالك إيداعاً نقدياً
 * وتحصيلاً لسالم معاً: رصيد البنك في الدفاتر 5,000 والكشف 2,500، وقسط سالم «مدفوع» ولم يدفع، وحركة سالم «في الدفاتر وحدها»، ولا شيء في
 * «المرفوض» · والمطابقة التي اعتمدها المالك نفسه على جهازه لا تحمي الإيداع · وليس من «جهازي المالك بلا حَكَم» (§٥ · ٢): الكاتب عضو.
 * السلوك الصحيح: الإيداع المطابَق على جهاز المالك بحركةٍ حيّة في بنكه يمسكه ذلك، أكان لها قيدٌ أم كانت نقلاً للنقد بلا قيد: قيد المحصِّل
 * تحصيلٌ ثانٍ يُرفض، فدفعةٌ حيّة واحدة (ماجد)، والبنك 2,500، والسطر مطابَقٌ بالإيداع النقدي، وتحصيل سالم في «المرفوض».
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
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, matchSuggestions, approveMatch } from '@/domain/bankStatement/store';
import { approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditG2.manualMatch.test.ts */
function memberDevice(r: MemoryRemote, org: string, uid: string, perms: Access['perms']) {
  const M: Access = { owner: false, uid, perms, allProps: true, props: [] };
  const db = memDb();
  enableSync(db, uid);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org, profile: { name: 'محصّل مصطنع' } })]);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [org]);
  const sync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(db, r, getMeta(db, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  return { db, sync };
}
const tick = () => new Promise((res) => setTimeout(res, 20));

async function run(viaCash: boolean) {
  const ORG = 'owner-o2-2' + (viaCash ? 'c' : 'b');
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع O2-2', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع O2-2' });
  const contracts: string[] = [];
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    contracts.push(confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'O22-' + n }), {
      tenant, idNumber: '100000930' + n, phone: '050000930' + n, valueHalalas: 3000000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    })));
  }
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/01', 'ايداع نقدي مصطنع', '', '2,500.00', '2,500.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(O, bank, g, { name: 'oct-o2-2.csv', hash: 'o2-2-oct' });
  await ownerSync();
  const col = memberDevice(r, ORG, 'member-o2-2', { banks: 3, collect: 3 });
  await col.sync(); await col.sync();
  const firstInst = (db: DB, c: string) => db.get<{ id: string; due: string }>(
    `SELECT id, due_date AS due FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!;
  const lineId = O.get<{ id: string }>(`SELECT id FROM bank_statement_lines`)!.id;

  // المحصِّل بلا اتصال: الإيداع مفتوح فيعتمده لقسط سالم
  approveCollection(col.db, lineId, { kind: 'installments', contractId: contracts[1], installmentIds: [firstInst(col.db, contracts[1]).id] });
  await tick();

  // المالك: دفعة ماجد نقداً ثم إيداعها في البنك (أو، في الضابط، دفعته تحويلاً بنكياً)، ويطابق بها السطر
  const inst = firstInst(O, contracts[0]);
  recordRentPayment(O, contracts[0], { installmentId: inst.id, period: periodLabel(inst.due), date: '2026-10-01',
    lines: [viaCash ? { method: 'cash', amountHalalas: 250000 } : { method: 'bank', bankId: bank, amountHalalas: 250000 }], discountHalalas: 0, notes: '' });
  if (viaCash) depositCashToBank(O, { bankId: bank, amountHalalas: 250000, date: '2026-10-01' });
  const [m] = matchSuggestions(O, bank);
  approveMatch(O, m.line.id, m.tx.id);
  const ownerTx = m.tx.id;
  await ownerSync();
  await col.sync();
  await ownerSync(); await ownerSync();

  const view = {
    livePayments: O.all<{ c: string }>(`SELECT contract_id AS c FROM contract_payments WHERE cancelled_at IS NULL`).map((x) => x.c),
    bank: bankBalance(O, bank),
    lineTx: O.get<{ tx: string }>(`SELECT bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [lineId])!.tx,
    rejectedEntries: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'journal_entries'`)!.n),
  };
  O.close(); col.db.close();
  return { view, contracts, ownerTx };
}

test('O2-2 · [ضابط] المالك طابق الإيداع بحركة تحصيلٍ بنكي: تحصيل المحصِّل من الكشف مرفوض', async () => {
  const { view, contracts, ownerTx } = await run(false);
  expect(view).toEqual({ livePayments: [contracts[0]], bank: 250000, lineTx: ownerTx, rejectedEntries: 1 });
});

test('O2-2 · [عالٍ] المالك طابق الإيداع بإيداع نقده في البنك: تحصيل المحصِّل من الكشف مرفوض والبنك 2,500', async () => {
  const { view, contracts, ownerTx } = await run(true);
  // (الواقع المتوقَّع للعيب: دفعتان حيّتان، والبنك 500,000، ولا مرفوض)
  expect(view).toEqual({ livePayments: [contracts[0]], bank: 250000, lineTx: ownerTx, rejectedEntries: 1 });
});
