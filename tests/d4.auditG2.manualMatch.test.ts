/**
 * المدقق G2 · الجولة السابعة عشرة · على 3f2c136 · المالك يسجّل تحويل المستأجر من شاشة التحصيل ويطابق به سطر الكشف، ومحصِّلٌ لم يسحب بعد
 * يعتمد الإيداع نفسه تحصيلاً من الكشف: جهاز المالك يقبله، فتحصيلان لإيداعٍ واحد · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditG2.manualMatch.test.ts
 *
 * G2-2 · عالٍ · src/sync/engine.ts:683-719 (liveDepositCollection: «التحصيل الحيّ للإيداع» قيودٌ تحمل stmt_line_id وحدها · rows من
 * journal_entries بسطرها، و«if (!rows.length) return null») مع engine.ts:1980-1985 (الحارس يقبل القيد حين يعود null) و
 * src/domain/bankStatement/store.ts:180-194 (approveMatch يمسك الإيداع بحركةٍ قائمة بلا stmt_line_id على قيدها) وengine.ts:1905-1910
 * (keepLocal يحمي السطر المطابَق هنا من واردٍ «مفتوح» وحده، والوارد «مطابَقاً» بحركةٍ أخرى يغلب بالوقت):
 * المالك قرأ كشف أكتوبر (إيداعٌ واحد 2,500 يوم 1 أكتوبر، بيانه لا يسمّي أحداً) وتزامن معه المحصِّل (البنوك ٣ والتحصيل ٣) · ثم يسجّل
 * المالك تحويل ماجد من شاشة التحصيل (بنكٌ بتاريخ 1 أكتوبر) ويعتمد اقتراح المطابقة «الجاهز» فيطابق السطر بحركته، ويرفع · والمحصِّل قبل أن
 * يسحب يرى الإيداع مفتوحاً بلا حركة فيُقترح له قسط ماجد («تحتاج مراجعة») فيعتمده، ويرفع · جهاز المالك: قيد المحصِّل لا يجد قيداً «يحمل
 * سطر الكشف» فيُقبل، ثم يصل السطر «مطابَقاً» بحركة المحصِّل فيغلب مطابقة المالك بالوقت · دفعتان حيّتان لماجد من إيداعٍ واحد، والبنك في
 * الدفاتر 5,000 والكشف 2,500، وحركة المالك «في الدفاتر وحدها»، ولا شيء في «المرفوض» · ولو سحب المحصِّل قبل الاعتماد لكان السطر عنده
 * مطابَقاً فلا اقتراح ولا اعتماد: النتيجة بترتيب الوصول · (وكذلك لهدفٍ آخر: قسط سالم بدل ماجد · جُرّب.)
 * لماذا يهم: هو المسار المعتاد قبل الكشف وبعده: المالك يسجّل التحويلات حين تصله ويطابق بها، والمحصِّل يعمل من الكشف · وحارس «الإيداع
 * الواحد يسند تحصيلاً واحداً» (Z2-1 وE2-4) بُني لهذا السباق نفسه لكنه لا يرى إلا قيود الكشف · فإيرادٌ وبنكٌ مضاعفان (إيراد الإيجار 5,000 لقسطٍ
 * بـ2,500 · جُرّب)، والمطابقة التي اعتمدها المالك تُمحى بلا أثر · وليس من «جهازي المالك بلا حَكَم» (§٥ · ٢): الكاتب عضوٌ وجهاز المالك هو الحَكَم.
 * السلوك الصحيح: الإيداع المطابَق على جهاز المالك بحركةٍ حيّة يمسكه ذلك التحصيل: قيد العضو من الكشف لسطره (أو بصمته) تحصيلٌ ثانٍ يُرفض،
 * فدفعةٌ حيّة واحدة والبنك 2,500، والسطر مطابَقٌ بحركة المالك، والآخر في «المرفوض».
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
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditE2.lineLate.test.ts */
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

test('G2-2 · [عالٍ] المالك طابق الإيداع بتحويلٍ سجّله، والمحصِّل يعتمده تحصيلاً من الكشف قبل أن يسحب: جهاز المالك يقبل تحصيلاً واحداً والبنك 2,500', async () => {
  const ORG = 'owner-g2-2';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع G2-2', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع G2-2' });
  const contract = confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'G22-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000004201', phone: '0500004201', valueHalalas: 3000000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  // كشف أكتوبر: إيداعٌ واحد 2,500 يوم 1 أكتوبر (البيان لا يسمّي أحداً)
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/01', 'حوالة واردة مصطنعة', '', '2,500.00', '2,500.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(O, bank, g, { name: 'oct-g2-2.csv', hash: 'g2-2-oct' });
  await ownerSync();
  const collector = memberDevice(r, ORG, 'member-g2-2', { banks: 3, collect: 3 });
  await collector.sync(); await collector.sync();
  const firstInst = (db: DB) => db.get<{ id: string; due: string }>(`SELECT id, due_date AS due FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [contract])!;

  // المالك يسجّل تحويل ماجد من شاشة التحصيل ثم يعتمد اقتراح المطابقة «الجاهز»
  const inst = firstInst(O);
  recordRentPayment(O, contract, { installmentId: inst.id, period: periodLabel(inst.due), date: '2026-10-01',
    lines: [{ method: 'bank', bankId: bank, amountHalalas: 250000 }], discountHalalas: 0, notes: '' });
  const [m] = matchSuggestions(O, bank);
  expect(m.level).toBe('ready');
  approveMatch(O, m.line.id, m.tx.id);
  const ownerTx = m.tx.id;
  await ownerSync();

  // المحصِّل لم يسحب بعد: الإيداع عنده مفتوحٌ بلا حركة، فيُقترح له قسط ماجد ويعتمده
  const [s] = collectionSuggestions(collector.db, bank);
  expect(s.target).toEqual({ kind: 'installments', contractId: contract, installmentIds: [firstInst(collector.db).id] });
  approveCollection(collector.db, s.line.id, s.target);
  await collector.sync(); await collector.sync();
  await ownerSync(); await ownerSync();

  const view = {
    livePayments: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE cancelled_at IS NULL`)!.n),
    bank: bankBalance(O, bank),
    lineTx: O.get<{ tx: string }>(`SELECT bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [m.line.id])!.tx,
    rejectedTwice: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'journal_entries'`)!.n),
  };
  // (الواقع: دفعتان حيّتان لماجد، والبنك 500,000، والسطر مطابَقٌ بحركة المحصِّل، ولا مرفوض)
  expect(view).toEqual({ livePayments: 1, bank: 250000, lineTx: ownerTx, rejectedTwice: 1 });
  O.close(); collector.db.close();
});
