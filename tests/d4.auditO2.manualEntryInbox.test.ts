/**
 * المدقق O2 · الجولة الحادية والعشرون · على ec1b970 · حارس «الإيداع الواحد يسند تحصيلاً واحداً» يعدّ المطابقة اليدوية بقيدٍ مطبَّقٍ هنا وحده:
 * قيد المطابقة اليدوية في الوارد معه (لم يُطبَّق بعد) لا يحجز الإيداع، فيُقبل تحصيلٌ ثانٍ بحسب ترتيب الرفع · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditO2.manualEntryInbox.test.ts
 *
 * O2-1 · عالٍ · src/sync/engine.ts:735-740 (liveDepositCollection: المطابقة اليدوية تُعدّ إن وُجد قيد حركتها في journal_entries هنا وحده
 * «db.get(... FROM journal_entries WHERE no = ? ...)»، وقيدٌ ينتظر في الوارد لا يُرى، فلا تُعدّ ولا تُنتظر) مع engine.ts:2436-2439 (الوارد يُطبَّق
 * بالترتيب «rank, updated_at, doc»: القيود بوقت رفعها في الخادم) وengine.ts:774-777 (taken < cap يقبل):
 * المالك قرأ كشف أكتوبر (إيداعٌ واحد 2,500 يوم 1 أكتوبر، بيانه لا يسمّي أحداً) وتزامن معه محصِّلان (البنوك ٣ والتحصيل ٣) · الثاني بلا اتصال
 * يعتمد الإيداع لقسط سالم ويرفع أولاً · والأول بلا اتصال (لم يسحب بعد) يسجّل تحويل ماجد من شاشة التحصيل ويعتمد اقتراح المطابقة «الجاهز»
 * فيطابق السطر بحركته، ثم يرفع (نسخة السطر عنده أحدث فتغلب في السحابة) · المالك يسحب: قيد سالم أسبق رفعاً فيُفحص أولاً، والسطر في الوارد
 * مطابَقٌ بحركة الأول وحركته في الوارد، لكن قيد ماجد لم يُطبَّق بعد (رُفع بعده) فلا تُعدّ المطابقة اليدوية ولا تُنتظر · فيُقبل قيد سالم، ثم
 * قيد ماجد بلا حارس (لا سطر عليه)، ثم يصل السطر مطابَقاً بحركة ماجد · هو I2-1 بترتيب الرفع المعكوس (I2-1: الأول رفع أولاً فطُبِّق قيده قبل
 * الفحص فرُفض الثاني · وهو الضابط هنا · جُرّب).
 * لماذا يهم: إيداعٌ واحد 2,500 يصير في دفاتر المالك تحصيلين (ماجد وسالم)، ورصيد البنك في الدفاتر 5,000 والكشف 2,500، وقسط سالم «مدفوع» ولم
 * يدفع، ولا شيء في «المرفوض» · والحكم يتغيّر بأي المحصِّلَين رفع أولاً، وهو ما أصلحته I2-1 «فلا يتغيّر الحكم بترتيب الوصول» · وليس من
 * «جهازي المالك بلا حَكَم» (§٥ · ٢): الكاتبان عضوان وجهاز المالك هو الحَكَم المبنيّ لهما.
 * السلوك الصحيح: المطابقة اليدوية بحركةٍ قيدُها في الوارد لم يُطبَّق بعد تحجز الإيداع (أو يُنتظر قيدها كما تُنتظر الحركة)، فبأي ترتيب رفعٍ:
 * دفعةٌ حيّة واحدة (ماجد) والبنك 2,500، والسطر مطابَقٌ بحركة ماجد، وتحصيل سالم في «المرفوض».
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
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, matchSuggestions, approveMatch } from '@/domain/bankStatement/store';
import { approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditI2.inboxManual.test.ts */
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

async function run(manualFirst: boolean) {
  const ORG = 'owner-o2-1' + (manualFirst ? 'm' : 's');
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع O2-1', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع O2-1' });
  const contracts: string[] = [];
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    contracts.push(confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'O21-' + n }), {
      tenant, idNumber: '100000920' + n, phone: '050000920' + n, valueHalalas: 3000000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    })));
  }
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/01', 'حوالة واردة مصطنعة', '', '2,500.00', '2,500.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(O, bank, g, { name: 'oct-o2-1.csv', hash: 'o2-1-oct' });
  await ownerSync();
  const c1 = memberDevice(r, ORG, 'member-o2-1a', { banks: 3, collect: 3 });
  const c2 = memberDevice(r, ORG, 'member-o2-1b', { banks: 3, collect: 3 });
  for (const m of [c1, c2]) { await m.sync(); await m.sync(); }
  const firstInst = (db: DB, c: string) => db.get<{ id: string; due: string }>(
    `SELECT id, due_date AS due FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!;
  const lineId = O.get<{ id: string }>(`SELECT id FROM bank_statement_lines`)!.id;

  // المحصِّل الثاني بلا اتصال: يعتمد الإيداع لقسط سالم
  approveCollection(c2.db, lineId, { kind: 'installments', contractId: contracts[1], installmentIds: [firstInst(c2.db, contracts[1]).id] });
  await tick();
  // المحصِّل الأول بلا اتصال: يسجّل تحويل ماجد من شاشة التحصيل ويطابق به السطر
  const inst = firstInst(c1.db, contracts[0]);
  recordRentPayment(c1.db, contracts[0], { installmentId: inst.id, period: periodLabel(inst.due), date: '2026-10-01',
    lines: [{ method: 'bank', bankId: bank, amountHalalas: 250000 }], discountHalalas: 0, notes: '' });
  const [m] = matchSuggestions(c1.db, bank);
  approveMatch(c1.db, m.line.id, m.tx.id);
  const manualTx = m.tx.id;
  await tick();

  // ترتيب الرفع: الضابط (I2-1) يرفع الأول أولاً، والعيب يرفع الثاني أولاً · ونسخة السطر عند الأول أحدث في الحالين
  const order = manualFirst ? [c1, c2] : [c2, c1];
  for (const x of order) { await x.sync(); await tick(); }
  await c1.sync();
  await ownerSync(); await ownerSync();

  const view = {
    livePayments: O.all<{ c: string }>(`SELECT contract_id AS c FROM contract_payments WHERE cancelled_at IS NULL`).map((x) => x.c),
    bank: bankBalance(O, bank),
    lineTx: O.get<{ tx: string }>(`SELECT bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [lineId])!.tx,
    rejectedEntries: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'journal_entries'`)!.n),
  };
  O.close(); c1.db.close(); c2.db.close();
  return { view, contracts, manualTx };
}

test('O2-1 · [ضابط] المطابقة اليدوية رُفعت أولاً: تحصيل الثاني من الكشف مرفوض على جهاز المالك', async () => {
  const { view, contracts, manualTx } = await run(true);
  expect(view).toEqual({ livePayments: [contracts[0]], bank: 250000, lineTx: manualTx, rejectedEntries: 1 });
});

test('O2-1 · [عالٍ] التحصيل من الكشف رُفع أولاً وقيد المطابقة اليدوية في الوارد معه: يُقبل تحصيلٌ واحد والبنك 2,500', async () => {
  const { view, contracts, manualTx } = await run(false);
  // (الواقع المتوقَّع للعيب: دفعتان حيّتان (ماجد وسالم)، والبنك 500,000، والسطر مطابَقٌ بحركة ماجد، ولا مرفوض)
  expect(view).toEqual({ livePayments: [contracts[0]], bank: 250000, lineTx: manualTx, rejectedEntries: 1 });
});
