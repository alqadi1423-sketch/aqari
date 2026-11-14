/**
 * المدقق P2 · الجولة الحادية والعشرون · على ec1b970 · إصلاح N2-2 استبعد من افتتاحيَّي أول يومٍ ما يساوي رصيد سطرٍ «من كشفٍ آخر» في يومه؛ فإن
 * دخل الإيجار في الصفحة الأولى وحُوِّل للمالك في الثانية في اليوم نفسه، صار كلٌّ من الافتتاحيين رصيدَ سطرٍ من الكشف الآخر، فسقطا كلاهما من
 * الشرط ورجع الاختيار إلى ترتيب الحفظ · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditP2.crossPageReturn.test.ts
 *
 * P2-2 · متوسط · src/domain/bankStatement/store.ts:295-296 («jj: chained(x) && !ls.some((l) => l.st !== x.st && l.balance === x.open)» ثم «j = jj
 * >= 0 ? jj : os.findIndex(chained)» بترتيب «ORDER BY period_from, created_at, id» في store.ts:252): أول كشفٍ للبنك صفحتان مصوَّرتان فاصلهما في
 * يوم 15 أكتوبر · الأولى افتتاحي 1,000، وإيجار ماجد 5,000 يوم 15 (6,000) و«رصيد مرحَّل» 6,000 · والثانية «رصيد منقول» 6,000، وتحويل الإيجار
 * للمالك 5,000 يوم 15 (1,000)، وإيجار فهد 2,500 يوم 20 (3,500) والختامي · فافتتاحي الأولى 1,000 رصيدُ سطر التحويل في الثانية، وافتتاحي الثانية
 * 6,000 رصيدُ سطر الإيجار في الأولى؛ فبحفظ الثانية أولاً يُؤخذ 6,000: افتتاحي أكتوبر 6,000 بدل 1,000، و«غير مفسَّر» −5,000 · وبحفظ الأولى أولاً
 * يصح (الضابط) · والقراءة سليمة.
 * لماذا يهم: هو N2-2 وL2-2 نفسهما (D2-1: «الكشف نفسه يعطي التقرير نفسه أياً كان ترتيب حفظه») بفاصل الصفحة بين الإيجار وتحويله للمالك بدل أن
 * يكونا في صفحةٍ واحدة · فيُنبَّه تقرير الشهر بفرقٍ غير مفسَّر لا وجود له وافتتاحيٍّ خاطئ بحسب أيّ الصفحتين صُوّرت أولاً.
 * السلوك الصحيح (D2-1): افتتاحيٌّ يساوي رصيد سطرٍ من كشفٍ آخر يتسلسل ذلك السطر من افتتاحيه هو (1,000 بعد 6,000 في الثانية) ليس منتصف سلسلة
 * الآخر، أما افتتاحيٌّ يساوي رصيد سطرٍ يتسلسل من افتتاحي غيره (6,000 بعد 1,000 في الأولى) فهو افتتاحي الصفحة التالية · بالترتيبين: أكتوبر من
 * 1,000 إلى 3,500، بلا فجوة، وغير المفسَّر صفر · (ولا يخالف N2-2 ولا L2-2: الاختيار هناك صحيحٌ بالقاعدة نفسها.)
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';

/** سطرٌ بعرضه من طول نصه كما في tests/d4.auditN2.returningOpening.test.ts */
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
const page1: OcrLine[] = [
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('1,000.00', 880, 80),
  ln('15/10/2026', 40, 100), ln('RENT MAJED', 200, 100), ln('5,000.00', 720, 100), ln('6,000.00', 880, 100),
  ln('Balance Carried Forward', 40, 220), ln('6,000.00', 880, 220),
  ln('Page 1 of 2', 40, 300),
];
const page2: OcrLine[] = [
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Balance Brought Forward', 40, 80), ln('6,000.00', 880, 80),
  ln('15/10/2026', 40, 100), ln('TRANSFER TO OWNER', 200, 100), ln('5,000.00', 560, 100), ln('1,000.00', 880, 100),
  ln('20/10/2026', 40, 140), ln('RENT FAHAD', 200, 140), ln('2,500.00', 720, 140), ln('3,500.00', 880, 140),
  ln('Closing Balance', 40, 180), ln('3,500.00', 880, 180),
  ln('Page 2 of 2', 40, 260),
];
const read = (p: OcrLine[]) => { const r = readStatementPhoto(p); if (!r.ok) throw new Error('لم تُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار

function report(order: Array<'p1' | 'p2'>) {
  jest.useFakeTimers({ now: new Date('2026-11-08T09:00:00Z') });
  try {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع P2-2', 0);
    order.forEach((k, i) => {
      jest.setSystemTime(new Date(Date.UTC(2026, 10, 8, 9, 0, i)));
      saveStatement(db, bank, read(k === 'p1' ? page1 : page2), { name: `oct-${k}.jpg`, hash: `p2-2-${k}` });
    });
    const rep = reconciliation(db, bank, '2026-10');
    db.close();
    return { opening: rep.statementOpening, closing: rep.statementClosing, gaps: rep.gaps, unexplained: rep.unexplained };
  } finally { jest.useRealTimers(); }
}
const want = { opening: 100000, closing: 350000, gaps: [], unexplained: 0 };

describe('P2-2 · [متوسط] الإيجار في الصفحة الأولى وتحويله للمالك في الثانية يومَ الفاصل فيرجع اختيار الافتتاحي إلى ترتيب الحفظ (store.ts:295-296)', () => {
  test('القراءة سليمة: الأولى من 1,000 إلى 6,000، والثانية من 6,000 إلى 3,500، وفترتاهما تبدآن يوم 15', () => {
    const [a, b] = [read(page1), read(page2)];
    expect([a.opening, a.closing, a.from, a.lines.map((l) => l.amount), b.opening, b.closing, b.from, b.lines.map((l) => l.amount)])
      .toEqual([100000, 600000, '2026-10-15', [500000], 600000, 350000, '2026-10-15', [-500000, 250000]]);
  });

  test('الضابط: الأولى ثم الثانية', () => {
    expect(report(['p1', 'p2'])).toEqual(want);
  });

  test('الثانية ثم الأولى: التقرير نفسه (لا افتتاحي 6,000 ولا فرق غير مفسَّر)', () => {
    // (الواقع: opening 600000، وunexplained −500000)
    expect(report(['p2', 'p1'])).toEqual(want);
  });
});
