/**
 * المدقق D2 · الجولة الخامسة عشرة · على f5036b1 · الشاشة تحسب matchSuggestions مرتين في كل عرضٍ وبعد كل اعتماد (مباشرةً، ثم داخل
 * collectionSuggestions)، فعمارةٌ من ثلاثمئة وحدةٍ دفاترها مسجَّلة تتجاوز حدّ الثانية والنصف · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditD2.screenPerf.test.ts
 *
 * D2-12 · منخفض · app/bankStatement.tsx:75-80 (useMemo لـmatchSuggestions ثم لـcollectionSuggestions، وكلاهما يُعاد بعد كل bump) مع
 * src/domain/bankStatement/collect.ts:70 (collectionSuggestions يبدأ بـmatchSuggestions كاملاً ليعرف السطور التي لها حركة) وstore.ts:111-126
 * (كل زوجٍ بالمبلغ نفسه في ±14 يوماً: 3,600 سطر × نحو 300 حركة بإيجارٍ واحد ≈ مليون زوج): سنةٌ لعمارةٍ من ثلاثمئة وحدةٍ بإيجارٍ واحد
 * (1,500)، والتحصيل كله مسجَّلٌ في الدفاتر (3,600 إيداع)، وكشف السنة محفوظ · matchSuggestions وحده نحو 0.8–1.5 ثانية على Node هنا،
 * والشاشة تحسبه مرتين فنحو 1.9–2.4 ثانية لكل عرض · وHermes على الجوال أبطأ بأضعاف، وكل «اعتماد» فردي يعيد الحساب كله.
 * لماذا يهم: هذا هو الاستعمال الأول للمطابقة (الدفاتر مسجَّلة والكشف يُطابَق بها)، وحدّ V10 وX7 ثانيةٌ ونصف لهذا الحجم؛ اختبار X7
 * قاس collectionSuggestions بلا حركاتٍ مسجَّلة فلم يظهر.
 * السلوك الصحيح: ما تحسبه الشاشة للعرض الواحد (المطابقة والتحصيل معاً) في أقل من ثانيةٍ ونصف لهذا الحجم (مثلاً: المطابقة مرةً واحدة
 * تُمرَّر للتحصيل).
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { depositCashToBank, ownerCashIn } from '@/domain/cashOps';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, matchSuggestions } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';

const UNITS = 300;

describe('D2-12 · [منخفض] matchSuggestions يُحسب مرتين لكل عرضٍ من الشاشة: نحو ثانيتين لثلاثمئة وحدةٍ وسنة (app/bankStatement.tsx:75-80 · collect.ts:70)', () => {
  test('سنةٌ لثلاثمئة وحدةٍ مسجَّلةٍ في الدفاتر: ما يحسبه العرض الواحد في أقل من ثانيةٍ ونصف', () => {
    const dates: string[] = [];
    for (let m = 1; m <= 12; m++) for (let i = 0; i < UNITS; i++) dates.push(`2026-${String(m).padStart(2, '0')}-${String(1 + (i % 9)).padStart(2, '0')}`);
    dates.sort();
    let bal = 0;
    const rows = dates.map((d, i) => { bal += 150000; return [d.replace(/-/g, '/'), 'حوالة واردة مصطنعة ' + (i % UNITS), '', '1,500.00', (bal / 100).toFixed(2)]; });
    const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'], ...rows]);
    if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); // i18n-exempt: رسالة اختبار
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع D2-12', 0);
    ownerCashIn(db, { amountHalalas: 150000 * dates.length, date: '2025-12-31' });
    for (const d of dates) depositCashToBank(db, { bankId: bank, amountHalalas: 150000, date: d, notes: 'إيداع مصطنع' });
    saveStatement(db, bank, r, { name: 'year-d2-12.pdf', hash: 'd2-12' });
    const t0 = Date.now();
    // كما تحسبه الشاشة لعرضٍ واحد (useMemo suggestions ثم useMemo collects)
    const suggestions = matchSuggestions(db, bank);
    const collects = collectionSuggestions(db, bank);
    const ms = Date.now() - t0;
    expect([suggestions.length, collects.length]).toEqual([3600, 0]);
    // (الواقع هنا: 1,850–2,400 ms)
    expect(ms < 1500 ? 'ok' : ms + 'ms').toBe('ok');
    db.close();
  });
});
