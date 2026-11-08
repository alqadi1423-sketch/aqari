/**
 * المدقق I2 · الجولة الثامنة عشرة · على ae6765f · الحفظ (freshLines بعد الجولة السابعة عشرة) يحفظ ثلاث حوالاتٍ بالمبلغ نفسه في اليوم نفسه،
 * ومرور التوأم في المزامنة (keepInOrder) لا يرى إلا اثنتين: جهاز المالك يحذف حوالةً حقيقية ويرفع حذفها، وينقل بيانها إلى حوالةٍ أخرى ·
 * بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditI2.syncTearsSave.test.ts
 *
 * I2-3 · عالٍ · src/domain/bankStatement/dedupe.ts:71-76 (keepInOrder: «k» ذوات الرصيد الحيّة وحدها، و«#n» لا يجاوزها يبقى منه ما يكمل need)
 * مع dedupe.ts:108-113 (statementsNeed: أكبر عددٍ في كشفٍ واحد) وsrc/sync/engine.ts:1073-1075 (statementLineFix: مرور التوأم) و
 * engine.ts:1089-1094 (ما لم يُبقِه يُحذف ويرفعه جهاز المالك تصحيحاً) وengine.ts:1078-1083 (G2-5: بيان المحذوف يُنسخ إلى سطر العضو الباقي) · خلاف
 * dedupe.ts:153-154 (freshLines يعدّ ذوات الرصيد المختلفة في الملف ولو لم يحفظها):
 * موظف البنوك (البنوك ٢) يحفظ لشهر أكتوبر ثلاثة ملفات · صورة الصفحة الأولى (رسم 30 سبتمبر وحوالة ماجد 2,500 برصيد 3,500) · ثم تصدير
 * الصباح بلا رصيد وفيه حوالتا ماجد وسالم «#1» و«#2» · ثم صورة الصفحة الثانية (سالم برصيد 6,000 وفهد برصيد 8,500 ورسم 2 أكتوبر) · الحفظ
 * صحيح: ماجد «@350000» وسالم «#2» وفهد «@850000» والرسمان، وتقرير أكتوبر عنده بلا فرقٍ غير مفسَّر · يرفع · جهاز المالك يرى في القاعدة ذاتي
 * رصيد و«#2» لا يجاوزهما، وأكبر عددٍ في كشفٍ واحد 2، فيحذف حوالة سالم ويرفع حذفها، ويكتب بيانها «TRANSFER SALEM» على حوالة فهد ·
 * فيصل الحذف إلى جهاز الموظف: على الجهازين حوالتان من ثلاث، وفهد صار «سالم»، وتقرير أكتوبر بفرقٍ «غير مفسَّر» 2,500 · ورصيد 6,000 في
 * بصمات الصفحة الثانية (shared_keys) يشهد أن «#2» حوالةٌ ثالثة، لكن مرور التوأم يعدّ ذوات الرصيد من السطور الحيّة وحدها.
 * لماذا يهم: قاعدتا الحفظ والمزامنة يجب أن تتفقا (سجل القرارات ٦٤(١): «فتُبقي الأجهزة كلها السطور نفسها»)، وإصلاح G2-1 جعل الحفظ يعدّ ما
 * لا يعدّه مرور التوأم · إيداعٌ حقيقي يُحذف من كل الأجهزة بمزامنةٍ عادية لحفظٍ صحيح (كـC2-1 وE2-1)، وبيان الدافع ينتقل إلى إيداعٍ آخر:
 * إيداع فهد يحمل اسم سالم، وبالاسم في البيان يُبنى اقتراح التحصيل · والتقرير بفرقٍ لا يدلّ على سطر.
 * السلوك الصحيح: ما يحفظه الحفظ بقاعدته لا يحذفه مرور التوأم: بعد المزامنة على الجهازين حوالات ماجد وسالم وفهد ببياناتها، وتقرير أكتوبر بلا
 * فرقٍ غير مفسَّر.
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

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditG2.manualMatch.test.ts */
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
// سطرٌ بعرضه من طول نصه كما في tests/d4.auditG2.freshDayEnd.test.ts
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
const page1 = () => ok(readStatementPhoto([
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('1,005.00', 880, 80),
  ln('30/09/2026', 40, 100), ln('SMS CHARGES', 200, 100), ln('5.00', 560, 100), ln('1,000.00', 880, 100),
  ln('01/10/2026', 40, 120), ln('TRANSFER MAJED', 200, 120), ln('2,500.00', 720, 120), ln('3,500.00', 880, 120),
  ln('Closing Balance', 40, 160), ln('3,500.00', 880, 160),
  ln('Page 1 of 2', 40, 220),
]));
/** تصدير الصباح بلا عمود رصيد: حوالتا ماجد وسالم */
const morning = () => ok(readStatementFile({ name: 'today.csv', bytes: new TextEncoder().encode([
  'Date,Description,Debit,Credit', '01/10/2026,TRANSFER MAJED,,2500.00', '01/10/2026,TRANSFER SALEM,,2500.00'].join('\n')) },
{ opening: 100000, closing: 600000 }));
const page2 = () => ok(readStatementPhoto([
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('3,500.00', 880, 80),
  ln('01/10/2026', 40, 100), ln('TRANSFER SALEM', 200, 100), ln('2,500.00', 720, 100), ln('6,000.00', 880, 100),
  ln('01/10/2026', 40, 120), ln('TRANSFER FAHD', 200, 120), ln('2,500.00', 720, 120), ln('8,500.00', 880, 120),
  ln('02/10/2026', 40, 140), ln('SMS CHARGES', 200, 140), ln('5.00', 560, 140), ln('8,495.00', 880, 140),
  ln('Closing Balance', 40, 180), ln('8,495.00', 880, 180),
  ln('Page 2 of 2', 40, 220),
]));
/** حوالات 1 أكتوبر الحيّة بأرصدتها وبياناتها */
const oct1 = (db: DB, bank: string) => db.all<{ d: string; b: number | null }>(
  `SELECT descr AS d, balance_halalas AS b FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL AND date = '2026-10-01'
   AND amount_halalas = 250000 ORDER BY descr`, [bank]).map((x) => x.d + (x.b == null ? '' : '@' + x.b));

test('I2-3 · [عالٍ] ثلاث حوالاتٍ حفظها موظف البنوك صحيحةً (صفحة، تصدير بلا رصيد، صفحة): جهاز المالك لا يحذف إحداها والتقرير بلا فرق', async () => {
  const ORG = 'owner-i2-3';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع I2-3', 100000);
  await ownerSync();
  const clerk = memberDevice(r, ORG, 'member-i2-3', { banks: 2 });
  await clerk.sync(); await clerk.sync();

  saveStatement(clerk.db, bank, page1(), { name: 'oct-i2-3-p1.jpg', hash: 'i2-3-p1' });
  saveStatement(clerk.db, bank, morning(), { name: 'today-i2-3.csv', hash: 'i2-3-today' });
  saveStatement(clerk.db, bank, page2(), { name: 'oct-i2-3-p2.jpg', hash: 'i2-3-p2' });
  // (الحفظ صحيح: ثلاث حوالات، والتقرير عند الموظف بلا فرق)
  expect({ lines: oct1(clerk.db, bank), unexplained: reconciliation(clerk.db, bank, '2026-10').unexplained })
    .toEqual({ lines: ['TRANSFER FAHD@850000', 'TRANSFER MAJED@350000', 'TRANSFER SALEM'], unexplained: 0 });

  await clerk.sync(); await clerk.sync();
  await ownerSync(); await ownerSync();
  await clerk.sync(); await clerk.sync();

  const view = (db: DB) => ({ lines: oct1(db, bank), unexplained: reconciliation(db, bank, '2026-10').unexplained });
  // (الواقع على الجهازين: ['TRANSFER MAJED@350000', 'TRANSFER SALEM@850000'] والفرق غير المفسَّر 250,000 هللة)
  expect({ owner: view(O), clerk: view(clerk.db) }).toEqual({
    owner: { lines: ['TRANSFER FAHD@850000', 'TRANSFER MAJED@350000', 'TRANSFER SALEM'], unexplained: 0 },
    clerk: { lines: ['TRANSFER FAHD@850000', 'TRANSFER MAJED@350000', 'TRANSFER SALEM'], unexplained: 0 },
  });
  O.close(); clerk.db.close();
});
