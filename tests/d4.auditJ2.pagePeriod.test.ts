/**
 * المدقق J2 · الجولة الثامنة عشرة · على ae6765f · إصلاح D2-1 (افتتاحي صفحةٍ تبدأ في منتصف اليوم حيث يتّصل) لا يعمل إن طبعت كل صفحةٍ فترة
 * الكشف في رأسها: افتتاحي الصفحة الثانية («رصيد منقول») يُؤرَّخ بأول الفترة فيوضع أول الشهر · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditJ2.pagePeriod.test.ts
 *
 * J2-2 · عالٍ · src/domain/bankStatement/store.ts:248-250 (حدث الافتتاحي بتاريخ «period_from») وstore.ts:259-262 (الافتتاحي لا يُنظر فيه إلا في
 * يومه) وstore.ts:277 (أول الأيام بلا جارٍ: «take(os, 0)» أسبق الكشفين حفظاً) وstore.ts:291 (الافتتاحي الباقي آخر يومه يصير الجاري) مع
 * read.ts:347-353 (periodOf: الفترة المطبوعة تحوي سطور الصفحة فتُحفظ «01/10 – 31/10» للصفحة الثانية أيضاً): كشف D2-1 نفسه صفحتان مصوَّرتان
 * (المسار المعتاد منذ Z1-2)، وفي رأس كلٍّ منهما «Statement Period 01/10/2026 - 31/10/2026» كما تطبعه الكشوف في كل صفحة · الأولى افتتاحي 1,000
 * ورسوم 3 أكتوبر (995) وحوالتا 31 أكتوبر (5,995) و«رصيد مرحَّل»، والثانية «رصيد منقول» 5,995 وحوالة 31 أكتوبر (8,495) · فيصير افتتاحي الثانية
 * حدثاً يوم 1 أكتوبر:
 *  أ) الأولى ثم الثانية: «فجوة» يوم 1 أكتوبر (ختامي 1,000 وافتتاحي 5,995، وتاريخها فارغ).
 *  ب) الثانية ثم الأولى: افتتاحي أكتوبر 5,995 بدل 1,000، و«غير مفسَّر» −4,995، وفجوة.
 *  (والصفحتان بلا صفّ الفترة يصح تقريرهما بالترتيبين: الضابط، وهو اختبار D2-1.)
 * لماذا يهم: الفترة ورقم الحساب في رأس كل صفحة هو الغالب في الكشوف، وتصوير الصفحات واحدةً واحدة هو مسار الصورة؛ فيخطئ افتتاحي الشهر ويُنبَّه
 * بفرقٍ «غير مفسَّر» وفجوةٍ لا وجود لهما بحسب أيّ الصفحتين صُوّرت أولاً، وهو ما قرّر D2-1 ألّا يكون.
 * السلوك الصحيح (D2-1): الكشف نفسه يعطي التقرير نفسه أياً كان ترتيب حفظ صفحاته، وافتتاحي الصفحة حيث يتّصل (عند رصيدٍ يساويه أو قبل سطرٍ يتسلسل
 * منه) لا في أول فترتها: أكتوبر من 1,000 إلى 8,495، بلا فجوة، وغير المفسَّر صفر (الدفاتر فارغة فالسطور الأربعة «في الكشف وحده»).
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';

/** سطرٌ بعرضه من طول نصه (عشر نقاطٍ للحرف) كما في tests/d4.auditD2.reconTimeline.test.ts */
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
const periodRow = [ln('Statement Period', 40, 30), ln('01/10/2026', 300, 30), ln('-', 420, 30), ln('31/10/2026', 460, 30)];
const page1 = (period: boolean): OcrLine[] => [
  ...(period ? periodRow : []),
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('1,000.00', 880, 80),
  ln('03/10/2026', 40, 100), ln('SMS CHARGES', 200, 100), ln('5.00', 560, 100), ln('995.00', 880, 100),
  ln('31/10/2026', 40, 140), ln('TRANSFER MAJED', 200, 140), ln('2,500.00', 720, 140), ln('3,495.00', 880, 140),
  ln('31/10/2026', 40, 180), ln('TRANSFER SALEM', 200, 180), ln('2,500.00', 720, 180), ln('5,995.00', 880, 180),
  ln('Balance Carried Forward', 40, 220), ln('5,995.00', 880, 220),
  ln('Page 1 of 2', 40, 260),
];
const page2 = (period: boolean): OcrLine[] => [
  ...(period ? periodRow : []),
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Balance Brought Forward', 40, 80), ln('5,995.00', 880, 80),
  ln('31/10/2026', 40, 100), ln('TRANSFER FAHAD', 200, 100), ln('2,500.00', 720, 100), ln('8,495.00', 880, 100),
  ln('Closing Balance', 40, 180), ln('8,495.00', 880, 180),
  ln('Page 2 of 2', 40, 260),
];
const read = (p: OcrLine[]) => { const r = readStatementPhoto(p); if (!r.ok) throw new Error('لم تُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار

function report(order: Array<'p1' | 'p2'>, period: boolean) {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع J2-2', 0);
  for (const k of order) saveStatement(db, bank, read(k === 'p1' ? page1(period) : page2(period)), { name: `oct-${k}.jpg`, hash: `j2-2-${k}-${period}` });
  const rep = reconciliation(db, bank, '2026-10');
  db.close();
  return { opening: rep.statementOpening, closing: rep.statementClosing, gaps: rep.gaps, unexplained: rep.unexplained };
}
const want = { opening: 100000, closing: 849500, gaps: [], unexplained: 0 };

describe('J2-2 · [عالٍ] صفحاتٌ مصوَّرة تطبع فترة الكشف: افتتاحي الصفحة الثانية يوضع أول الفترة فيخطئ التقرير بترتيب الحفظ (store.ts:248-262 و277 و291)', () => {
  test('القراءة سليمة: الأولى من 1,000 إلى 5,995، والثانية تبدأ من 5,995 في يوم 31', () => {
    // (وفترة الصفحتين كلتيهما تُقرأ «2026-10-01 – 2026-10-31» من صفّ الفترة: منها يُؤرَّخ افتتاحي الثانية أول الشهر)
    const [a, b] = [read(page1(true)), read(page2(true))];
    expect([a.opening, a.closing, b.opening, b.lines.map((l) => [l.date, l.amount, l.balance])]).toEqual([
      100000, 599500, 599500, [['2026-10-31', 250000, 849500]]]);
  });

  test('الضابط: بلا صفّ الفترة يصح التقرير بالترتيبين (D2-1)', () => {
    expect([report(['p1', 'p2'], false), report(['p2', 'p1'], false)]).toEqual([want, want]);
  });

  test('أ) بصفّ الفترة، الأولى ثم الثانية: لا فجوة', () => {
    // (الواقع: gaps = [{ after: '', closing: 100000, nextOpening: 599500 }])
    expect(report(['p1', 'p2'], true)).toEqual(want);
  });

  test('ب) بصفّ الفترة، الثانية ثم الأولى: افتتاحي أكتوبر 1,000 لا 5,995، وغير المفسَّر صفر', () => {
    // (الواقع: opening 599500، وunexplained −499500، وفجوة { after: '', closing: 599500, nextOpening: 100000 })
    expect(report(['p2', 'p1'], true)).toEqual(want);
  });
});
