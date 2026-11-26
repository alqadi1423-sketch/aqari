/**
 * المدقق R2 · الجولة الثانية والعشرون · على 260be7b · إصلاح P2-2 قدّم من افتتاحيَّين يتسلسلان في يومٍ واحد «ما تنتهي سطور كشفه أبكر»، وجعل ذلك
 * يغلب استبعاد N2-2 (افتتاحيٌّ يساوي رصيد سطرٍ من كشفٍ آخر هو منتصف سلسلته) · فكشفٌ ليومٍ واحد يبدأ من منتصف يوم الكشف الشهري يُؤخذ أولاً ولو
 * كان افتتاحيه رصيدَ سطرٍ يتسلسل من افتتاحي الشهري · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditR2.earliestOpening.test.ts
 *
 * R2-2 · متوسط · src/domain/bankStatement/store.ts:297-300 («earliest … ? earliest.n : jj >= 0 ? jj : …»: الأبكر انتهاءً يغلب jj) · أول كشفٍ
 * للبنك: صفحةٌ مصوَّرة ليوم 1 أكتوبر وحده تبدأ «Balance Brought Forward 1,100» بإيجار ب 200 (1,300) تُحفظ أولاً، ثم كشف أكتوبر الكامل: افتتاحي
 * 1,000، إيجار أ 100 يوم 1 (1,100)، إيجار ب 200 (1,300 · يُتخطّى لأنه محفوظ)، رسوم 5 يوم 10 (1,295) · فالأبكر انتهاءً صفحة اليوم الواحد
 * فيُؤخذ افتتاحيها 1,100 أولاً: افتتاحي أكتوبر 1,100 بدل 1,000، و«فجوة» (ختامي 1,300 وافتتاحي 1,000)، و«غير مفسَّر» −100 · وبالكشف الكامل
 * وحده يصح (الضابط)، وعلى ec1b970 كان jj يختار افتتاحي الشهري فيصح.
 * لماذا يهم: D2-1 «الكشف نفسه يعطي التقرير نفسه أياً كان ترتيب حفظه» · من صوّر صفحةً ثم نزّل الكشف كاملاً يُنبَّه في تقرير الشهر بفجوةٍ
 * وفرقٍ غير مفسَّر لا وجود لهما وافتتاحيٍّ خاطئ · وهو ما سمّاه الموجّه: «كشفٌ ليومٍ واحد» و«كشوفٌ متداخلة» (والكشف المتداخل الذي يبدأ في منتصف
 * أول يومٍ لآخر ويتمّ قبله كذلك).
 * السلوك الصحيح (بنصّ P2-2 نفسه): افتتاحيٌّ يساوي رصيد سطرٍ من كشفٍ آخر يتسلسل ذلك السطر من افتتاحي كشفه (1,100 بعد 1,000 في الكامل) هو
 * افتتاحي ما بعده، فيُقدَّم 1,000 · أكتوبر من 1,000 إلى 1,295 بلا فجوة وغير المفسَّر صفر · (و«الأبكر انتهاءً» يبقى لما تساوى فيه الاستبعاد
 * كما في P2-2، فلا يخالف P2-2 ولا N2-2.)
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementGrid, type StatementOk } from '@/domain/bankStatement/read';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';

const H = ['Date', 'Description', 'Debit', 'Credit', 'Balance'];
const read = (rows: string[][]): StatementOk => {
  const r = readStatementGrid([H, ...rows]);
  if (!r.ok) throw new Error('لم تُقرأ: ' + r.error); // i18n-exempt: رسالة اختبار
  return r;
};
const month = () => read([
  ['', 'Opening Balance', '', '', '1,000.00'],
  ['01/10/2026', 'RENT A (synthetic)', '', '100.00', '1,100.00'],
  ['01/10/2026', 'RENT B (synthetic)', '', '200.00', '1,300.00'],
  ['10/10/2026', 'SMS FEES (synthetic)', '5.00', '', '1,295.00'],
  ['', 'Closing Balance', '', '', '1,295.00'],
]);
const oneDay = () => read([
  ['', 'Balance Brought Forward', '', '', '1,100.00'],
  ['01/10/2026', 'RENT B (synthetic)', '', '200.00', '1,300.00'],
  ['', 'Closing Balance', '', '', '1,300.00'],
]);

function report(order: Array<'day' | 'month'>) {
  jest.useFakeTimers({ now: new Date('2026-11-08T09:00:00Z') });
  try {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع R2-2', 0);
    const saved = order.map((k, i) => {
      jest.setSystemTime(new Date(Date.UTC(2026, 10, 8, 9, 0, i)));
      return saveStatement(db, bank, k === 'day' ? oneDay() : month(), { name: `oct-${k}`, hash: `r2-2-${k}` }).added;
    });
    const rep = reconciliation(db, bank, '2026-10');
    db.close();
    return { saved, opening: rep.statementOpening, closing: rep.statementClosing, gaps: rep.gaps, unexplained: rep.unexplained };
  } finally { jest.useRealTimers(); }
}

describe('R2-2 · [متوسط] «الأبكر انتهاءً» يغلب استبعاد N2-2 فصفحة يومٍ واحد من منتصف اليوم تصير افتتاحي الشهر (store.ts:297-300)', () => {
  test('القراءة سليمة: الكامل من 1,000 إلى 1,295، وصفحة اليوم من 1,100 إلى 1,300', () => {
    const [m, d] = [month(), oneDay()];
    expect([m.opening, m.closing, d.opening, d.closing, d.from, d.to]).toEqual([100000, 129500, 110000, 130000, '2026-10-01', '2026-10-01']);
  });

  test('الضابط: الكشف الكامل وحده', () => {
    expect(report(['month'])).toEqual({ saved: [3], opening: 100000, closing: 129500, gaps: [], unexplained: 0 });
  });

  test('صفحة اليوم ثم الكامل: التقرير نفسه (افتتاحي 1,000 بلا فجوة ولا فرق)', () => {
    // (الواقع: opening 110000، وgaps [{ after: '2026-10-01', closing: 130000, nextOpening: 100000 }]، وunexplained −10000)
    expect(report(['day', 'month'])).toEqual({ saved: [1, 2], opening: 100000, closing: 129500, gaps: [], unexplained: 0 });
  });
});
