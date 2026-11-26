/**
 * المدقق الخارجي V · الجولة الحادية عشرة · كشف البنك · زمن الاقتراحات بأحجامٍ واقعية: الشاشة (app/bankStatement.tsx) تحسب
 * matchSuggestions وcollectionSuggestions (وهذه تستدعي الأولى ثانيةً) متزامنتين على خيط الواجهة في كل عرضٍ وبعد كل اعتماد (bump) ·
 * يسقط على الشيفرة الحالية ويصف السلوك الصحيح · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditV.perf.test.ts
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { depositCashToBank, ownerCashIn } from '@/domain/cashOps';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, matchSuggestions } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';

// اختبار زمن على آلةٍ مشتركة: يُعاد مرتين إن سقط، فالتقلّب يمرّ والانحدار الحقيقي يسقط في المحاولات الثلاث كلها
// (المراجعة الشاملة 2026-11-13 · G-5: سقط memberQuadratic على التزامٍ غيّر سطراً في docs وحده) · والحاجز باقٍ: لا عزل ولا تخطٍّ
jest.retryTimes(2, { logErrorsBeforeRetry: true });

const UNITS = 100;
/** كشف سنةٍ لعمارةٍ من مئة وحدةٍ بإيجارٍ واحد (1,500 شهرياً): إيداعٌ لكل وحدةٍ في الأيام ١–٩ من كل شهر */
function yearOfRent(): { rows: string[][]; dates: string[] } {
  const dates: string[] = [];
  for (let m = 1; m <= 12; m++) for (let i = 0; i < UNITS; i++) dates.push(`2026-${String(m).padStart(2, '0')}-${String(1 + (i % 9)).padStart(2, '0')}`);
  dates.sort();
  let bal = 0;
  const rows = dates.map((d, i) => { bal += 150000; return [d.replace(/-/g, '/'), 'حوالة واردة مصطنعة ' + (i % UNITS), '', '1,500.00', (bal / 100).toFixed(2)]; });
  return { rows, dates };
}
const read = (rows: string[][]) => {
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'], ...rows]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error);
  return r;
};
const timed = <T>(f: () => T): [T, number] => { const t0 = Date.now(); const v = f(); return [v, Date.now() - t0]; };

describe('V١٠ · [متوسط] الاقتراحات تربيعية بحساب التاريخ في أعمق الحلقة: سنةٌ لعمارةٍ من مئة وحدة نحو ٦–٧ ثوانٍ لكلٍّ منهما على Node (store.ts:93 و107 · collect.ts:99)', () => {
  // matchSuggestions يحسب dayNo (Date.UTC وقصّ النص) لكل زوج سطرٍ وحركةٍ بالمبلغ نفسه قبل شرط الأسبوعين، وأربع مراتٍ في كل مقارنة
  // فرز · وcollectionSuggestions يمرّ على كل قسطٍ لكل عقدٍ لكل إيداعٍ مفتوح ويحسب days في كلٍّ منها · فيكبران بمربع السنة، والشاشة
  // تعيدهما بعد كل «اعتماد» على خيط الواجهة (وHermes على الجوال أبطأ من Node بأضعاف)
  test('1,200 إيداع: المطابقة بالحركات المسجَّلة، والتحصيل للأقساط غير المسجَّلة · كلٌّ في أقل من ثانيةٍ ونصف', () => {
    const { rows, dates } = yearOfRent();
    // (أ) الدفاتر فيها كل إيداع: 1,200 حركة بالمبلغ نفسه
    const a = memDb();
    const bankA = addBank(a, 'بنك مصطنع للمدقق V', 0);
    ownerCashIn(a, { amountHalalas: 150000 * dates.length, date: '2025-12-31' });
    for (const d of dates) depositCashToBank(a, { bankId: bankA, amountHalalas: 150000, date: d, notes: 'إيداع مصطنع' });
    saveStatement(a, bankA, read(rows), { name: 'year.pdf', hash: 'v10-a' });
    const [m, msMatch] = timed(() => matchSuggestions(a, bankA));
    expect(m).toHaveLength(dates.length);
    // (ب) لا شيء مسجَّل: مئة عقدٍ بأقساطٍ شهرية والإيداعات كلها مفتوحة
    const b = memDb();
    const bankB = addBank(b, 'بنك مصطنع للمدقق V', 0);
    const p = addProperty(b, { name: 'عمارة مصطنعة للمدقق V' });
    for (let i = 0; i < UNITS; i++) {
      confirmContract(b, contractInput(addUnit(b, p, { unit_no: 'V-' + i }), {
        tenant: 'مستأجر مصطنع ' + i, idNumber: String(1000000700 + i), phone: '0500007' + String(i).padStart(3, '0'),
        valueHalalas: 1800000, cycle: 'شهرية', start: '2026-01-01', end: '2026-12-31', depositHalalas: 0,
      }));
    }
    saveStatement(b, bankB, read(rows), { name: 'year.pdf', hash: 'v10-b' });
    const [c, msCollect] = timed(() => collectionSuggestions(b, bankB));
    expect(c.length).toBeGreaterThan(1000);
    // الصحيح: فهرسٌ بالمبلغ والتاريخ (يوم كل سطرٍ وحركةٍ وقسطٍ يُحسب مرة) فيكون الزمن خطياً تقريباً
    expect([msMatch, msCollect].map((ms) => (ms < 1500 ? 'ok' : ms + 'ms'))).toEqual(['ok', 'ok']);
  });
});
