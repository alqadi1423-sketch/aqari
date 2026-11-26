/**
 * المدقق I2 · الجولة الثامنة عشرة · على ae6765f · تصديرٌ بلا رصيد أُخذ صباحاً ثم صورتا صفحتي الكشف: حوالةٌ ثانية بالمبلغ نفسه في اليوم
 * نفسه في الصفحة الثانية لا تُحفظ أبداً، وتُحفظ لو حُفظت الصفحة الأولى قبل التصدير · بياناتٌ مصطنعة كلها، وجهازٌ واحد.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditI2.pagesAfterMorning.test.ts
 *
 * I2-2 · عالٍ · src/domain/bankStatement/dedupe.ts:153-155 (freshLines: «balanced» ذوات الرصيد المختلفة في المحفوظ وفي هذا الملف وحدهما،
 * فذو رصيدٍ في كشفٍ حيٍّ سابق قابله عند حفظه سطرٌ بلا رصيد فلم يُحفظ لا يُعدّ، وبصماته في shared_keys لا تُقرأ) مع
 * src/domain/bankStatement/store.ts:36-39 (saveStatement يمرّر سطور البنك الحيّة وحدها):
 * يوم 1 أكتوبر حوالتا إيجار بـ2,500: ماجد ثم سالم، وبينهما فاصل الصفحة في كشف الشهر الورقي · المستخدم حفظ صباحاً تصديراً بلا رصيد فيه
 * حوالة ماجد وحدها «#1» (كما في G2-1أ وE2-1ج) · ثم يصوّر الصفحة الأولى (رسم 30 سبتمبر وحوالة ماجد برصيد 3,500) فتُحفظ بالرسم، وحوالة ماجد
 * «@350000» هي «#1» المحفوظة (صحيح) · ثم يصوّر الصفحة الثانية (حوالة سالم برصيد 6,000 ورسم 2 أكتوبر) فيعدّ freshLines «@600000» هي «#1»
 * نفسها أيضاً: ذوات الرصيد عنده واحدة («@600000» وحدها)، لأن «@350000» في بصمات الصفحة الأولى لا في المحفوظ · «أُضيف 1، تُخطّي 1» وحوالة
 * سالم لا سطر لها، وتقرير أكتوبر بفرقٍ «غير مفسَّر» 2,500 · وبأي ترتيبٍ آخر للملفات الثلاثة (الصفحة الأولى قبل التصدير، أو التصدير أخيراً)
 * تُحفظ الحوالتان والتقرير بلا فرق (جُرّب: «m,p1,p2» و«m,p2,p1» حوالةٌ واحدة، و«p1,m,p2» و«p2,m,p1» و«p1,p2,m» حوالتان).
 * لماذا يهم: هو G2-1 (إصلاح الجولة السابعة عشرة) بثلاثة ملفات بدل اثنين، وكلها مسارات مدعومة شائعة: تصدير اليوم بلا رصيد، وصورة كل صفحةٍ
 * من الكشف الورقي، وأول الشهر حوالاتٌ كثيرة بالإيجار نفسه · وDESIGN §١٣.٢٢ وسجل القرارات ٦٤(١): «بقاعدةٍ لا يغيّرها ترتيب الوصول»، و«برصيدين
 * حوالتان» · إيداعٌ حقيقي لا يظهر في الكشف، فلا يُقترح له تحصيل ويبقى المستأجر مطالَباً بما دفع، والتقرير بفرقٍ لا يدلّ على سطر · ولا علاج
 * من الشاشة: الصورة نفسها «قُرئت من قبل»، وحذفها وإعادة قراءتها تتخطّى الحوالة ثانيةً.
 * السلوك الصحيح: ذوات الرصيد المختلفة في كل كشفٍ حيٍّ للبنك (بصماته) تُعدّ حركاتٍ مختلفة عند الحفظ أياً كان ترتيبه: بعد الملفات الثلاثة
 * حوالتا 1 أكتوبر حيّتان، وتقرير أكتوبر بلا فرقٍ غير مفسَّر.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementFile, type StatementResult } from '@/domain/bankStatement/read';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';
import type { DB } from '@/db/adapter';

const ok = (r: StatementResult) => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار
// سطرٌ بعرضه من طول نصه كما في tests/d4.auditG2.freshDayEnd.test.ts
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
const depositsOct1 = (db: DB, bank: string) => Number(db.get<{ n: number }>(
  `SELECT COUNT(*) AS n FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL AND date = '2026-10-01' AND amount_halalas = 250000`, [bank])!.n);

test('I2-2 · [عالٍ] تصدير الصباح بلا رصيد (ماجد) ثم صورة الصفحة الأولى (ماجد برصيده) ثم الثانية (سالم برصيده): حوالتا 1 أكتوبر محفوظتان ولا فرق غير مفسَّر', () => {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع I2-2', 100000);
  // (القراءة: الصورتان سليمتان بأرصدتهما، والتصدير بلا رصيد)
  expect([morning().lines.map((l) => [l.date, l.amount, l.balance]), page1().lines.map((l) => [l.date, l.amount, l.balance]),
    page2().lines.map((l) => [l.date, l.amount, l.balance])]).toEqual([
    [['2026-10-01', 250000, null]],
    [['2026-09-30', -500, 100000], ['2026-10-01', 250000, 350000]],
    [['2026-10-01', 250000, 600000], ['2026-10-02', -500, 599500]],
  ]);
  saveStatement(db, bank, morning(), { name: 'today-i2-2.csv', hash: 'i2-2-today' });
  saveStatement(db, bank, page1(), { name: 'oct-i2-2-p1.jpg', hash: 'i2-2-p1' });
  const p2 = saveStatement(db, bank, page2(), { name: 'oct-i2-2-p2.jpg', hash: 'i2-2-p2' });

  // (الواقع: الصفحة الثانية «أُضيف 1، تُخطّي 1»، وحوالةٌ واحدة يوم 1 أكتوبر، والفرق غير المفسَّر 250,000 هللة)
  expect({ page2: { added: p2.added, skipped: p2.skipped }, depositsOct1: depositsOct1(db, bank), unexplained: reconciliation(db, bank, '2026-10').unexplained })
    .toEqual({ page2: { added: 2, skipped: 0 }, depositsOct1: 2, unexplained: 0 });
  db.close();
});
