/**
 * المدقق F2 · الجولة السادسة عشرة · على 50556c3 · إصلاح D2-9 («CR/DR» ملتصقةً بالمبلغ) في القارئ العام وحده؛ وقارئ الصورة لا يعدّ «6,000.00CR»
 * مبلغاً أصلاً، فتسقط أرصدة الصورة كلها ولا تُقرأ ولو كتب المستخدم الافتتاحي والختامي · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditF2.photoCrdr.test.ts
 *
 * F2-5 · متوسط · src/domain/bankStatement/photo.ts:36-43 (amountToken: fixDigits يترك الرمز كما هو لأن «C» و«R» ليسا في NUMERIC_CHARS، ثم
 * /^([-(]?)([\d.,]+)([)-]?)$/ يرفضه) مع photo.ts:75 (اللاحقة تُضمّ إلى المبلغ كلمةً منفصلة «CR» وحدها) وphoto.ts:83-87 (المبالغ ما قبله
 * amountToken): صورة كشفٍ إنجليزي يطبع الرصيد «6,000.00CR» ملتصقاً (وقارئ النص في الجوال يدمج الكلمتين المتقاربتين كثيراً) · الصف
 * «01/10/2026 SALARY 1,000.00 6,000.00CR» مبلغه الوحيد 1,000.00 فيصير حركةً بلا رصيد، والحركات كلها بلا أرصدة ولا إشارات:
 * «balance: chain» بلا جزءٍ يُحفظ «غير متحقَّق» (الإشارات مجهولة)، وكذلك مع افتتاحيٍّ وختاميٍّ يكتبهما المستخدم (وبلا افتتاحيٍّ مطبوع
 * «needBalances: unknown» ثم الشيء نفسه).
 * لماذا يهم: DESIGN §١٣.٢٢ (الصورة: «المبالغ بكسرين» و«ومع رصيدٍ لكل حركة … تُحدَّد الإشارة من التسلسل») وD2-9 يعدّ اللاحقة الملتصقة شكلاً
 * شائعاً في الكشوف الإنجليزية؛ فصورة كشفٍ صحيح لا تُقرأ بأي طريق، والصورة نفسها بلا اللاحقة تُقرأ.
 * السلوك الصحيح: «6,000.00CR» في الصورة مبلغٌ (رصيدٌ دائن) كـ«6,000.00 CR» المفصولة، فتُقرأ الصورة: +1,000 و−200، والافتتاحي 5,000 والختامي
 * 5,800 · (والملخص هنا بلا لاحقةٍ عمداً ليُعزل هذا عن F2-7: «Opening Balance | 5,000.00 CR» المفصولة لا يُقرأ افتتاحياً في القارئ العام.)
 */
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import type { StatementResult } from '@/domain/bankStatement/read';

/** سطرٌ بعرضه من طول نصه (عشر نقاطٍ للحرف) كما في tests/d4.auditZ1.photoPages.test.ts */
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
const photo = (mark: string): OcrLine[] => [
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('5,000.00', 860, 80),
  ln('01/10/2026', 40, 100), ln('SALARY (synthetic)', 200, 100), ln('1,000.00', 720, 100), ln('6,000.00' + mark, 860, 100),
  ln('03/10/2026', 40, 140), ln('POS (synthetic)', 200, 140), ln('200.00', 560, 140), ln('5,800.00' + mark, 860, 140),
  ln('Closing Balance', 40, 180), ln('5,800.00', 860, 180),
];
const view = (r: StatementResult) => (r.ok ? { amounts: r.lines.map((l) => l.amount), balances: r.lines.map((l) => l.balance), opening: r.opening, closing: r.closing } : r.error + ':' + r.detail);
const want = { amounts: [100000, -20000], balances: [600000, 580000], opening: 500000, closing: 580000 };

describe('F2-5 · [متوسط] «6,000.00CR» الملتصقة في صورة الكشف ليست مبلغاً فتسقط الأرصدة ولا تُقرأ الصورة (photo.ts:36-43 و75)', () => {
  test('الضابط: الصورة نفسها برصيدٍ بلا لاحقة، وبلاحقةٍ مفصولة «6,000.00 CR»، تُقرأ', () => {
    expect([view(readStatementPhoto(photo(''))), view(readStatementPhoto(photo(' CR')))]).toEqual([want, want]);
  });

  test('«6,000.00CR» ملتصقة: تُقرأ الصورة كالمفصولة', () => {
    // (الواقع: 'balance:chain' بلا جزءٍ يُحفظ)
    expect(view(readStatementPhoto(photo('CR')))).toEqual(want);
  });

  test('ولو كتب المستخدم الافتتاحي والختامي من رأس الكشف', () => {
    // (الواقع: 'balance:chain' بلا جزءٍ يُحفظ: الحركات بلا رصيدٍ ولا إشارة)
    expect(view(readStatementPhoto(photo('CR'), { opening: 500000, closing: 580000 }))).toEqual(want);
  });
});
