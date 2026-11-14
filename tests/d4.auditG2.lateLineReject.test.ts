/**
 * المدقق G2 · الجولة السابعة عشرة · على 3f2c136 · تحصيلٌ صحيح لإيداعٍ ثانٍ حقيقي بالمبلغ نفسه في اليوم نفسه يرفضه جهاز المالك «تحصيلاً
 * ثانياً» لأن سطره يصل مع قيده فلا يُعدّ في الإيداعات · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditG2.lateLineReject.test.ts
 *
 * G2-4 · عالٍ · src/sync/engine.ts:716-718 (liveDepositCollection: «cap = liveOfBase(...)» عدد إيداعات القاعدة من سطور الجدول وحدها،
 * والسطر الذي قُرئ من الوارد للقيد نفسه (E2-4 · engine.ts:686-693) لا يُعدّ معها، فـ«rows.length >= cap» بتحصيل الإيداع الآخر وحده) مع
 * engine.ts:1980-1985 (رفضٌ نهائي «تحصيلٌ ثانٍ») وsrc/db/syncTables.ts:47 و95 (القيود قبل سطور الكشف في ترتيب التطبيق):
 * يوم 1 أكتوبر حوالتان بالإيجار نفسه (2,500): ماجد ثم سالم · المالك قرأ صباحاً تصديراً بلا رصيد فيه حوالة ماجد وحدها (كما في E2-1ج)
 * واعتمدها تحصيلاً لقسط ماجد، وتزامن معه المحصِّل (البنوك ٣ والتحصيل ٣) · المحصِّل يقرأ كشف الشهر بأرصدته: ماجد «@350000» يُعدّ
 * المحفوظ «#1»، وسالم «@600000» جديد (freshLines صحيح: «أُضيف 2، تُخطّي 1») · يعتمد إيداع سالم لقسط سالم ويرفع الكشف وسطوره والتحصيل
 * معاً · جهاز المالك يطبّق القيد قبل السطر: يجد تحصيل ماجد في القاعدة (اليوم والمبلغ) وسطراً حيّاً واحداً فيها عنده، فيرفض تحصيل سالم
 * «تحصيلٌ ثانٍ للمطالبة أو الفاتورة نفسها» وتسقط حركته، ثم يصل سطر سالم فيبقى حيّاً مفتوحاً · في دفاتر المالك قسط سالم غير مسدَّد والبنك
 * 3,500 ورصيد الكشف آخر يوم 1 أكتوبر 6,000، وعند المحصِّل مسدَّد · ولو وصل الكشف إلى المالك قبل الاعتماد لقُبل التحصيلان (جُرّب): النتيجة بترتيب الوصول، وهو ما
 * أصلحه E2-4 للحالة المعاكسة.
 * لماذا يهم: قراءة الكشف والاعتماد منه في جلسةٍ واحدة هو المسار المعتاد للمحصِّل، وأول الشهر حوالاتٌ كثيرة بالإيجار نفسه في اليوم نفسه،
 * والقراءة الجزئية قبل الكشف (تصدير اليوم أو صورة صفحة) مسارٌ مدعوم · تحصيلٌ صحيح يُرفض بسببٍ يقول إن المال حُصّل مرتين، فيُطالَب
 * المستأجر بما دفع أو يُعاد التسجيل يدوياً، والجهازان مختلفان.
 * السلوك الصحيح: عدد إيداعات القاعدة يعدّ سطر القيد الوارد (من الوارد) ومعه ما في الوارد من سطورها، أو ينتظرها، فلا يتغيّر الحكم بترتيب
 * الوصول: الدفعتان حيّتان (ماجد وسالم) والبنك 6,000، ولا قيد في «المرفوض».
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
import { saveStatement } from '@/domain/bankStatement/store';
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
const ok = (r: StatementResult) => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار

test('G2-4 · [عالٍ] المحصِّل يقرأ كشف الشهر ويعتمد حوالة سالم (والمالك حصّل حوالة ماجد باليوم والمبلغ نفسيهما): جهاز المالك يقبل التحصيلين والبنك 6,000', async () => {
  const ORG = 'owner-g2-4';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع G2-4', 100000);
  const prop = addProperty(O, { name: 'عقار مصطنع G2-4' });
  const contracts: string[] = [];
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    contracts.push(confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'G24-' + n }), {
      tenant, idNumber: '100000440' + n, phone: '050000440' + n, valueHalalas: 3000000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    })));
  }
  const firstInst = (db: DB, c: string) => db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!.id;

  // المالك: تصدير الصباح بلا رصيد (حوالة ماجد وحدها) ويعتمدها لقسط ماجد
  const morning = ok(readStatementFile({ name: 'today.csv', bytes: new TextEncoder().encode([
    'Date,Description,Debit,Credit', '01/10/2026,TRANSFER MAJED,,2500.00'].join('\n')) }, { opening: 100000, closing: 350000 }));
  saveStatement(O, bank, morning, { name: 'today-g2-4.csv', hash: 'g2-4-today' });
  const majedLine = O.get<{ id: string }>(`SELECT id FROM bank_statement_lines`)!.id;
  approveCollection(O, majedLine, { kind: 'installments', contractId: contracts[0], installmentIds: [firstInst(O, contracts[0])] });
  await ownerSync();
  const collector = memberDevice(r, ORG, 'member-g2-4', { banks: 3, collect: 3 });
  await collector.sync(); await collector.sync();

  // المحصِّل: كشف الشهر بأرصدته (ماجد محفوظ، وسالم والرسم جديدان)، ويعتمد اقتراح التحصيل لحوالة سالم
  const month = ok(readStatementFile({ name: 'oct.csv', bytes: new TextEncoder().encode([
    'Date,Description,Debit,Credit,Balance',
    '30/09/2026,Opening Balance,,,1000.00',
    '01/10/2026,TRANSFER MAJED,,2500.00,3500.00',
    '01/10/2026,TRANSFER SALEM,,2500.00,6000.00',
    '02/10/2026,SMS CHARGES,5.00,,5995.00',
  ].join('\n')) }));
  expect(saveStatement(collector.db, bank, month, { name: 'oct-g2-4.csv', hash: 'g2-4-oct' })).toMatchObject({ added: 2, skipped: 1 });
  const sugg = collectionSuggestions(collector.db, bank);
  expect(sugg.map((s) => [s.line.descr, s.target])).toEqual([
    ['TRANSFER SALEM', { kind: 'installments', contractId: contracts[1], installmentIds: [firstInst(collector.db, contracts[1])] }]]);
  approveCollection(collector.db, sugg[0].line.id, sugg[0].target);
  expect(bankBalance(collector.db, bank)).toBe(600000);
  await collector.sync();
  await ownerSync(); await ownerSync();

  const view = {
    payments: O.all<{ t: string }>(`SELECT c.tenant_name AS t FROM contract_payments p JOIN contracts c ON c.id = p.contract_id
      WHERE p.cancelled_at IS NULL ORDER BY c.tenant_name`).map((x) => x.t),
    bank: bankBalance(O, bank),
    rejectedEntries: O.all<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE tbl = 'journal_entries'`).map((x) => x.reason),
  };
  // (الواقع: دفعة ماجد وحدها، والبنك 350,000، وفي المرفوض قيد سالم «تحصيلٌ ثانٍ للمطالبة أو الفاتورة نفسها …»)
  expect(view).toEqual({ payments: ['سالم المصطنع', 'ماجد المصطنع'], bank: 600000, rejectedEntries: [] });
  O.close(); collector.db.close();
});
