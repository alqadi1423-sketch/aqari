/**
 * المدقق N2 · الجولة العشرون · على af2ba1f · إصلاح L2-2 قدّم من افتتاحيَّي أول يومٍ ما «ليس رصيداً مطبوعاً لسطرٍ في يومه»؛ فإن عاد الرصيد في
 * ذلك اليوم إلى افتتاحي الصفحة الأولى نفسه (إيجارٌ يدخل ثم يُحوَّل للمالك) سقط الافتتاحيان كلاهما من الشرط ورجع الاختيار إلى ترتيب الحفظ ·
 * بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditN2.returningOpening.test.ts
 *
 * N2-2 · متوسط · src/domain/bankStatement/store.ts:292-295 («jj: chained(x) && !ls.some((l) => l.balance === x.open)» ثم «j = jj >= 0 ? jj :
 * os.findIndex(chained)» بترتيب «ORDER BY period_from, created_at, id» في store.ts:252): أول كشفٍ للبنك صفحتان مصوَّرتان، وفاصلهما في يوم 15
 * أكتوبر كـL2-2 · الأولى افتتاحي 1,000، ويوم 15: إيجار ماجد 2,500 (3,500) ثم تحويلٌ للمالك 2,500 (1,000) ثم إيجار سالم 5,000 (6,000) و«رصيد
 * مرحَّل» 6,000 · والثانية «رصيد منقول» 6,000 وإيجار فهد 2,500 يوم 15 (8,500) ورسوم 20 أكتوبر (8,495) والختامي · فالافتتاحيان 1,000 و6,000
 * كلاهما رصيدٌ مطبوع لسطرٍ يوم 15، فبحفظ الثانية أولاً يُؤخذ 6,000: افتتاحي أكتوبر 6,000 بدل 1,000، و«فجوة» (ختامي 8,500 وافتتاحي 1,000)،
 * و«غير مفسَّر» −5,000 · وبحفظ الأولى أولاً يصح (الضابط) · والقراءة سليمة.
 * لماذا يهم: هو L2-2 نفسه (D2-1: «الكشف نفسه يعطي التقرير نفسه أياً كان ترتيب حفظه») في أشيع أيام حساب العقار: يدخل الإيجار ويُحوَّل للمالك
 * في اليوم نفسه فيعود الرصيد إلى افتتاحيه · فيُنبَّه تقرير الشهر بفجوةٍ وفرقٍ غير مفسَّر لا وجود لهما بحسب أيّ الصفحتين صُوّرت أولاً.
 * السلوك الصحيح (D2-1 مع L2-2): رصيد سطرٍ من كشف الافتتاحي نفسه لا يجعله «منتصف سلسلة» (السلسلة تعود إليه)، أما افتتاحيٌّ يساوي رصيد سطرٍ من
 * كشفٍ آخر في يومه (6,000 رصيد إيجار سالم في الأولى) فهو افتتاحي الصفحة التالية · بالترتيبين: أكتوبر من 1,000 إلى 8,495، بلا فجوة، وغير
 * المفسَّر صفر.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';

/** سطرٌ بعرضه من طول نصه كما في tests/d4.auditL2.firstDayPages.test.ts */
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
const page1: OcrLine[] = [
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('1,000.00', 880, 80),
  ln('15/10/2026', 40, 100), ln('RENT MAJED', 200, 100), ln('2,500.00', 720, 100), ln('3,500.00', 880, 100),
  ln('15/10/2026', 40, 140), ln('TRANSFER TO OWNER', 200, 140), ln('2,500.00', 560, 140), ln('1,000.00', 880, 140),
  ln('15/10/2026', 40, 180), ln('RENT SALEM', 200, 180), ln('5,000.00', 720, 180), ln('6,000.00', 880, 180),
  ln('Balance Carried Forward', 40, 220), ln('6,000.00', 880, 220),
  ln('Page 1 of 2', 40, 300),
];
const page2: OcrLine[] = [
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Balance Brought Forward', 40, 80), ln('6,000.00', 880, 80),
  ln('15/10/2026', 40, 100), ln('RENT FAHAD', 200, 100), ln('2,500.00', 720, 100), ln('8,500.00', 880, 100),
  ln('20/10/2026', 40, 140), ln('SMS CHARGES', 200, 140), ln('5.00', 560, 140), ln('8,495.00', 880, 140),
  ln('Closing Balance', 40, 180), ln('8,495.00', 880, 180),
  ln('Page 2 of 2', 40, 260),
];
const read = (p: OcrLine[]) => { const r = readStatementPhoto(p); if (!r.ok) throw new Error('لم تُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار

function report(order: Array<'p1' | 'p2'>) {
  jest.useFakeTimers({ now: new Date('2026-11-08T09:00:00Z') });
  try {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع N2-2', 0);
    order.forEach((k, i) => {
      jest.setSystemTime(new Date(Date.UTC(2026, 10, 8, 9, 0, i)));
      saveStatement(db, bank, read(k === 'p1' ? page1 : page2), { name: `oct-${k}.jpg`, hash: `n2-2-${k}` });
    });
    const rep = reconciliation(db, bank, '2026-10');
    db.close();
    return { opening: rep.statementOpening, closing: rep.statementClosing, gaps: rep.gaps, unexplained: rep.unexplained };
  } finally { jest.useRealTimers(); }
}
const want = { opening: 100000, closing: 849500, gaps: [], unexplained: 0 };

describe('N2-2 · [متوسط] رصيدٌ يعود يوم الفاصل إلى افتتاحي الصفحة الأولى فيرجع اختيار الافتتاحي إلى ترتيب الحفظ (store.ts:292-295)', () => {
  test('القراءة سليمة: الأولى من 1,000 إلى 6,000 بثلاث حركات، والثانية من 6,000 إلى 8,495، وفترتاهما تبدآن يوم 15', () => {
    const [a, b] = [read(page1), read(page2)];
    expect([a.opening, a.closing, a.from, a.lines.map((l) => l.amount), b.opening, b.closing, b.from])
      .toEqual([100000, 600000, '2026-10-15', [250000, -250000, 500000], 600000, 849500, '2026-10-15']);
  });

  test('الضابط: الأولى ثم الثانية', () => {
    expect(report(['p1', 'p2'])).toEqual(want);
  });

  test('الثانية ثم الأولى: التقرير نفسه (لا افتتاحي 6,000 ولا فجوة ولا فرق غير مفسَّر)', () => {
    // (الواقع: opening 600000، وفجوة { after: '2026-10-15', closing: 850000, nextOpening: 100000 }، وunexplained −500000)
    expect(report(['p2', 'p1'])).toEqual(want);
  });
});
