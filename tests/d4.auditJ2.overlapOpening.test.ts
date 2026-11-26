/**
 * المدقق J2 · الجولة الثامنة عشرة · على ae6765f · إصلاح H2-3 جعل خط زمن التقرير يُكمل «سلسلة الكشف الجاري» قبل «افتتاحي كشفٍ عند الرصيد
 * نفسه»؛ فكشفٌ متداخل يبدأ في يومٍ فيه سطورٌ من الكشف الآخر يُؤخَّر افتتاحيه إلى آخر يومه فيرجع الجاري إلى رصيد أول اليوم · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditJ2.overlapOpening.test.ts
 *
 * J2-1 · عالٍ · src/domain/bankStatement/store.ts:271 (سلسلة الكشف الجاري أولاً «l.st === lastSt && chainsFrom(cur)») وstore.ts:273-274 (افتتاحي
 * كشفٍ يساوي الجاري لا يُنظر فيه إلا إن لم تتسلسل سلسلة الجاري) ثم store.ts:291 (الافتتاحي الباقي آخر اليوم يؤخذ «cur = take(os, 0).open»
 * فيصير الجاري) وstore.ts:306 (الفجوة): كشف أكتوبر (أ) من 1 إلى 31 أكتوبر، افتتاحيه 1,000، وحركاته: حوالة 5 أكتوبر (3,500) وشراء يوم 31 (3,000)
 * وحوالة يوم 31 (5,500) · ثم كشفٌ بمدىً مخصّص (ب) «آخر ثلاثين يوماً» من 31 أكتوبر إلى 29 نوفمبر، افتتاحيه 3,500 (رصيد أول يوم 31)، فيه حركتا
 * يوم 31 نفسهما (تُتخطّيان عند الحفظ لأنهما في أ) وحوالة 2 نوفمبر (8,000) · بحفظ أ ثم ب: يوم 31 تُؤخذ سطور أ أولاً (سلسلة الجاري)، فيبقى
 * افتتاحي ب 3,500 ولا يساوي الجاري 5,500، فيؤخذ آخر اليوم ويصير الجاري 3,500: ختامي أكتوبر 3,500 بدل 5,500، و«فجوة» بعد 31 أكتوبر، و«غير
 * مفسَّر» −2,000 في أكتوبر و+2,000 في نوفمبر (وافتتاحيه 3,500) · وبحفظ ب ثم أ يصح التقرير · وكان يصح بالترتيبين على 3f2c136 (الافتتاحي
 * المساوي للجاري أولاً).
 * لماذا يهم: الكشفان المتداخلان مسارٌ مقصود (بصمة السطر تمنع تكرار السطر، والتقرير يعرض التداخل)، وتصدير «آخر ثلاثين يوماً» من تطبيق البنك
 * فوق كشف الشهر شائع · وD2-1 قرّر «الكشف نفسه يعطي التقرير نفسه أياً كان ترتيب حفظه»، فيُنبّه تقرير شهرين بفجوةٍ وفرقٍ غير مفسَّر لا وجود
 * لهما، ويخطئ ختامي أكتوبر وافتتاحي نوفمبر، بحسب أيّ الملفين قُرئ أولاً.
 * السلوك الصحيح (D2-1: «افتتاحي الكشف حيث يتّصل: عند رصيدٍ يساويه، أو قبل سطرٍ يتسلسل منه»): افتتاحي ب في موضعه أول يوم 31 حين كان الجاري
 * 3,500، ثم سطور أ تتسلسل منه · بالترتيبين: أكتوبر من 1,000 إلى 5,500 بلا فجوة وغير المفسَّر صفر، ونوفمبر من 5,500 إلى 8,000 كذلك · (ولا
 * يخالف H2-3: هناك يعود الجاري إلى قيمة الافتتاحي بعد سلسلة الكشف الجاري فيتّصل بعدها، وهنا لا يعود.)
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';

const H = ['Date', 'Description', 'Debit', 'Credit', 'Balance'];
const monthly = [
  ['Statement Period: 01/10/2026 - 31/10/2026'],
  ['Opening Balance', '1,000.00'],
  H,
  ['05/10/2026', 'TRANSFER IN (synthetic A)', '', '2,500.00', '3,500.00'],
  ['31/10/2026', 'POS PURCHASE (synthetic)', '500.00', '', '3,000.00'],
  ['31/10/2026', 'TRANSFER IN (synthetic B)', '', '2,500.00', '5,500.00'],
  ['Closing Balance', '5,500.00'],
];
const last30 = [
  ['Statement Period: 31/10/2026 - 29/11/2026'],
  ['Opening Balance', '3,500.00'],
  H,
  ['31/10/2026', 'POS PURCHASE (synthetic)', '500.00', '', '3,000.00'],
  ['31/10/2026', 'TRANSFER IN (synthetic B)', '', '2,500.00', '5,500.00'],
  ['02/11/2026', 'TRANSFER IN (synthetic C)', '', '2,500.00', '8,000.00'],
  ['Closing Balance', '8,000.00'],
];
const read = (g: string[][]) => { const r = readStatementGrid(g); if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار

function report(order: Array<'monthly' | 'last30'>) {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع J2-1', 0);
  const saved = order.map((k) => saveStatement(db, bank, read(k === 'monthly' ? monthly : last30), { name: `${k}-j2-1.csv`, hash: `j2-1-${k}` }));
  const pick = (m: string) => {
    const r = reconciliation(db, bank, m);
    return { opening: r.statementOpening, closing: r.statementClosing, gaps: r.gaps, unexplained: r.unexplained };
  };
  const out = { added: saved.map((s) => s.added), oct: pick('2026-10'), nov: pick('2026-11') };
  db.close();
  return out;
}
const oct = { opening: 100000, closing: 550000, gaps: [], unexplained: 0 };
const nov = { opening: 550000, closing: 800000, gaps: [], unexplained: 0 };

describe('J2-1 · [عالٍ] افتتاحي كشفٍ متداخل يبدأ في يومٍ فيه سطورٌ من كشفٍ آخر يؤخَّر إلى آخر اليوم فيُرجع الجاري (store.ts:271-274 و291)', () => {
  test('الضابط: «آخر ثلاثين يوماً» ثم كشف الشهر: أكتوبر 1,000 ← 5,500 ونوفمبر 5,500 ← 8,000 بلا فجوة', () => {
    expect(report(['last30', 'monthly'])).toEqual({ added: [3, 1], oct, nov });
  });

  test('كشف الشهر ثم «آخر ثلاثين يوماً»: التقرير نفسه (لا ختامي 3,500 ولا فجوة ولا فرق غير مفسَّر)', () => {
    // (الواقع: oct = { closing: 350000, gaps: [{ after: '2026-10-31', closing: 550000, nextOpening: 350000 }], unexplained: -200000 }
    //  وnov = { opening: 350000, unexplained: 200000 })
    expect(report(['monthly', 'last30'])).toEqual({ added: [3, 1], oct, nov });
  });
});
