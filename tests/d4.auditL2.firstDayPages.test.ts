/**
 * المدقق L2 · الجولة التاسعة عشرة · على 5c203a6 · إصلاح J2-2 (افتتاحيٌّ لم يتّصل ينتقل إلى ما بعده) ومعه «بلا جارٍ يُقدَّم الافتتاحي الذي يتسلسل
 * منه سطر» يأخذان أول افتتاحيٍّ في ترتيب الحفظ إن تسلسل من افتتاحيين سطران في اليوم نفسه · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditL2.firstDayPages.test.ts
 *
 * L2-2 · متوسط · src/domain/bankStatement/store.ts:292-293 («os.findIndex((x) => ls.some(chainsFrom(x.open!)))»: أول افتتاحيٍّ يتسلسل منه سطر،
 * بترتيب «ORDER BY period_from, created_at, id» في store.ts:252) مع store.ts:279 (لا جاري قبل أول كشفٍ للبنك فلا افتتاحيَّ «عند الرصيد نفسه»):
 * أول كشفٍ يُحفظ للبنك صفحتان مصوَّرتان، وفاصل الصفحتين في أول يوم حركات (15 أكتوبر: يوم إيجاراتٍ كثيرة) · الأولى افتتاحي 1,000 وحوالتا
 * ماجد وسالم (3,500 ثم 6,000) و«رصيد مرحَّل» 6,000، والثانية «رصيد منقول» 6,000 وحوالة فهد يوم 15 (8,500) ورسوم 20 أكتوبر (8,495) والختامي ·
 * فترة الصفحتين تبدأ يوم 15 كلتيهما، فيوم 15 بلا جارٍ وفيه افتتاحيان يتسلسل من كلٍّ منهما سطر: 1,000 (حوالة ماجد) و6,000 (حوالة فهد) · بحفظ
 * الثانية أولاً يُؤخذ 6,000 أولاً: افتتاحي أكتوبر 6,000 بدل 1,000، و«فجوة» (ختامي 8,500 وافتتاحي 1,000)، و«غير مفسَّر» −5,000 · وبحفظ الأولى
 * أولاً يصح (الضابط) · (ومثله صفحةٌ ثانية افتتاحيها يساوي رصيد سطرٍ من سطور اليوم الأول في الأولى: رصيدٌ يعود إلى قيمته بإيجارٍ ثم تحويلٍ
 * للمالك · وبجارٍ من كشفٍ قبلهما لا يقع: الافتتاحي عند الرصيد نفسه يؤخذ.)
 * لماذا يهم: أول كشفٍ لكل بنكٍ في التطبيق بلا جارٍ قبله، وتصوير الصفحات بأي ترتيب هو مسار الصورة، وأول الشهر ومنتصفه أكثر الأيام حركاتٍ في
 * العقار المؤجَّر · وD2-1 قرّر «الكشف نفسه يعطي التقرير نفسه أياً كان ترتيب حفظه»، فيُنبَّه تقرير الشهر بفجوةٍ وفرقٍ غير مفسَّر لا وجود
 * لهما ويخطئ افتتاحيه بحسب أيّ الصفحتين صُوّرت أولاً.
 * السلوك الصحيح (D2-1: «افتتاحي الكشف حيث يتّصل»): من افتتاحيين يتسلسل منهما سطران يُقدَّم ما ليس رصيداً مطبوعاً لسطرٍ آخر في يومه (6,000
 * رصيد حوالة سالم فهو منتصف السلسلة لا أولها) أو ما تطول به السلسلة · بالترتيبين: أكتوبر من 1,000 إلى 8,495، بلا فجوة، وغير المفسَّر صفر.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';

/** سطرٌ بعرضه من طول نصه كما في tests/d4.auditJ2.pagePeriod.test.ts */
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
const page1: OcrLine[] = [
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('1,000.00', 880, 80),
  ln('15/10/2026', 40, 100), ln('TRANSFER MAJED', 200, 100), ln('2,500.00', 720, 100), ln('3,500.00', 880, 100),
  ln('15/10/2026', 40, 140), ln('TRANSFER SALEM', 200, 140), ln('2,500.00', 720, 140), ln('6,000.00', 880, 140),
  ln('Balance Carried Forward', 40, 180), ln('6,000.00', 880, 180),
  ln('Page 1 of 2', 40, 260),
];
const page2: OcrLine[] = [
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Balance Brought Forward', 40, 80), ln('6,000.00', 880, 80),
  ln('15/10/2026', 40, 100), ln('TRANSFER FAHAD', 200, 100), ln('2,500.00', 720, 100), ln('8,500.00', 880, 100),
  ln('20/10/2026', 40, 140), ln('SMS CHARGES', 200, 140), ln('5.00', 560, 140), ln('8,495.00', 880, 140),
  ln('Closing Balance', 40, 180), ln('8,495.00', 880, 180),
  ln('Page 2 of 2', 40, 260),
];
const read = (p: OcrLine[]) => { const r = readStatementPhoto(p); if (!r.ok) throw new Error('لم تُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار

function report(order: Array<'p1' | 'p2'>) {
  // (وقت الحفظ يتقدّم ثانيةً بين الصفحتين فيكون ترتيب «created_at» ترتيب الحفظ لا تساوياً يحسمه المعرّف)
  jest.useFakeTimers({ now: new Date('2026-11-08T09:00:00Z') });
  try {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع L2-2', 0);
    order.forEach((k, i) => {
      jest.setSystemTime(new Date(Date.UTC(2026, 10, 8, 9, 0, i)));
      saveStatement(db, bank, read(k === 'p1' ? page1 : page2), { name: `oct-${k}.jpg`, hash: `l2-2-${k}` });
    });
    const rep = reconciliation(db, bank, '2026-10');
    db.close();
    return { opening: rep.statementOpening, closing: rep.statementClosing, gaps: rep.gaps, unexplained: rep.unexplained };
  } finally { jest.useRealTimers(); }
}
const want = { opening: 100000, closing: 849500, gaps: [], unexplained: 0 };

describe('L2-2 · [متوسط] أول كشفٍ للبنك صفحتان وفاصلهما في يوم الحركات الأول: أول افتتاحيٍّ حفظاً يُؤخذ فيخطئ التقرير بترتيب الحفظ (store.ts:292-293)', () => {
  test('القراءة سليمة: الأولى من 1,000 إلى 6,000، والثانية من 6,000 إلى 8,495، وفترتاهما تبدآن يوم 15', () => {
    const [a, b] = [read(page1), read(page2)];
    expect([a.opening, a.closing, a.from, b.opening, b.closing, b.from]).toEqual([100000, 600000, '2026-10-15', 600000, 849500, '2026-10-15']);
  });

  test('الضابط: الأولى ثم الثانية', () => {
    expect(report(['p1', 'p2'])).toEqual(want);
  });

  test('الثانية ثم الأولى: التقرير نفسه (لا افتتاحي 6,000 ولا فجوة ولا فرق غير مفسَّر)', () => {
    // (الواقع: opening 600000، وفجوة { after: '2026-10-15', closing: 850000, nextOpening: 100000 }، وunexplained −500000)
    expect(report(['p2', 'p1'])).toEqual(want);
  });
});
