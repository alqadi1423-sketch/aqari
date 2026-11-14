/**
 * المدقق D2 · الجولة الخامسة عشرة · على f5036b1 · عمود «نوع العملية / Transaction Type» الوصفي يُقرأ مؤشر إشارة بالبحث عن كلمةٍ داخل نصه،
 * فيغلب تسلسل الأرصدة المطبوعة ويُرفض كشفٌ صحيح · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditD2.typeColumn.test.ts
 *
 * D2-6 · متوسط · src/domain/bankStatement/read.ts:182-183 (عمود «type» يجعل signMode = 'type') وread.ts:253-255 (الإشارة من وجود «debit/مدين/سحب»
 * أو «credit/دائن/ايداع» في أي موضعٍ من نص الخلية) مع solve/walkDay (read.ts:441-442 و483: الإشارة المعروفة لا تُراجع بالرصيد): القاموس
 * يجعل «Transaction Type» و«نوع العملية» و«نوع الحركة» و«النوع» عمود المؤشر نفسه الذي أُضيف لـ«Cr/Dr» (V8 وX5)، لكن قيم هذه الأعمدة في
 * الكشوف وصفية: «Credit Card Payment» (سداد البطاقة الائتمانية: خارجٌ من الحساب) تُقرأ دائناً، و«Debit Card Refund» (استرداد: داخل) تُقرأ
 * مديناً، و«رسوم إيداع شيك» تُقرأ إيداعاً، و«عكس عملية سحب» تُقرأ سحباً · والرصيد المطبوع بعد كل سطرٍ يقول العكس، فيسقط التسلسل
 * «balance: chain» ولا يُعرض الحفظ غير المتحقَّق (بعض الإشارات «مجهولة» لنوعٍ بلا كلمة) ولا «أعمدة الكشف» لتصحيح الدور.
 * لماذا يهم: كشفٌ صحيح بأرصدةٍ لكل سطرٍ لا يُقرأ بسبب عمودٍ وصفي، والأرصدة وحدها كانت تحدّد كل إشارة (كما في الصورة: «ومع رصيدٍ لكل حركة
 * تُترك العلامات وتُحدَّد الإشارة من التسلسل»).
 * السلوك الصحيح: مع رصيدٍ مطبوعٍ لكل سطر لا تغلب كلمةٌ في نصٍّ وصفيٍّ التسلسل: يُقرأ الكشفان بإشارات أرصدتهما · (ويبقى V8 وX5 وU13:
 * «CR/DR» في عمود المؤشر تقرأ إشارتها.)
 */
import { readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';

const view = (r: StatementResult) => (r.ok ? { amounts: r.lines.map((l) => l.amount), closing: r.closing } : r.error + ':' + r.detail);
const drop = (rows: string[][], col: number) => rows.map((r) => (r.length >= 5 ? r.filter((_, i) => i !== col) : r));

const EN = [
  ['Opening Balance', '5,000.00'],
  ['Date', 'Transaction Type', 'Description', 'Amount', 'Balance'],
  ['01/10/2026', 'Incoming Transfer', 'RENT OCT (synthetic)', '2,500.00', '7,500.00'],
  ['03/10/2026', 'Credit Card Payment', 'CARD 4000 (synthetic)', '1,000.00', '6,500.00'],
  ['05/10/2026', 'Debit Card Refund', 'MERCHANT (synthetic)', '200.00', '6,700.00'],
  ['Closing Balance', '6,700.00'],
];
const AR = [
  ['الرصيد الافتتاحي', '5,000.00'],
  ['التاريخ', 'نوع العملية', 'البيان', 'المبلغ', 'الرصيد'],
  ['01/10/2026', 'حوالة واردة', 'إيجار مصطنع', '2,500.00', '7,500.00'],
  ['03/10/2026', 'رسوم إيداع شيك', 'رسوم مصطنعة', '15.00', '7,485.00'],
  ['05/10/2026', 'عكس عملية سحب', 'استرداد مصطنع', '200.00', '7,685.00'],
  ['الرصيد الختامي', '7,685.00'],
];

describe('D2-6 · [متوسط] نصٌّ وصفي في عمود «نوع العملية» يغلب الأرصدة المطبوعة فيُرفض كشفٌ صحيح (read.ts:253-255)', () => {
  test('الضابط: الكشفان بلا عمود النوع يُقرآن بإشاراتهما من تسلسل الأرصدة', () => {
    expect([view(readStatementGrid(drop(EN, 1))), view(readStatementGrid(drop(AR, 1)))]).toEqual([
      { amounts: [250000, -100000, 20000], closing: 670000 }, { amounts: [250000, -1500, 20000], closing: 768500 }]);
  });

  test('«Credit Card Payment» خارجٌ و«Debit Card Refund» داخلٌ كما تقول الأرصدة', () => {
    // (الواقع: 'balance:chain')
    expect(view(readStatementGrid(EN))).toEqual({ amounts: [250000, -100000, 20000], closing: 670000 });
  });

  test('«رسوم إيداع شيك» خارجٌ و«عكس عملية سحب» داخلٌ كما تقول الأرصدة', () => {
    // (الواقع: 'balance:chain')
    expect(view(readStatementGrid(AR))).toEqual({ amounts: [250000, -1500, 20000], closing: 768500 });
  });
});
