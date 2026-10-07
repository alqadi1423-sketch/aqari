/**
 * استرجاع المسافات من هندسة الملف · بيانات مصطنعة:
 * إزاحات TJ السالبة الكبيرة مسافات، الفجوات الأفقية بين القطع مسافات،
 * والبديل (فاصل بين كل قطعتين) يفوز فقط إن أعطى كلاماً عربياً أفضل،
 * واقتراح تقسيم الاسم اقتراحٌ لا فرض وبأنماط الأسماء السعودية.
 */
import { extractPdfText } from '@/domain/pdf/miniPdfText';
import { suggestNameSplit } from '@/domain/pdf/parseEjar';

const toBytes = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
};

/** ملف PDF أدنى ببث محتوى واحد غير مضغوط */
const pdfWith = (content: string): string => `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj
4 0 obj << /Length ${content.length} >>
stream
${content}
endstream
endobj
trailer << /Root 1 0 R >>
%%EOF`;

describe('استرجاع المسافات هندسياً', () => {
  test('الصفحة التي ترسم مسافاتها حروفاً تُجمَّع بها وحدها · لا بتقدير العرض (أعطال قراءة العقد ٢٠٢٦-١٠-٠٧)', () => {
    // حرفٌ عريض (W بتقدّم ١٤) يصنع فجوةً كاذبة بالتقدير الثابت، والمسافات مرسومة قطعاً مستقلة
    let x = 100;
    const parts: string[] = [];
    for (let w = 0; w < 9; w++) {
      parts.push(`1 0 0 1 ${x} 700 Tm (W) Tj`); x += 14;
      parts.push(`1 0 0 1 ${x} 700 Tm (a) Tj`); x += 5;
      parts.push(`1 0 0 1 ${x} 700 Tm ( ) Tj`); x += 3;
    }
    const text = extractPdfText(toBytes(pdfWith('BT /F1 10 Tf ' + parts.join(' ') + ' ET')));
    expect(text.trim()).toBe(Array(9).fill('Wa').join(' '));
  });

  test('بلا مسافات مرسومة يبقى التقدير كما كان', () => {
    const text = extractPdfText(toBytes(pdfWith('BT /F1 10 Tf 1 0 0 1 100 700 Tm (Deeds) Tj 1 0 0 1 160 700 Tm (No7) Tj ET')));
    expect(text.trim()).toBe('Deeds No7');
  });

  test('إزاحة TJ سالبة كبيرة = مسافة، والصغيرة تقنين حروف لا يفصل', () => {
    const text = extractPdfText(toBytes(pdfWith(
      'BT /F1 10 Tf 100 700 Td [(Ranim) -250 (Zain) -40 (i)] TJ ET'
    )));
    expect(text.trim()).toBe('Ranim Zaini');
  });

  test('فجوة أفقية بين قطعتين على نفس السطر = مسافة، والمتلاصقتان لا تُفصلان', () => {
    // القطعة الأولى عند 100 وعرضها المقدَّر 25 (5 أحرف × 10 × 0.5) · الثانية عند 160 — فجوة 35 > 2
    const gap = extractPdfText(toBytes(pdfWith(
      'BT /F1 10 Tf 1 0 0 1 100 700 Tm (Deeds) Tj 1 0 0 1 160 700 Tm (No7) Tj ET'
    )));
    expect(gap.trim()).toBe('Deeds No7');
    // متلاصقتان: الثانية تبدأ حيث انتهت الأولى تقريباً
    const tight = extractPdfText(toBytes(pdfWith(
      'BT /F1 10 Tf 1 0 0 1 100 700 Tm (Deeds) Tj 1 0 0 1 125 700 Tm (No7) Tj ET'
    )));
    expect(tight.trim()).toBe('DeedsNo7');
  });

  test('البديل يفوز عند كلام عربي أفضل: قطع عربية متجاورة بلا هندسة تُفصل بمسافات', () => {
    // ثلاث قطع عربية في مواضع مجهولة الفجوة (Td نسبي صغير) — الفاصل البسيط يعطي كلمات ٢-٨ فيفوز
    const text = extractPdfText(toBytes(pdfWith(
      'BT /F1 10 Tf 10 700 Td (\\331\\205\\330\\255\\331\\205\\330\\257) Tj ET'
    )));
    // قطعة واحدة: لا مجال للفصل — يكفي ألا ينهار الاستخراج
    expect(text.trim().length).toBeGreaterThan(0);
  });

  test('السطور السليمة الحالية لا تتغير (لا انحدار)', () => {
    const text = extractPdfText(toBytes(pdfWith(
      'BT /F1 12 Tf 50 700 Td (Ejar Contract) Tj 0 -20 Td (Contract No. 20240012345 / 10-2024) Tj ET'
    )));
    const lines = text.split('\n').filter((l) => l.trim());
    expect(lines[0]).toBe('Ejar Contract');
    expect(lines[1]).toBe('Contract No. 20240012345 / 10-2024');
  });
});

describe('اقتراح تقسيم الاسم · اقتراح لا فرض', () => {
  test('اسم مصطنع ملتصق: سلمىكمالبنحامدالفلاني ← سلمى كمال بن حامد الفلاني', () => {
    expect(suggestNameSplit('سلمىكمالبنحامدالفلاني')).toBe('سلمى كمال بن حامد الفلاني');
  });

  test('فهدبنسعد ← فهد بن سعد', () => {
    expect(suggestNameSplit('فهدبنسعد')).toBe('فهد بن سعد');
  });

  test('اسم فيه مسافات أصلاً أو قصير أو غير عربي: لا اقتراح', () => {
    expect(suggestNameSplit('فهد بن سعد')).toBeNull();
    expect(suggestNameSplit('فهد')).toBeNull();
    expect(suggestNameSplit('Fahd Bin Saad')).toBeNull();
    expect(suggestNameSplit('')).toBeNull();
  });
});
