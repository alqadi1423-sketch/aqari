/**
 * المدقق H2 · الجولة السابعة عشرة · على 3f2c136 · خط زمن تقرير المطابقة (إصلاح D2-1 «في اليوم الواحد بتسلسل الأرصدة لا بترتيب الحفظ») يأخذ
 * من سطور اليوم أول ما يتسلسل من الجاري بترتيب الحفظ، فإن تسلسل منه سطران (رصيدٌ يعود إلى قيمته في اليوم نفسه: شراءٌ واسترداده) أخذ سطر
 * الصفحة المحفوظة أولاً وإن كان بعد الآخر · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditH2.sameBalance.test.ts
 *
 * H2-3 · متوسط · src/domain/bankStatement/store.ts:263-265 (الافتتاحي إن ساوى الجاري، ثم «ls.findIndex(chainsFrom(cur))»: أول سطرٍ بترتيب
 * «date, rowid» يتسلسل من الجاري) وstore.ts:276-277 (وما لا يتسلسل منه شيء يؤخذ أول السطور ويصير رصيده الجاري) ثم store.ts:286-302 (ختامي
 * الشهر آخر رصيد): كشف أكتوبر صفحتان مصوَّرتان (المسار المعتاد منذ Z1-2 وD2-1) · الأولى: افتتاحي 1,000 ورسوم 29 أكتوبر (995) ثم يوم 31 شراء
 * نقاط بيع 120 (875) واسترداده 120 (995) و«رصيد مرحَّل» 995 · والثانية: «رصيد منقول» 995 ثم حوالة فهد 2,500 يوم 31 (3,495) · بعد الرسوم
 * الجاري 995 ويتسلسل منه سطران: الشراء (875 + 120 = 995) والحوالة (3,495 − 2,500 = 995) · فإن حُفظت الثانية أولاً أُخذت الحوالة (3,495) ثم لا
 * يتسلسل الشراء فيؤخذ بلا تسلسل (875) ثم الاسترداد (995): ختامي أكتوبر 995 بدل 3,495، و«غير مفسَّر» −2,500 والدفاتر فارغة كلها في الكشف وحده ·
 * وبالترتيب الآخر يصح التقرير.
 * لماذا يهم: D2-1 قرّر «الكشف نفسه يعطي التقرير نفسه أياً كان ترتيب حفظ صفحاته»؛ والشراء واسترداده في اليوم نفسه، وفاصل الصفحة داخل يوم آخر
 * الشهر، شائعان · فيُنبّه التقرير بفرقٍ «غير مفسَّر» لا وجود له ويخطئ في الختامي، بحسب أي الصفحتين صوّرها المستخدم أولاً.
 * السلوك الصحيح: ترتيب اليوم بما تتسلسل به سطوره كلها لا بأول ما يتسلسل (السطر الذي لا يتسلسل منه ما بعده ليس التالي)، أو بكشفه ثم
 * بترتيبه فيه: تقرير أكتوبر بالترتيبين افتتاحيه 1,000 وختاميه 3,495، بلا فجوة، وغير المفسَّر صفر.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';

/** سطرٌ بعرضه من طول نصه (عشر نقاطٍ للحرف) كما في tests/d4.auditD2.reconTimeline.test.ts */
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
const page1: OcrLine[] = [
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('1,000.00', 880, 80),
  ln('29/10/2026', 40, 100), ln('SMS CHARGES', 200, 100), ln('5.00', 560, 100), ln('995.00', 880, 100),
  ln('31/10/2026', 40, 140), ln('POS PURCHASE', 200, 140), ln('120.00', 560, 140), ln('875.00', 880, 140),
  ln('31/10/2026', 40, 180), ln('POS REFUND', 200, 180), ln('120.00', 720, 180), ln('995.00', 880, 180),
  ln('Balance Carried Forward', 40, 220), ln('995.00', 880, 220),
  ln('Page 1 of 2', 40, 260),
];
const page2: OcrLine[] = [
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Balance Brought Forward', 40, 80), ln('995.00', 880, 80),
  ln('31/10/2026', 40, 100), ln('TRANSFER FAHAD', 200, 100), ln('2,500.00', 720, 100), ln('3,495.00', 880, 100),
  ln('Closing Balance', 40, 180), ln('3,495.00', 880, 180),
  ln('Page 2 of 2', 40, 260),
];
const read = (p: OcrLine[]) => { const r = readStatementPhoto(p); if (!r.ok) throw new Error('لم تُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار

function report(order: Array<'p1' | 'p2'>) {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع H2-3', 0);
  for (const k of order) saveStatement(db, bank, read(k === 'p1' ? page1 : page2), { name: `oct-${k}.jpg`, hash: `h2-3-${k}` });
  const rep = reconciliation(db, bank, '2026-10');
  db.close();
  return { opening: rep.statementOpening, closing: rep.statementClosing, gaps: rep.gaps, unexplained: rep.unexplained, onlyInStatement: rep.onlyInStatement.length };
}
const want = { opening: 100000, closing: 349500, gaps: [], unexplained: 0, onlyInStatement: 4 };

describe('H2-3 · [متوسط] سطران يتسلسلان من الرصيد نفسه في يومٍ واحد: التقرير يأخذ سطر الصفحة المحفوظة أولاً فيخطئ الختامي (store.ts:263-277)', () => {
  test('القراءة سليمة: الأولى تنتهي بـ995 بعد الشراء واسترداده يوم 31، والثانية تبدأ بـ995', () => {
    expect([read(page1).lines.map((l) => [l.date, l.amount, l.balance]), read(page2).opening]).toEqual([
      [['2026-10-29', -500, 99500], ['2026-10-31', -12000, 87500], ['2026-10-31', 12000, 99500]], 99500]);
  });

  test('الضابط: الأولى ثم الثانية: ختامي أكتوبر 3,495 وغير المفسَّر صفر', () => {
    expect(report(['p1', 'p2'])).toEqual(want);
  });

  test('الثانية ثم الأولى: التقرير نفسه (ختامي 3,495، وغير المفسَّر صفر)', () => {
    // (الواقع: closing 99500، وunexplained −250000)
    expect(report(['p2', 'p1'])).toEqual(want);
  });
});
