/**
 * المدقق M2 · الجولة العشرون · على af2ba1f · حارس «الإيداع الواحد يسند تحصيلاً واحداً» يعدّ بصمات كشفٍ محذوفٍ في الوارد، فيجيز تحصيلاً ثانياً
 * للإيداع نفسه · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditM2.deletedInflates.test.ts
 *
 * M2-1 · عالٍ · src/sync/engine.ts:752-753 (liveDepositCollection: inboxSts كل مستندات bank_statements في الوارد ببنك السطر «del = 0» ولا ينظر
 * في d.deleted_at) مع engine.ts:756-768 (كشف الوارد الذي ليس هنا تُعدّ بصماته في need وذوات رصيده في bal بلا سؤالٍ عن حذفه) وengine.ts:769-772
 * (cap = keepInOrder(...) و«taken < cap» يجيز) · خلاف dedupe.ts:99 (statementCounts: الكشف المحذوف هنا لا يشهد) وstore.ts:39 والمزامنة في
 * engine.ts:1204 (bankStatementIds: «deleted_at IS NULL»):
 * المالك يقرأ تصدير أكتوبر برصيده (إيداعٌ واحد 2,500 يوم 1 أكتوبر «@350000») ويعتمده لقسط ماجد، ولم يتصل بعد · المحصِّل (البنوك ٣ والتحصيل ٣) بلا اتصال
 * قبل أن يصله ذلك: يقرأ تصدير الصباح بلا رصيد فيجد الحوالة مكرّرة خطأً (سطران «#1» و«#2»)، فيحذف الكشف ويقرأ التصدير الصحيح (سطرٌ واحد «#1»)
 * ويعتمده لقسط سالم ويرفع · المالك يتصل: القيود تُطبَّق قبل الكشوف، فالكشف المحذوف ما زال في الوارد وبصمتاه تجعلان need = 2، فـ«#1» و«@350000»
 * إيداعان (cap = 2) وتحصيل سالم يُقبل · وبلا الكشف المحذوف (need = 1) يُرفض «تحصيلٌ ثانٍ» كما يجب · جُرّب.
 * لماذا يهم: إيداعٌ واحد في البنك (2,500) يُسجَّل في دفاتر المالك تحصيلين لمستأجرين مختلفين، ورصيد البنك في الدفاتر يزيد 2,500 عن الكشف، وقسط سالم
 * «مدفوع» ولم يدفع · والرفض الذي يحمي من ذلك (Z2-1) يُبطله كشفٌ حذفه صاحبه لأنه خاطئ، وهو ما لا تعدّه المزامنة ولا الحفظ في أي موضعٍ آخر ·
 * وكل الخطوات مسارات مدعومة · وليس من «جهازي المالك بلا حَكَم» (§٥ · ٢): الكاتب عضو والحارس على جهاز المالك.
 * السلوك الصحيح: كشفٌ في الوارد محذوفٌ (d.deleted_at) لا يشهد بعدد الحركات كما لا يشهد المحذوف هنا: على جهاز المالك دفعةٌ حيّة واحدة (ماجد)، والبنك
 * 350,000 هللة (افتتاحي 1,000 وإيداعٌ واحد)، وقيد سالم مرفوض «تحصيلٌ ثانٍ».
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
import { saveStatement, deleteStatement } from '@/domain/bankStatement/store';
import { approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditK2.guardSkipsPage.test.ts */
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
const csv = (name: string, rows: string[], o: { opening: number; closing: number }) =>
  ok(readStatementFile({ name, bytes: new TextEncoder().encode(rows.join('\n')) }, o));
/** تصدير المالك برصيده */
const ownerExport = () => csv('oct.csv', ['Date,Description,Debit,Credit,Balance', '01/10/2026,TRANSFER,,2500.00,3500.00'], { opening: 100000, closing: 350000 });
/** تصدير الصباح الخاطئ: الحوالة مكرّرة */
const badMorning = () => csv('today.csv', ['Date,Description,Debit,Credit', '01/10/2026,TRANSFER,,2500.00', '01/10/2026,TRANSFER,,2500.00'], { opening: 100000, closing: 600000 });
/** تصدير الصباح الصحيح */
const goodMorning = () => csv('today2.csv', ['Date,Description,Debit,Credit', '01/10/2026,TRANSFER,,2500.00'], { opening: 100000, closing: 350000 });

async function run(withDeleted: boolean) {
  const ORG = 'owner-m2-1' + (withDeleted ? 'd' : 'c');
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع M2-1', 100000);
  const prop = addProperty(O, { name: 'عقار مصطنع M2-1' });
  const contracts: string[] = [];
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    contracts.push(confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'M21-' + n }), {
      tenant, idNumber: '100000810' + n, phone: '050000810' + n, valueHalalas: 3000000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    })));
  }
  const firstInst = (db: DB, c: string) => db.get<{ id: string }>(
    `SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!.id;
  await ownerSync();
  const collector = memberDevice(r, ORG, 'member-m2-1', { banks: 3, collect: 3 });
  await collector.sync(); await collector.sync();

  // المالك بلا اتصال: تصدير أكتوبر برصيده، واعتماد الإيداع لماجد
  saveStatement(O, bank, ownerExport(), { name: 'oct-m2-1.csv', hash: 'm2-1-owner' });
  const oLine = O.get<{ id: string }>(`SELECT id FROM bank_statement_lines WHERE deleted_at IS NULL`)!.id;
  approveCollection(O, oLine, { kind: 'installments', contractId: contracts[0], installmentIds: [firstInst(O, contracts[0])] });

  // المحصِّل بلا اتصال: كشفٌ خاطئ يحذفه، ثم الصحيح، ويعتمد الإيداع لسالم
  if (withDeleted) {
    const bad = saveStatement(collector.db, bank, badMorning(), { name: 'today-m2-1.csv', hash: 'm2-1-bad' });
    deleteStatement(collector.db, bad.statementId);
  }
  saveStatement(collector.db, bank, goodMorning(), { name: 'today2-m2-1.csv', hash: 'm2-1-good' });
  const cLine = collector.db.get<{ id: string }>(`SELECT id FROM bank_statement_lines WHERE deleted_at IS NULL`)!.id;
  approveCollection(collector.db, cLine, { kind: 'installments', contractId: contracts[1], installmentIds: [firstInst(collector.db, contracts[1])] });
  await collector.sync();
  await ownerSync(); await ownerSync();

  const view = {
    livePayments: O.all<{ c: string }>(`SELECT contract_id AS c FROM contract_payments WHERE cancelled_at IS NULL`).map((x) => x.c),
    bank: bankBalance(O, bank),
    rejectedEntries: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'journal_entries'`)!.n),
  };
  O.close(); collector.db.close();
  return { view, contracts };
}

test('M2-1 · [ضابط] بلا الكشف المحذوف: تحصيل المحصِّل الثاني للإيداع نفسه مرفوض على جهاز المالك', async () => {
  const { view, contracts } = await run(false);
  expect(view).toEqual({ livePayments: [contracts[0]], bank: 350000, rejectedEntries: 1 });
});

test('M2-1 · [عالٍ] كشفٌ حذفه المحصِّل في الوارد لا يجيز تحصيلاً ثانياً للإيداع نفسه على جهاز المالك', async () => {
  const { view, contracts } = await run(true);
  // (الواقع: الدفعتان حيّتان، والبنك 600,000، ولا قيد مرفوض)
  expect(view).toEqual({ livePayments: [contracts[0]], bank: 350000, rejectedEntries: 1 });
});
