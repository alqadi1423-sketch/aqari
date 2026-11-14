/**
 * صورة كشف البنك (التوجيه الرابع ٦ · ٢ · «نماذج اختبار مخترعة بأشكال أشهر البنوك السعودية وصور رديئة» · المدقق الخارجي U١٢): سطور قارئ
 * النص كما يُخرجها ML Kit لصورٍ مصطنعة · العربية لا تُقرأ فتصير رموزاً أو تضيع، والأرقام بأخطاء الصورة الرديئة · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d6.bankStatementPhoto.test.ts
 */
import { readStatementPhoto, fixDigits, amountToken, type OcrLine } from '@/domain/bankStatement/photo';

const H = 20;
/** سطرٌ بعرضه من طول نصه (عشر نقاطٍ للحرف) · والميل: ينزل السطر بقدر موضعه الأفقي */
const ln = (text: string, left: number, top: number, tilt = 0): OcrLine =>
  ({ text, left, top: top + left * tilt, width: text.length * 10, height: H });
const amounts = (r: ReturnType<typeof readStatementPhoto>) => (r.ok ? r.lines.map((l) => l.amount) : r.error);

describe('تصحيح أخطاء الصورة في الأرقام وحدها', () => {
  test('O وl وS داخل رقمٍ تصير أرقاماً، والكلمات تبقى', () => {
    expect(['2O26', '1O/1O/2O26', 'l,250.00', '3,2OO.OO', 'S00.00', 'SOS', 'Oct', 'IBAN', 'Bill'].map(fixDigits))
      .toEqual(['2026', '10/10/2026', '1,250.00', '3,200.00', '500.00', 'SOS', 'Oct', 'IBAN', 'Bill']);
  });
  test('المبلغ بكسرين، والفاصلة قبل الكسرين كسرٌ قُرئ فاصلة · والرقم المرجعي والسنة ليسا مبلغاً', () => {
    expect(['1,250.00', '1.250,00', '450,00', '12500.5', '2026', 'FT26278', '(300.00)', '75.00-'].map(amountToken))
      .toEqual(['1250.00', '1250.00', '450.00', null, null, null, '(300.00)', '75.00-']);
  });
});

describe('كشفٌ عربي من اليمين بشكل الراجحي (التاريخ يميناً والرصيد يساراً) · العربية لا تُقرأ', () => {
  // الأعمدة من اليمين: التاريخ ٨٥٠، البيان ٥٥٠ (رموزٌ لا تُقرأ)، مدين ٤٠٠، دائن ٢٦٠، الرصيد ٦٠
  const page: OcrLine[] = [
    ln('01/10/2026', 700, 20), ln('31/10/2026', 520, 20),
    ln('lIJ', 820, 60), ln('10,000.00', 60, 60), // «الرصيد الافتتاحي» لا يُقرأ
    ln('05/10/2026', 850, 100), ln('JlJI ilJ', 550, 100), ln('5,000.00', 260, 100), ln('15,000.00', 60, 100),
    ln('07/10/2026', 850, 140), ln('1,250.00', 400, 140), ln('13,750.00', 60, 140),
    ln('07/10/2026', 850, 180), ln('250.00', 400, 180), ln('13,500.00', 60, 180),
    ln('15/1O/2O26', 850, 220), ln('3,2OO.OO', 260, 220), ln('16,7OO.OO', 60, 220),
  ];
  test('بلا افتتاحيٍّ مقروء: يُطلب من المستخدم ولا يُخمَّن', () => {
    expect(readStatementPhoto(page)).toMatchObject({ ok: false, error: 'needBalances' });
  });
  test('ومع الافتتاحي من رأس الكشف: الحركات بإشاراتها من تسلسل الأرصدة، والفترة من صفّها', () => {
    const r = readStatementPhoto(page, { opening: 1000000 });
    expect(amounts(r)).toEqual([500000, -125000, -25000, 320000]);
    expect(r.ok && [r.closing, r.from, r.to, r.warnings]).toEqual([1670000, '2026-10-01', '2026-10-31', ['photo']]);
  });
  test('ورقمٌ قُرئ خطأً (1,850 بدل 1,250) يكسر التسلسل فلا يُقبل بصمت', () => {
    const bad = page.map((l) => (l.text === '1,250.00' ? { ...l, text: '1,850.00' } : l));
    expect(readStatementPhoto(bad, { opening: 1000000 })).toMatchObject({ ok: false, error: 'balance' });
  });
});

describe('كشفٌ إنجليزي من اليسار بشكل الأهلي · صورةٌ مائلة، وفاصلةٌ مكان النقطة، وl مكان 1، وسطور الصف في كتلٍ منفصلة', () => {
  const tilt = 0.012; // ينزل الصف ١٢ نقطة كل ألف نقطة
  const page: OcrLine[] = [
    ln('Account Statement', 40, 10, tilt),
    ln('Date Description Debit Credit Balance', 40, 50, tilt),
    ln('Opening Balance', 40, 80, tilt), ln('2,000.00', 880, 80, tilt),
    ln('02/10/2026', 40, 120, tilt), ln('POS PURCHASE', 200, 120, tilt), ln('l50.00', 560, 120, tilt), ln('1.850,00', 880, 120, tilt),
    ln('03/10/2026', 40, 160, tilt), ln('SADAD TRANSFER', 200, 160, tilt), ln('400,00', 720, 160, tilt), ln('2,250.00', 880, 160, tilt),
    ln('03/10/2026', 40, 200, tilt), ln('FEE', 200, 200, tilt), ln('5.75', 560, 200, tilt), ln('2,244.25', 880, 200, tilt),
    ln('Closing Balance', 40, 240, tilt), ln('2,244.25', 880, 240, tilt),
  ];
  test('الافتتاحي والختامي من صفّيهما، والحركات بإشاراتها', () => {
    const r = readStatementPhoto(page);
    expect(amounts(r)).toEqual([-15000, 40000, -575]);
    expect(r.ok && [r.opening, r.closing]).toEqual([200000, 224425]);
  });
  test('وختاميٌّ مطبوع يخالف الحركات يرفض الكشف', () => {
    const bad = page.map((l) => (l.top > 230 && l.text === '2,244.25' ? { ...l, text: '2,244.75' } : l));
    expect(readStatementPhoto(bad)).toMatchObject({ ok: false, error: 'balance' });
  });
});

describe('كشفٌ بشكل الرياض: التاريخ بالشهر نصاً، والأحدث أولاً، وCR وDR كلمةٌ بعد المبلغ', () => {
  const page: OcrLine[] = [
    ln('Opening Balance 900.00', 40, 30),
    ln('12-Oct-2026', 40, 70), ln('CARD PAYMENT', 220, 70), ln('120.00', 600, 70), ln('DR', 670, 70), ln('1,080.00', 860, 70),
    ln('10-Oct-2026', 40, 110), ln('SALARY', 220, 110), ln('300.00', 600, 110), ln('CR', 670, 110), ln('1,200.00', 860, 110),
  ];
  test('يُقلب إلى الأقدم أولاً، والإشارة من الأرصدة', () => {
    const r = readStatementPhoto(page);
    expect(r.ok && r.lines.map((l) => [l.date, l.amount])).toEqual([['2026-10-10', 30000], ['2026-10-12', -12000]]);
  });
});

describe('كشفٌ بلا عمود رصيد (مبلغٌ واحد بعلامته)', () => {
  const page: OcrLine[] = [
    ln('05/10/2026', 40, 40), ln('300.00', 700, 40), ln('CR', 770, 40),
    ln('06/10/2026', 40, 80), ln('120.00', 700, 80), ln('DR', 770, 80),
  ];
  test('يُطلب الافتتاحي والختامي، ثم يُفحص بهما', () => {
    expect(readStatementPhoto(page)).toMatchObject({ ok: false, error: 'needBalances' });
    expect(amounts(readStatementPhoto(page, { opening: 10000, closing: 28000 }))).toEqual([30000, -12000]);
    expect(readStatementPhoto(page, { opening: 10000, closing: 29000 })).toMatchObject({ ok: false, error: 'balance' });
  });
});

test('صورةٌ بلا حركات (صفحة الشروط مثلاً) فارغة', () => {
  expect(readStatementPhoto([ln('Terms and Conditions', 40, 40), ln('Page 2 of 2', 40, 80)])).toMatchObject({ ok: false, error: 'empty' });
});
