/**
 * المدقق K2 · الجولة التاسعة عشرة · على 5c203a6 · ما يحفظه إصلاح I2-2 (تصدير الصباح ثم صورتا الصفحتين) يحذفه مرور التوأم في المزامنة:
 * عدّ الحفظ يقرأ بصمات الكشوف الحيّة للبنك كلها، وعدّ المزامنة يقرأ بصمات كشوف السطور الحيّة في القاعدة وحدها · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditK2.syncSkipsPage.test.ts
 *
 * K2-1 · عالٍ · src/sync/engine.ts:1089-1095 (statementLineFix: need = statementsNeed(db, all.map((x) => x.st)) بكشوف السطور الحيّة في القاعدة
 * وحدها، ثم keepInOrder يحذف ما لم يُبقِه ويرفعه جهاز المالك) مع engine.ts:1202 (dupOfLive بالقاعدة نفسها) · خلاف
 * src/domain/bankStatement/store.ts:39-41 (saveStatement: statementsKnown بالكشوف الحيّة للبنك كلها «liveStatements») و
 * src/domain/bankStatement/dedupe.ts:119-129 (statementsKnown يجمع ذوات الرصيد من الكشوف المعطاة وحدها):
 * موظف البنوك (البنوك ٢) يحفظ بترتيب I2-2 نفسه: تصدير الصباح بلا رصيد (حوالة ماجد «#1») ثم صورة الصفحة الأولى (رسم 30 سبتمبر، وحوالة ماجد
 * «@350000» تُتخطّى لأنها «#1» المحفوظة) ثم صورة الصفحة الثانية (حوالة سالم «@600000» ورسم 2 أكتوبر) · الحفظ صحيح بعد إصلاح I2-2: حوالتان
 * حيّتان (ماجد «#1» وسالم «@600000») والتقرير بلا فرق · يرفع · جهاز المالك يطبّق السطرين: الصفحة الأولى ليس لها سطرٌ حيٌّ في القاعدة (سطرها
 * تُخطّي)، فلا تدخل need، وكشفا السطرين الحيّين فيهما بصمةٌ واحدة للقاعدة وذات رصيدٍ واحدة، فـneed = 1 و«#1» لا يجاوز ذوات الرصيد ← تُحذف
 * حوالة ماجد، ويُكتب بيانها «TRANSFER MAJED» على حوالة سالم (G2-5) ويُرفع، فعند الموظف حوالة سالم «ماجد» أيضاً والجهازان مختلفان · و«@350000»
 * في بصمات الصفحة الأولى (shared_keys) يشهد أنها حوالةٌ ثانية.
 * لماذا يهم: هو I2-3 (عالٍ) بترتيب I2-2 نفسه: إصلاح الجولة الثامنة عشرة جعل الحفظ يعدّ بصمات الكشوف الحيّة كلها، والمزامنة ما زالت تعدّ
 * كشوف السطور الحيّة وحدها، فقاعدتا الحفظ والمزامنة تختلفان ثانيةً (سجل القرارات ٦٧(١): «في الحفظ والمزامنة … في الكشوف الحيّة كلها») ·
 * إيداعٌ حقيقي يُحذف من كل الأجهزة بمزامنةٍ عادية لحفظٍ صحيح، والتقرير بفرقٍ «غير مفسَّر» 2,500 لا يدلّ على سطر، ولا علاج من الشاشة (الملفات
 * الثلاثة «قُرئت من قبل») · وليس من «جهازي المالك بلا حَكَم» (§٥ · ٢): الكاتب عضو، والحذف يكتبه جهاز المالك.
 * السلوك الصحيح: ما يحفظه الحفظ بقاعدته لا يحذفه مرور التوأم: بعد المزامنة على الجهازين حوالتا ماجد وسالم حيّتان، وتقرير أكتوبر بلا فرقٍ غير
 * مفسَّر.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { readStatementFile, type StatementResult } from '@/domain/bankStatement/read';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditI2.syncTearsSave.test.ts */
function memberDevice(r: MemoryRemote, org: string, uid: string, perms: Access['perms']) {
  const M: Access = { owner: false, uid, perms, allProps: true, props: [] };
  const db = memDb();
  enableSync(db, uid);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org, profile: { name: 'موظف مصطنع' } })]);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [org]);
  const sync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(db, r, getMeta(db, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  return { db, sync };
}
const ok = (r: StatementResult) => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار
// سطرٌ بعرضه من طول نصه كما في tests/d4.auditI2.pagesAfterMorning.test.ts
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
/** تصدير الصباح بلا عمود رصيد: حوالة ماجد وحدها */
const morning = () => ok(readStatementFile({ name: 'today.csv', bytes: new TextEncoder().encode([
  'Date,Description,Debit,Credit', '01/10/2026,TRANSFER MAJED,,2500.00'].join('\n')) }, { opening: 100000, closing: 350000 }));
/** صورة الصفحة الأولى: رسم 30 سبتمبر ثم حوالة ماجد برصيدها */
const page1 = () => ok(readStatementPhoto([
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('1,005.00', 880, 80),
  ln('30/09/2026', 40, 100), ln('SMS CHARGES', 200, 100), ln('5.00', 560, 100), ln('1,000.00', 880, 100),
  ln('01/10/2026', 40, 120), ln('TRANSFER MAJED', 200, 120), ln('2,500.00', 720, 120), ln('3,500.00', 880, 120),
  ln('Closing Balance', 40, 160), ln('3,500.00', 880, 160),
  ln('Page 1 of 2', 40, 220),
]));
/** صورة الصفحة الثانية: تبدأ بحوالة سالم برصيدها، ثم رسم 2 أكتوبر */
const page2 = () => ok(readStatementPhoto([
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('3,500.00', 880, 80),
  ln('01/10/2026', 40, 100), ln('TRANSFER SALEM', 200, 100), ln('2,500.00', 720, 100), ln('6,000.00', 880, 100),
  ln('02/10/2026', 40, 120), ln('SMS CHARGES', 200, 120), ln('5.00', 560, 120), ln('5,995.00', 880, 120),
  ln('Closing Balance', 40, 160), ln('5,995.00', 880, 160),
  ln('Page 2 of 2', 40, 220),
]));
/** حوالات 1 أكتوبر الحيّة بأرصدتها وبياناتها */
const oct1 = (db: DB, bank: string) => db.all<{ d: string; b: number | null }>(
  `SELECT descr AS d, balance_halalas AS b FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL AND date = '2026-10-01'
   AND amount_halalas = 250000 ORDER BY descr`, [bank]).map((x) => x.d + (x.b == null ? '' : '@' + x.b));

test('K2-1 · [عالٍ] تصدير الصباح ثم صورتا الصفحتين (ترتيب I2-2) يحفظها موظف البنوك صحيحةً: جهاز المالك لا يحذف حوالة ماجد والتقرير بلا فرق', async () => {
  const ORG = 'owner-k2-1';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع K2-1', 100000);
  await ownerSync();
  const clerk = memberDevice(r, ORG, 'member-k2-1', { banks: 2 });
  await clerk.sync(); await clerk.sync();

  saveStatement(clerk.db, bank, morning(), { name: 'today-k2-1.csv', hash: 'k2-1-today' });
  saveStatement(clerk.db, bank, page1(), { name: 'oct-k2-1-p1.jpg', hash: 'k2-1-p1' });
  saveStatement(clerk.db, bank, page2(), { name: 'oct-k2-1-p2.jpg', hash: 'k2-1-p2' });
  // (الحفظ صحيح بعد إصلاح I2-2: حوالتان، والتقرير عند الموظف بلا فرق)
  expect({ lines: oct1(clerk.db, bank), unexplained: reconciliation(clerk.db, bank, '2026-10').unexplained })
    .toEqual({ lines: ['TRANSFER MAJED', 'TRANSFER SALEM@600000'], unexplained: 0 });

  await clerk.sync(); await clerk.sync();
  await ownerSync(); await ownerSync();
  await clerk.sync(); await clerk.sync();

  const view = (db: DB) => ({ lines: oct1(db, bank), unexplained: reconciliation(db, bank, '2026-10').unexplained });
  // (الواقع: المالك ['TRANSFER MAJED@600000'] بفرقٍ غير مفسَّر 250,000 هللة · حوالة ماجد «#1» محذوفة وبيانها على حوالة سالم (G2-5)، والموظف
  // ['TRANSFER MAJED', 'TRANSFER MAJED@600000']: سالم صار «ماجد» عنده أيضاً، والجهازان مختلفان)
  expect({ owner: view(O), clerk: view(clerk.db) }).toEqual({
    owner: { lines: ['TRANSFER MAJED', 'TRANSFER SALEM@600000'], unexplained: 0 },
    clerk: { lines: ['TRANSFER MAJED', 'TRANSFER SALEM@600000'], unexplained: 0 },
  });
  O.close(); clerk.db.close();
});
