/**
 * المدقق E2 · الجولة السادسة عشرة · على 50556c3 · حارس «الإيداع الواحد يسند تحصيلاً واحداً» لا يعمل إن لم يصل سطر الكشف إلى جهاز المالك
 * قبل قيد التحصيل · والقيود تُطبَّق قبل سطور الكشف في كل سحب · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditE2.lineLate.test.ts
 *
 * E2-4 · عالٍ · src/sync/engine.ts:683-686 (liveDepositCollection: «if (!line) return null» · السطر الغائب يعني «لا تحصيل له») مع
 * engine.ts:1941-1946 (الحارس يقبل القيد حين يعود null) وsrc/db/syncTables.ts:47 و95 (journal_entries قبل bank_statement_lines في ترتيب
 * التطبيق) وsrc/db/schema.ts:1984 (stmt_line_id بلا مفتاحٍ أجنبي فلا ينتظر القيد سطره):
 * المالك لم يقرأ كشف أكتوبر بعد · محصِّلان (البنوك ٣ والتحصيل ٣) يقرأ كلٌّ منهما الملف نفسه على جهازه (المعرّفات حتمية فهو سطرٌ واحد ·
 * Y٣) وفيه إيداعٌ واحد 2,500 يوم 1 أكتوبر · الأول يعتمده لقسط ماجد والثاني لقسط سالم (اعتمادٌ «تحتاج مراجعة» بالمبلغ والتاريخ) · يرفعان
 * ثم يسحب المالك: قيد الأول يصل قبل السطر فيعود الحارس null فيُقبل، وقيد الثاني كذلك فيُقبل · دفعتان حيّتان من إيداعٍ واحد، والبنك في
 * الدفاتر 5,000 والكشف 2,500، ولا شيء في «المرفوض» · ولو سحب المالك بين الرفعين لرُفض الثاني (السطر عنده حينها): النتيجة بترتيب الوصول.
 * لماذا يهم: هو Z٢-١ (الإيداع الواحد لهدفين) بالطريق الأكثر شيوعاً: المالك يفتح التطبيق مرةً في اليوم والمحصِّلون يعملون قبله، والكشف
 * يقرؤه من يعمل عليه · قسطٌ يُسدَّد بلا مال، وإيرادٌ وبنكٌ مضاعفان، والسطر مطابَقٌ بإحدى الحركتين فتبقى الأخرى «في الدفاتر وحدها»
 * وحدها دليلاً · وليس من «جهازي المالك بلا حَكَم» (§٥ · ٢): الكاتبان عضوان وجهاز المالك هو الحَكَم المبنيّ لهما.
 * السلوك الصحيح: قيدٌ يحمل سطر كشفٍ لم يصل ينتظره (أو يُحكم عليه بالسطر من الوارد) فلا يتغيّر الحكم بترتيب الوصول: دفعةٌ حيّة واحدة،
 * والبنك 2,500، والآخر في «المرفوض» تحصيلاً ثانياً.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditC2.mt940Twins.test.ts */
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

test('E2-4 · [عالٍ] محصِّلان يعتمدان إيداعاً واحداً لهدفين والمالك لم يقرأ الكشف: جهاز المالك يقبل تحصيلاً واحداً والبنك 2,500', async () => {
  const ORG = 'owner-e2-4';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع E2-4', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع E2-4' });
  const contracts: string[] = [];
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    contracts.push(confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'E24-' + n }), {
      tenant, idNumber: '100000340' + n, phone: '050000340' + n, valueHalalas: 3000000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    })));
  }
  await ownerSync();
  const c1 = memberDevice(r, ORG, 'member-e2-4a', { banks: 3, collect: 3 });
  const c2 = memberDevice(r, ORG, 'member-e2-4b', { banks: 3, collect: 3 });
  for (const m of [c1, c2]) { await m.sync(); await m.sync(); }

  // كلٌّ منهما يقرأ كشف أكتوبر (إيداعٌ واحد 2,500) ويعتمده لقسطٍ مستحقٍّ بالمبلغ نفسه: الأول لماجد والثاني لسالم
  const oct = () => {
    const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/01', 'حوالة واردة مصطنعة', '', '2,500.00', '2,500.00']]);
    if (!g.ok) throw new Error(g.error);
    return g;
  };
  const lineIds: string[] = [];
  for (const [m, contract] of [[c1, contracts[0]], [c2, contracts[1]]] as const) {
    saveStatement(m.db, bank, oct(), { name: 'oct-e2-4.csv', hash: 'e2-4-oct' });
    const line = m.db.get<{ id: string }>(`SELECT id FROM bank_statement_lines`)!.id;
    lineIds.push(line);
    const inst = m.db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [contract])!.id;
    approveCollection(m.db, line, { kind: 'installments', contractId: contract, installmentIds: [inst] });
  }
  // (السطر نفسه على الجهازين)
  expect(lineIds[0]).toBe(lineIds[1]);
  await c1.sync(); await c2.sync();
  await ownerSync(); await ownerSync();

  const view = {
    livePayments: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE cancelled_at IS NULL`)!.n),
    bank: bankBalance(O, bank),
    rejectedTwice: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'journal_entries'`)!.n),
  };
  // (الواقع: دفعتان حيّتان (ماجد وسالم)، والبنك 500,000، ولا مرفوض)
  expect(view).toEqual({ livePayments: 1, bank: 250000, rejectedTwice: 1 });
  O.close(); c1.db.close(); c2.db.close();
});
