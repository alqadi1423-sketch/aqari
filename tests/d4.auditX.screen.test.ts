/**
 * المدقق الخارجي X · الجولة الثانية عشرة · ورقة «الافتتاحي والختامي» في شاشة كشف البنك (app/bankStatement.tsx) بعد 7ef3f8e: الختامي لا يُعبّأ،
 * والورقة تقرأ بـtoHalalas(ask.closing) · يسقط على الشيفرة الحالية ويصف السلوك الصحيح · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditX.screen.test.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { toHalalas } from '@/domain/money';

describe('X8 · [منخفض] الختامي الفارغ في ورقة «needBalances» يُقرأ صفراً، فكشفٌ يثبت ختاميه بآخر رصيدٍ مطبوع يُرفض «لا يتوازن» ويُعرض حفظه «غير متحقَّق» (app/bankStatement.tsx:119 و374)', () => {
  // كشفٌ أول سطوره بلا رصيد ولا افتتاحي مطبوع: needBalances «opening» وحده (الختامي يشهد له آخر رصيدٍ مطبوع) · الورقة تُعبّئ الافتتاحي بما
  // اشتُق وتترك الختامي فارغاً (7ef3f8e)، ثم تقرأ بـ{ opening, closing: toHalalas('') } = 0 · فالمستخدم الذي يؤكد الافتتاحي ولا يكتب ختامياً
  // لا يحتاجه الكشف يرى «لم يُقرأ … لا يتوازن» ويُعرض عليه حفظه «غير متحقَّق» · وقبل 7ef3f8e كان الختامي معبّأً فيُقرأ الكشف متحقَّقاً
  const screen = fs.readFileSync(path.join(__dirname, '..', 'app/bankStatement.tsx'), 'utf8');
  test('تأكيد الافتتاحي المعبّأ والختامي فارغ: الكشف يُقرأ متحقَّقاً بآخر رصيدٍ مطبوع', () => {
    // ما تكتبه الشاشة في الورقة وما تقرأ به
    const blank = /opening: r\.partial\?\.opening != null \? plain\(r\.partial\.opening\) : '', closing: '([^']*)'/.exec(screen);
    expect(blank).not.toBeNull();
    // الإصلاح: الفارغ «لم يُكتب» (undefined) لا صفر
    expect(screen).toContain("closing: ask.closing.trim() ? toHalalas(ask.closing) : undefined");
    const grid = [['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/02', 'حوالة واردة مصطنعة', '', '500.00', ''],
      ['2026/10/02', 'رسوم مصطنعة', '10.00', '', '1,490.00'],
      ['2026/10/05', 'سداد مصطنع', '90.00', '', '1,400.00']];
    const first = readStatementGrid(grid);
    expect(first.ok ? 'ok' : [first.error, first.detail, first.partial?.opening]).toEqual(['needBalances', 'opening', 100000]);
    const again = readStatementGrid(grid, { opening: toHalalas('1000.00'), closing: blank![1].trim() ? toHalalas(blank![1]) : undefined });
    // الواقع: balance:closing (الختامي الفارغ صفر) · الصحيح: الفارغ «لم يُكتب» فيُقرأ الكشف ويثبت ختاميه 1,400 بآخر رصيد
    expect(again.ok ? [again.opening, again.closing] : again.error + ':' + again.detail).toEqual([100000, 140000]);
  });
});
