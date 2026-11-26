/**
 * المدقق I2 · الجولة الثامنة عشرة · على ae6765f · محصِّلٌ يسجّل تحويل المستأجر من شاشة التحصيل ويطابق به سطر الكشف، ومحصِّلٌ آخر لم يسحب
 * بعد يعتمد الإيداع نفسه تحصيلاً من الكشف، والمالك يسحب بعدهما: جهاز المالك يقبل التحصيلين · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditI2.inboxManual.test.ts
 *
 * I2-1 · عالٍ · src/sync/engine.ts:709 (liveDepositCollection: سطر الوارد يُقرأ «إن لم يكن هنا» وحده «!lines.has(x.id)»، فالنسخة الواردة
 * الأحدث لسطرٍ قائمٍ هنا لا تُرى) مع engine.ts:721-724 (manual: المطابَق يدوياً يُعدّ محجوزاً إن كانت حركته في bank_tx هنا وحدها، وحركات
 * البنك تُطبَّق بعد القيود · src/db/syncTables.ts:47 و63) وengine.ts:741-743 (cap بالسطور الحيّة، و«taken < cap» يقبل) وengine.ts:2022-2025:
 * المالك قرأ كشف أكتوبر (إيداعٌ واحد 2,500 يوم 1 أكتوبر، بيانه لا يسمّي أحداً) وتزامن معه محصِّلان (البنوك ٣ والتحصيل ٣) · الثاني بلا
 * اتصال يرى الإيداع مفتوحاً بلا حركة فيعتمده لقسط سالم («تحتاج مراجعة» بالمبلغ والتاريخ) · ثم الأول يسجّل تحويل ماجد من شاشة التحصيل
 * (بنكٌ بتاريخ 1 أكتوبر) ويعتمد اقتراح المطابقة «الجاهز» فيطابق السطر بحركته، ويرفع · الثاني يسحب (نسخة السطر الواردة أحدث فتغلب عنده:
 * السطر مطابَقٌ بحركة الأول) ويرفع تحصيله · المالك يسحب: قيد الثاني يحمل سطر الكشف، والسطر عنده قديمٌ «مفتوح» فلا يُقرأ ما في الوارد من
 * مطابقته اليدوية، وحركة الأول لم تُطبَّق بعد · فيُقبل، ثم يصل السطر مطابَقاً بحركة الأول · دفعتان حيّتان (ماجد وسالم) من إيداعٍ
 * واحد، والبنك في الدفاتر 5,000 والكشف 2,500، وحركة الثاني «في الدفاتر وحدها»، ولا شيء في «المرفوض» · ولو سحب المالك بين رفع الأول
 * ورفع الثاني لرُفض الثاني «تحصيلاً ثانياً» (جُرّب): النتيجة بترتيب الوصول.
 * لماذا يهم: هو G2-2 (إصلاح الجولة السابعة عشرة: «ويعدّ الإيداع المطابَق هنا بتحصيلٍ يدويٍّ حيٍّ محجوزاً») حين تكون المطابقة اليدوية من عضوٍ
 * وتصل مع التحصيل الآخر في سحبٍ واحد، وهو الشائع: المالك يفتح التطبيق مرةً والمحصِّلون يعملون قبله · قسطٌ يُسدَّد بلا مال، وإيرادٌ وبنكٌ
 * مضاعفان · وليس من «جهازي المالك بلا حَكَم» (§٥ · ٢): الكاتبان عضوان وجهاز المالك هو الحَكَم المبنيّ لهما.
 * السلوك الصحيح: حارس الإيداع يقرأ أحدث نسخ سطور اليوم والمبلغ (الوارد قبل القائم) ويعدّ المطابقة اليدوية بحركتها هنا أو في الوارد (أو
 * ينتظرها)، فلا يتغيّر الحكم بترتيب الوصول: دفعةٌ حيّة واحدة والبنك 2,500، والسطر مطابَقٌ بحركة الأول، وتحصيل الثاني في «المرفوض».
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

test('I2-1 · [عالٍ] مطابقةٌ يدوية من محصِّلٍ وتحصيلٌ من الكشف من آخر للإيداع نفسه يصلان المالكَ معاً: يُقبل تحصيلٌ واحد والبنك 2,500', async () => {
  const ORG = 'owner-i2-1';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع I2-1', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع I2-1' });
  const contracts: string[] = [];
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    contracts.push(confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'I21-' + n }), {
      tenant, idNumber: '100000610' + n, phone: '050000610' + n, valueHalalas: 3000000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    })));
  }
  // كشف أكتوبر: إيداعٌ واحد 2,500 يوم 1 أكتوبر (البيان لا يسمّي أحداً)
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/01', 'حوالة واردة مصطنعة', '', '2,500.00', '2,500.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(O, bank, g, { name: 'oct-i2-1.csv', hash: 'i2-1-oct' });
  await ownerSync();
  const c1 = memberDevice(r, ORG, 'member-i2-1a', { banks: 3, collect: 3 });
  const c2 = memberDevice(r, ORG, 'member-i2-1b', { banks: 3, collect: 3 });
  for (const m of [c1, c2]) { await m.sync(); await m.sync(); }
  const firstInst = (db: DB, c: string) => db.get<{ id: string; due: string }>(
    `SELECT id, due_date AS due FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!;

  // المحصِّل الثاني بلا اتصال: الإيداع مفتوحٌ بلا حركة فيعتمده لقسط سالم
  const lineId = c2.db.get<{ id: string }>(`SELECT id FROM bank_statement_lines`)!.id;
  approveCollection(c2.db, lineId, { kind: 'installments', contractId: contracts[1], installmentIds: [firstInst(c2.db, contracts[1]).id] });
  await tick();

  // المحصِّل الأول يسجّل تحويل ماجد من شاشة التحصيل ثم يعتمد اقتراح المطابقة «الجاهز»، ويرفع
  const inst = firstInst(c1.db, contracts[0]);
  recordRentPayment(c1.db, contracts[0], { installmentId: inst.id, period: periodLabel(inst.due), date: '2026-10-01',
    lines: [{ method: 'bank', bankId: bank, amountHalalas: 250000 }], discountHalalas: 0, notes: '' });
  const [m] = matchSuggestions(c1.db, bank);
  expect([m.line.id, m.level]).toEqual([lineId, 'ready']);
  approveMatch(c1.db, m.line.id, m.tx.id);
  const manualTx = m.tx.id;
  await c1.sync(); await c1.sync();

  // الثاني يسحب (مطابقة الأول أحدث فتغلب عنده) ويرفع تحصيله، ثم يسحب المالك
  await c2.sync(); await c2.sync();
  expect(c2.db.get<{ tx: string }>(`SELECT bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [lineId])!.tx).toBe(manualTx);
  await ownerSync(); await ownerSync();

  const view = {
    livePayments: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE cancelled_at IS NULL`)!.n),
    bank: bankBalance(O, bank),
    lineTx: O.get<{ tx: string }>(`SELECT bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [lineId])!.tx,
    rejectedEntries: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'journal_entries'`)!.n),
  };
  // (الواقع: دفعتان حيّتان (ماجد وسالم)، والبنك 500,000، والسطر مطابَقٌ بحركة الأول، ولا مرفوض)
  expect(view).toEqual({ livePayments: 1, bank: 250000, lineTx: manualTx, rejectedEntries: 1 });
  O.close(); c1.db.close(); c2.db.close();
});
