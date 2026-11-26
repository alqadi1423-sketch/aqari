/**
 * المدقق K2 · الجولة التاسعة عشرة · على 5c203a6 · حارس «الإيداع الواحد يسند تحصيلاً واحداً» يعدّ إيداعين حقيقيين في يومٍ واحد إيداعاً واحداً حين
 * تكون شهادة الثاني في كشفٍ لا سطر حيّاً له في القاعدة، فيرفض تحصيلاً صحيحاً ثانياً · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditK2.guardSkipsPage.test.ts
 *
 * K2-2 · عالٍ · src/sync/engine.ts:744-756 (liveDepositCollection: stIds كشوف السطور الحيّة في القاعدة وحدها، وstatementsNeed عليها، وكشف الوارد
 * يُعدّ ببصماته في القاعدة «keys.filter(...).length» بلا ذوات الرصيد المختلفة، ثم cap = keepInOrder(...) و«taken < cap») مع engine.ts:2022-2025
 * (الحارس يرفض) · خلاف src/domain/bankStatement/store.ts:39-41 (الحفظ يعدّ بصمات الكشوف الحيّة للبنك كلها · I2-2):
 * المحصِّل (البنوك ٣ والتحصيل ٣) يحفظ بترتيب I2-2: تصدير الصباح بلا رصيد (حوالةٌ 2,500 يوم 1 أكتوبر بيانها «MAJED» «#1») ثم صورة الصفحة الأولى
 * (رسم 30 سبتمبر، والحوالة نفسها «@350000» تُتخطّى) ثم صورة الصفحة الثانية (حوالة سالم «@600000») · فعنده إيداعان حيّان صحيحان، ويعتمد كلاً منهما
 * لقسط صاحبه (ماجد ثم سالم) ويرفع · المالك يسحب: القيود تُطبَّق قبل سطور الكشف، والحارس يعدّ إيداعات القاعدة من سطور الوارد (#1 و@600000) وكشوفها
 * (التصدير والصفحة الثانية) وحدها، فلا تدخل الصفحة الأولى التي تشهد «@350000»، فـcap = 1 · تحصيل ماجد يُقبل، وتحصيل سالم «تحصيلٌ ثانٍ» مرفوض ·
 * فقسط سالم قائمٌ على جهاز المالك وقد دفع، وبنك المالك ناقصٌ 2,500 عن الكشف.
 * لماذا يهم: الحارس يُفترض أن يعدّ الإيداعات بقاعدة الحفظ نفسها (سجل القرارات ٦٥(٢) و٦٧(١)) · هنا يعدّ أقلّ مما حفظه الحفظ، فيُرفض تحصيلٌ حقيقي
 * لإيداعٍ حقيقي (مالٌ دخل البنك لا يظهر في دفاتر المالك، ومستأجرٌ دفع يبقى مطالَباً) · وكل خطواته مسارات مدعومة شائعة · وليس من «جهازي المالك بلا
 * حَكَم» (§٥ · ٢): الكاتب عضو.
 * السلوك الصحيح: إيداعان حيّان في الكشف يسندان تحصيلين: على جهاز المالك الدفعتان حيّتان، ورصيد البنك 600,000 هللة (افتتاحي 1,000 وإيداعان)، ولا قيد مرفوض.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementFile, type StatementResult } from '@/domain/bankStatement/read';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { saveStatement } from '@/domain/bankStatement/store';
import { approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditI2.twinMatch.test.ts */
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
const ok = (r: StatementResult) => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
const morning = () => ok(readStatementFile({ name: 'today.csv', bytes: new TextEncoder().encode([
  'Date,Description,Debit,Credit', '01/10/2026,TRANSFER MAJED,,2500.00'].join('\n')) }, { opening: 100000, closing: 350000 }));
const page1 = () => ok(readStatementPhoto([
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('1,005.00', 880, 80),
  ln('30/09/2026', 40, 100), ln('SMS CHARGES', 200, 100), ln('5.00', 560, 100), ln('1,000.00', 880, 100),
  ln('01/10/2026', 40, 120), ln('TRANSFER MAJED', 200, 120), ln('2,500.00', 720, 120), ln('3,500.00', 880, 120),
  ln('Closing Balance', 40, 160), ln('3,500.00', 880, 160),
  ln('Page 1 of 2', 40, 220),
]));
const page2 = () => ok(readStatementPhoto([
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('3,500.00', 880, 80),
  ln('01/10/2026', 40, 100), ln('TRANSFER SALEM', 200, 100), ln('2,500.00', 720, 100), ln('6,000.00', 880, 100),
  ln('02/10/2026', 40, 120), ln('SMS CHARGES', 200, 120), ln('5.00', 560, 120), ln('5,995.00', 880, 120),
  ln('Closing Balance', 40, 160), ln('5,995.00', 880, 160),
  ln('Page 2 of 2', 40, 220),
]));

test('K2-2 · [عالٍ] إيداعان حيّان حفظهما المحصِّل بترتيب I2-2 واعتمد كلاً لقسط صاحبه: جهاز المالك يقبل التحصيلين', async () => {
  const ORG = 'owner-k2-2';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع K2-2', 100000);
  const prop = addProperty(O, { name: 'عقار مصطنع K2-2' });
  const contracts: string[] = [];
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    contracts.push(confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'K22-' + n }), {
      tenant, idNumber: '100000720' + n, phone: '050000720' + n, valueHalalas: 3000000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    })));
  }
  await ownerSync();
  const collector = memberDevice(r, ORG, 'member-k2-2', { banks: 3, collect: 3 });
  await collector.sync(); await collector.sync();
  const firstInst = (db: DB, c: string) => db.get<{ id: string }>(
    `SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!.id;

  saveStatement(collector.db, bank, morning(), { name: 'today-k2-2.csv', hash: 'k2-2-today' });
  saveStatement(collector.db, bank, page1(), { name: 'oct-k2-2-p1.jpg', hash: 'k2-2-p1' });
  saveStatement(collector.db, bank, page2(), { name: 'oct-k2-2-p2.jpg', hash: 'k2-2-p2' });
  const lines = collector.db.all<{ id: string; d: string }>(
    `SELECT id, descr AS d FROM bank_statement_lines WHERE deleted_at IS NULL AND date = '2026-10-01' ORDER BY descr`);
  // (الحفظ صحيح: إيداعان حيّان)
  expect(lines.map((x) => x.d)).toEqual(['TRANSFER MAJED', 'TRANSFER SALEM']);
  approveCollection(collector.db, lines[0].id, { kind: 'installments', contractId: contracts[0], installmentIds: [firstInst(collector.db, contracts[0])] });
  approveCollection(collector.db, lines[1].id, { kind: 'installments', contractId: contracts[1], installmentIds: [firstInst(collector.db, contracts[1])] });
  expect(bankBalance(collector.db, bank)).toBe(600000);
  await collector.sync(); await collector.sync();
  await ownerSync(); await ownerSync();

  const view = {
    livePayments: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE cancelled_at IS NULL`)!.n),
    bank: bankBalance(O, bank),
    rejectedEntries: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'journal_entries'`)!.n),
  };
  // (الواقع: دفعةٌ واحدة، والبنك 350,000، وقيد سالم مرفوض «تحصيلٌ ثانٍ»)
  expect(O.all<{ w: string }>(`SELECT reason AS w FROM sync_rejects WHERE tbl = 'journal_entries'`).map((x) => x.w)).toEqual([]);
  // (وبلا تصدير الصباح «الصفحتان وحدهما» يُقبل التحصيلان · جُرّب)
  expect(view).toEqual({ livePayments: 2, bank: 600000, rejectedEntries: 0 });
  O.close(); collector.db.close();
});
