/**
 * المدقق D2 · الجولة الخامسة عشرة · على f5036b1 · «الرصيد المرحَّل» أسفل كل صفحةٍ من كشفٍ متعدد الصفحات يُعدّ «الختامي» ويغلب الختامي
 * المطبوع في ملخص رأس الكشف، فيُرفض كشفٌ صحيح «لا يطابق الختامي» · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditD2.carriedForward.test.ts
 *
 * D2-5 · متوسط · src/domain/bankStatement/read.ts:187-197 (noteSummary: «الافتتاحي أول ما يُطبع والختامي آخره»، و«balance carried forward» و«carried
 * forward» من كلمات الختامي في dictionary.json) ثم read.ts:312 (الختامي المطبوع يخالف المحسوب فـ«balance: closing»): ملخص الرأس «Opening
 * Balance 0.00 · Closing Balance 1,300.00»، وأسفل الصفحة الأولى «Balance Carried Forward 1,500.00»، وأعلى الثانية «Balance Brought
 * Forward 1,500.00»، والصفحة الأخيرة بلا سطر ختامي (ملخص الرأس يكفيها) · «المنقول» يُعامَل افتتاحياً فيُهمل لأن الأول غلب، أما «المرحَّل»
 * فيُعامَل ختامياً فيغلب لأنه الأخير: الختامي المطبوع 1,500 والمحسوب 1,300 فيُرفض الكشف، ويُعرض حفظه «غير متحقَّق» وهو صحيحٌ متسلسل.
 * لماذا يهم: الكشوف المتعددة الصفحات بملخصٍ في الرأس و«مرحَّل/منقول» في كل صفحة شكلٌ شائع (PDF بطبقة نص هو الأغلب)؛ فإما يُرفض الكشف
 * الصحيح، وإما يحفظه المستخدم «غير متحقَّق» فينبّه تقرير كل شهرٍ بلا سبب.
 * السلوك الصحيح: «المرحَّل» رصيدٌ وسيط كـ«المنقول» لا يغلب ختامياً صريحاً: الكشف يُقرأ متحقَّقاً بثلاث حركاتٍ وختامي 1,300 مفحوصاً
 * (checks.closing = true) · (ويبقى «المرحَّل» ختامي صورة الصفحة الأولى وحدها حيث لا ختامي غيره · tests/d4.auditZ1.photoPages.test.ts)
 */
import { readStatementGrid } from '@/domain/bankStatement/read';
import { gridFromPdfItems } from '@/domain/bankStatement/pdfTable';

const at = (str: string, x: number, y: number) => ({ str, x, y, size: 9 });
const head = [at('Date', 40, 700), at('Description', 120, 700), at('Debit', 300, 700), at('Credit', 380, 700), at('Balance', 460, 700)];
const page1 = [
  at('Statement Period: 01/10/2026 - 31/10/2026', 40, 780),
  at('Opening Balance', 40, 760), at('0.00', 160, 760), at('Closing Balance', 280, 760), at('1,300.00', 400, 760),
  ...head,
  at('01/10/2026', 40, 680), at('SALARY (synthetic)', 120, 680), at('1,000.00', 380, 680), at('1,000.00', 460, 680),
  at('02/10/2026', 40, 665), at('TRANSFER IN (synthetic)', 120, 665), at('500.00', 380, 665), at('1,500.00', 460, 665),
  at('Balance Carried Forward', 120, 640), at('1,500.00', 460, 640),
];
const page2 = [
  ...head,
  at('Balance Brought Forward', 120, 690), at('1,500.00', 460, 690),
  at('05/10/2026', 40, 680), at('POS PURCHASE (synthetic)', 120, 680), at('200.00', 300, 680), at('1,300.00', 460, 680),
  at('*** End of Statement ***', 120, 600),
];

describe('D2-5 · [متوسط] «Balance Carried Forward» أسفل الصفحة يغلب ختامي الرأس فيُرفض كشفٌ صحيح (read.ts:194-195 و312)', () => {
  test('كشف PDF من صفحتين: ثلاث حركاتٍ، والافتتاحي صفر، والختامي 1,300 مفحوصاً بالمطبوع', () => {
    const r = readStatementGrid(gridFromPdfItems([page1, page2]));
    // (الواقع: { ok: false, error: 'balance', detail: 'closing' })
    expect(r.ok ? { lines: r.lines.map((l) => l.amount), opening: r.opening, closing: r.closing, checked: r.checks.closing } : { error: r.error, detail: r.detail })
      .toEqual({ lines: [100000, 50000, -20000], opening: 0, closing: 130000, checked: true });
  });

  const csvRows = (withCarried: boolean) => [
    ['Opening Balance', '0.00', 'Closing Balance', '1,300.00'],
    ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
    ['01/10/2026', 'SALARY (synthetic)', '', '1,000.00', '1,000.00'],
    ['02/10/2026', 'TRANSFER IN (synthetic)', '', '500.00', '1,500.00'],
    ...(withCarried ? [['', 'Balance Carried Forward', '', '', '1,500.00']] : []),
    ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
    ['', 'Balance Brought Forward', '', '', '1,500.00'],
    ['05/10/2026', 'POS PURCHASE (synthetic)', '200.00', '', '1,300.00'],
  ];
  test('الضابط: الجدول نفسه بلا صفّ «المرحَّل» يُقرأ متحقَّقاً بختامي الرأس', () => {
    const r = readStatementGrid(csvRows(false));
    expect(r.ok ? [r.closing, r.checks.closing] : r.error + ':' + r.detail).toEqual([130000, true]);
  });

  test('والجدول نفسه من CSV/Excel بصفّ «المرحَّل» (بلا تاريخ) يُقرأ كذلك', () => {
    const r = readStatementGrid(csvRows(true));
    // (الواقع: 'balance:closing')
    expect(r.ok ? [r.closing, r.checks.closing] : r.error + ':' + r.detail).toEqual([130000, true]);
  });
});
