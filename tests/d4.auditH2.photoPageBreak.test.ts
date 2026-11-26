/**
 * المدقق H2 · الجولة السابعة عشرة · على 3f2c136 · قارئ الصورة ينقل كل صفّ ملخصٍ بعد أول حركةٍ إلى آخر الجدول، فلا يرى القارئ العام موضعه:
 * «الرصيد المرحَّل» في وسط صورةٍ تعبر فاصل صفحتين يصير ختامياً (خلاف D2-5)، و«المنقول» بعده يصير افتتاحياً (خلاف F2-9) · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditH2.photoPageBreak.test.ts
 *
 * H2-8 · منخفض · src/domain/bankStatement/photo.ts:107 («(moves.length ? tail : head).push(...)»: صفوف الملخص بعد أول حركةٍ كلها بعد الحركات
 * كلها في الجدول المصنوع، photo.ts:132-137) مع read.ts:208-210 و316 (المرحَّل ختاميٌّ إن لم تأتِ بعده حركة) وread.ts:310-312 (الافتتاحي بعد
 * الحركات كلها): لقطة شاشةٍ لكشف PDF على الجوال تعبر فاصل الصفحتين (أسفل الأولى وأعلى الثانية): افتتاحي 5,000 ثم حركتان (6,500) ثم «Balance
 * Carried Forward 6,500.00» و«Page 1 of 2» ثم عناوين الثانية و«Balance Brought Forward 6,500.00» ثم حركة (6,300)، واللقطة تنتهي قبل الختامي:
 *  أ) المرحَّل 6,500 ختاميٌّ مطبوع فـ«balance: closing»، ويُعرض حفظه «غير متحقَّق» · واللقطة نفسها بلا سطري المرحَّل والمنقول تُقرأ.
 *  ب) وبلا افتتاحيٍّ أعلى اللقطة: «balance: opening» (المنقول 6,500 افتتاحيٌّ) بلا ما يُحفظ ولا ما يُسأل، وبلا السطرين «needBalances» فيُسأل
 *     المستخدم الافتتاحي.
 * لماذا يهم: لقطة الشاشة أشيع ما يصوّره المستخدم من كشف PDF على جواله، والكشف الطويل يعبر الصفحات · وقاعدتا D2-5 وF2-9 بموضع الملخص من
 * الحركات لا تعملان في الصورة، فكشفٌ صحيح يُحفظ «غير متحقَّق» وينبّه به تقرير الشهر، أو يُرفض بلا سبيل.
 * السلوك الصحيح: صفّ الملخص في الصورة بموضعه من الحركات كما في PDF: المرحَّل الذي تليه حركة ليس ختامياً، والمنقول بعد حركةٍ ليس افتتاحياً،
 * فتُقرأ اللقطة كما تُقرأ بلا السطرين.
 */
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { type StatementResult } from '@/domain/bankStatement/read';

/** سطرٌ بعرضه من طول نصه (عشر نقاطٍ للحرف) كما في tests/d4.auditZ1.photoPages.test.ts */
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
const shot = (opening: boolean, pageBreak: boolean): OcrLine[] => [
  ln('Date Description Debit Credit Balance', 40, 60),
  ...(opening ? [ln('Opening Balance', 40, 80), ln('5,000.00', 880, 80)] : []),
  ln('01/10/2026', 40, 100), ln('SALARY', 200, 100), ln('1,000.00', 720, 100), ln('6,000.00', 880, 100),
  ln('02/10/2026', 40, 140), ln('TRANSFER IN', 200, 140), ln('500.00', 720, 140), ln('6,500.00', 880, 140),
  ...(pageBreak ? [ln('Balance Carried Forward', 40, 180), ln('6,500.00', 880, 180)] : []),
  ln('Page 1 of 2', 40, 220),
  ln('Date Description Debit Credit Balance', 40, 300),
  ...(pageBreak ? [ln('Balance Brought Forward', 40, 340), ln('6,500.00', 880, 340)] : []),
  ln('05/10/2026', 40, 380), ln('POS PURCHASE', 200, 380), ln('200.00', 560, 380), ln('6,300.00', 880, 380),
];
const view = (r: StatementResult) => (r.ok ? { amounts: r.lines.map((l) => l.amount), opening: r.opening, closing: r.closing } : r.error + ':' + r.detail);

describe('H2-8 · [منخفض] الصورة تنقل «المرحَّل» و«المنقول» إلى آخر الجدول فيصيران ختامياً وافتتاحياً (photo.ts:107)', () => {
  test('الضابط: اللقطة بلا سطري المرحَّل والمنقول تُقرأ (افتتاحي 5,000 وختامي 6,300)', () => {
    expect(view(readStatementPhoto(shot(true, false)))).toEqual({ amounts: [100000, 50000, -20000], opening: 500000, closing: 630000 });
  });

  test('(أ) والمرحَّل والمنقول في وسطها: تُقرأ كما بدونهما، لا «balance: closing» بعرض حفظٍ «غير متحقَّق»', () => {
    // (الواقع: 'balance:closing')
    expect(view(readStatementPhoto(shot(true, true)))).toEqual({ amounts: [100000, 50000, -20000], opening: 500000, closing: 630000 });
  });

  test('(ب) وبلا افتتاحيٍّ أعلاها: يُسأل المستخدم الافتتاحي كما بدونهما («needBalances») لا رفضٌ «balance: opening»', () => {
    const r = readStatementPhoto(shot(false, true));
    // (الواقع: ['needBalances:unknown', 'balance:opening'])
    expect([view(readStatementPhoto(shot(false, false))), view(r)]).toEqual(['needBalances:unknown', 'needBalances:unknown']);
  });
});
