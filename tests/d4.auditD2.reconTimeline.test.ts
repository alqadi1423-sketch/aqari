/**
 * المدقق D2 · الجولة الخامسة عشرة · على f5036b1 · خط زمن الكشوف في تقرير المطابقة يضع افتتاحي كل كشفٍ قبل كل سطور يومه الأول، ويرتّب
 * سطور اليوم الواحد من حفظين مختلفين بترتيب الحفظ (rowid) لا بتسلسل أرصدتها · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditD2.reconTimeline.test.ts
 *
 * D2-1 · عالٍ · src/domain/bankStatement/store.ts:227-251 (الأحداث تُرتَّب بالتاريخ ثم «الافتتاحي أولاً»، وسطور اليوم بـ«ORDER BY date, rowid»)
 * وstore.ts:256-257 (افتتاحي الشهر أول حدثٍ فيه، وختاميه آخر رصيدٍ بالترتيب نفسه): كشف أكتوبر صفحتان مصوَّرتان (المسار المعتاد منذ Z1-2
 * وA2-5) وفاصل الصفحتين داخل يوم 31 أكتوبر: الصفحة الأولى فيها رسوم 29 أكتوبر وحوالتا ماجد وسالم (2,500 لكلٍّ) يوم 31 وتنتهي بـ«رصيد
 * مرحَّل» 5,995، والثانية تبدأ بـ«رصيد منقول» 5,995 ثم حوالة فهد يوم 31 (8,495) · افتتاحي الصفحة الثانية رصيدٌ في منتصف يوم 31 لا في
 * أوله، والتقرير يضعه قبل سطور يوم 31 كلها:
 *  أ) الصفحتان بترتيبهما: «فجوة» بعد 29 أكتوبر (ختامي 995 وافتتاحي 5,995) ولا فجوة في الحقيقة.
 *  ب) الصفحة الثانية قبل الأولى (المستخدم صوّر الأخيرة أولاً): ختامي الكشف في التقرير 5,995 بدل 8,495، وفرقٌ «غير مفسَّر» −2,500، وفجوةٌ
 *     كاذبة · وكذلك صورة الصفحة الثانية ثم ملف الشهر كاملاً.
 * لماذا يهم: تقرير الشهر هو مخرج المطابقة وحده؛ «غير المفسَّر» والفجوة ينبّهان بخطرٍ لا وجود له (أو يخفيان خطراً حقيقياً بقدرهما)، وفاصل
 * الصفحة يقع داخل اليوم كثيراً، وأول الشهر وآخره أكثر الأيام حركاتٍ في العقار المؤجَّر · والسطور كلها محفوظةٌ صحيحةً مرةً واحدة.
 * السلوك الصحيح: الكشف نفسه يعطي التقرير نفسه أياً كان ترتيب حفظ صفحاته: افتتاحي أكتوبر 1,000 وختاميه 8,495، بلا فجوة، وغير المفسَّر
 * صفر (الدفاتر فارغة فالسطور الأربعة «في الكشف وحده») · (يخالف هذا نصّ DESIGN §١٣.٢٢ «افتتاحي كل كشفٍ قبل سطور يومه»، وهو أصل الخلل:
 * افتتاحي الكشف قبل أول سطرٍ منه، والرصيد المطبوع يرتّب سطور اليوم.)
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';

/** سطرٌ بعرضه من طول نصه (عشر نقاطٍ للحرف) كما في tests/d4.auditZ1.photoPages.test.ts */
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
const page1: OcrLine[] = [
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('1,000.00', 880, 80),
  ln('29/10/2026', 40, 100), ln('SMS CHARGES', 200, 100), ln('5.00', 560, 100), ln('995.00', 880, 100),
  ln('31/10/2026', 40, 140), ln('TRANSFER MAJED', 200, 140), ln('2,500.00', 720, 140), ln('3,495.00', 880, 140),
  ln('31/10/2026', 40, 180), ln('TRANSFER SALEM', 200, 180), ln('2,500.00', 720, 180), ln('5,995.00', 880, 180),
  ln('Balance Carried Forward', 40, 220), ln('5,995.00', 880, 220),
  ln('Page 1 of 2', 40, 260),
];
const page2: OcrLine[] = [
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Balance Brought Forward', 40, 80), ln('5,995.00', 880, 80),
  ln('31/10/2026', 40, 100), ln('TRANSFER FAHAD', 200, 100), ln('2,500.00', 720, 100), ln('8,495.00', 880, 100),
  ln('Closing Balance', 40, 180), ln('8,495.00', 880, 180),
  ln('Page 2 of 2', 40, 260),
];
const read = (p: OcrLine[]) => { const r = readStatementPhoto(p); if (!r.ok) throw new Error('لم تُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار

function report(order: Array<'p1' | 'p2'>) {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع D2-1', 0);
  for (const k of order) saveStatement(db, bank, read(k === 'p1' ? page1 : page2), { name: `oct-${k}.jpg`, hash: `d2-1-${k}` });
  const saved = db.all<{ d: string }>(`SELECT descr AS d FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY balance_halalas`, [bank]).map((x) => x.d);
  const rep = reconciliation(db, bank, '2026-10');
  db.close();
  return { saved, opening: rep.statementOpening, closing: rep.statementClosing, gaps: rep.gaps, unexplained: rep.unexplained };
}
const want = {
  saved: ['SMS CHARGES', 'TRANSFER MAJED', 'TRANSFER SALEM', 'TRANSFER FAHAD'], opening: 100000, closing: 849500, gaps: [], unexplained: 0,
};

describe('D2-1 · [عالٍ] افتتاحي صفحةٍ تبدأ في منتصف اليوم يوضع قبل سطور يومه كلها، وسطور اليوم من حفظين بترتيب الحفظ (store.ts:227-257)', () => {
  test('القراءة سليمة: الصفحتان بأرصدتهما المتسلسلة (الثانية تبدأ من 5,995 في يوم 31)', () => {
    expect([read(page1).lines.map((l) => [l.date, l.amount, l.balance]), read(page2).opening, read(page2).lines.map((l) => [l.date, l.amount])]).toEqual([
      [['2026-10-29', -500, 99500], ['2026-10-31', 250000, 349500], ['2026-10-31', 250000, 599500]], 599500, [['2026-10-31', 250000]]]);
  });

  test('أ) الصفحة الأولى ثم الثانية: لا فجوة في أكتوبر (الختامي 8,495 وغير المفسَّر صفر)', () => {
    // (الواقع: gaps = [{ after: '2026-10-29', closing: 99500, nextOpening: 599500 }])
    expect(report(['p1', 'p2'])).toEqual(want);
  });

  test('ب) الصفحة الثانية ثم الأولى: ختامي أكتوبر 8,495 لا 5,995، ولا فرق غير مفسَّر ولا فجوة', () => {
    // (الواقع: closing 599500، وunexplained −250000، وفجوةٌ كاذبة)
    expect(report(['p2', 'p1'])).toEqual(want);
  });
});
