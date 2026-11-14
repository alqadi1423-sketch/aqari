/**
 * المتحقق المستقل على إصلاح A1-2 (المراجعة الشاملة 2026-11-13) · الشاشتان في app/(tabs)/contracts.tsx · بيانات مصطنعة.
 *
 * العيب: زرّ الحفظ في «تفاصيل التصرف بالتأمين» (وزرّ التأكيد في «إلغاء العقد») يختفي متى كان arrearsOver، ومنه «مقابل الأقساط
 *   المتأخرة أكبر من مبلغ الخصم نفسه» · لكن الخانة وخطأها لا يظهران إلا والخصم موجب (arrearsDue > 0 && الخصم > 0)، وarrearsH يبقى
 *   ما في الخانة ولو صار الخصم صفراً.
 *   السيناريو: تسويةٌ قائمة سُدّد فيها مارس من التأمين (١٬٠٠٠) · يفتحها المالك فتُملأ الخانة بما سدّده التأمين «1000.00»
 *   (depositArrearsPaid) · يقرر ردّ التأمين كله: الخصم ٠ والمسترد ١٬٠٠٠ · فالفرق صفرٌ أخضر، والزرّ يختفي، والخانة وخطؤها مخفيان ·
 *   لا سبب ظاهر ولا طريق إلا أن يعيد الخصم موجباً فيمسح الخانة ثم يصفّره. وفي «إلغاء العقد» كذلك إن كُتب مقابلٌ ثم صُفّر الخصم.
 * السلوك الصحيح: ما يُخفي الزرّ يُرى سببه · إما أن يُعرض الخطأ (أو الخانة) متى كان arrearsOver، وإما ألا يُحسب مقابلٌ للأقساط
 *   والخصم صفر (arrearsH صفرٌ حين لا خصم).
 * (الشاشات تُفحص من نصّها كما في tests/d4.auditD2.unmatchUi.test.ts: لا عارض React Native في الاختبارات)
 *   TZ=Asia/Riyadh npx jest tests/review11.A1_2.arrearsHiddenError.test.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const src = fs.readFileSync(path.join(__dirname, '..', 'app', '(tabs)', 'contracts.tsx'), 'utf8');
/** نصّ دالة الشاشة إلى الدالة التالية في الملف */
function sheet(name: string): string {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('no ' + name); // i18n-exempt: رسالة اختبار
  const j = src.indexOf('\nfunction ', i + 10);
  return src.slice(i, j < 0 ? undefined : j);
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe.each([
  ['SettlementSheet', 'toHalalas(deduction)'],
  ['CancelSheet', 'dedH'],
])('A1-2 · %s: ما يُخفي زرّ الحفظ لـ«مقابل الأقساط» يُرى سببه والخصم صفر', (name, ded) => {
  test('الخطأ ظاهرٌ متى أخفى الزرّ، أو لا مقابل والخصم صفر', () => {
    const b = sheet(name);
    // الزرّ يختفي بـ arrearsOver، وهو يشمل «أكبر من الخصم»
    expect(b).toMatch(/!arrearsOver/);
    expect(b).toMatch(/arrearsH > [^?]*\? t\('deposit\.arrearsOverDeduction'\)/);
    // شرط عرض الخانة وخطئها
    const guard = b.match(/\{([^{}]*)\?\s*\(\s*<>\s*<Field label=\{t\('deposit\.arrearsLabel'\)\}/)?.[1] ?? '';
    expect(guard).not.toBe('');
    const dedPositive = new RegExp(esc(ded) + '\\s*>\\s*0');
    // (أ) الخطأ يُعرض والخصم صفر: الشرط لا يشترط خصماً موجباً، أو يُظهر الخانة متى كان الخطأ
    const shownOnError = !dedPositive.test(guard) || /arrearsOver|arrearsH\s*>\s*0/.test(guard);
    // (ب) لا مقابل والخصم صفر: arrearsH صفرٌ حين لا خصم
    const h = b.match(/const arrearsH = ([^;]+);/)?.[1] ?? '';
    const zeroWithoutDeduction = dedPositive.test(h) || new RegExp(esc(ded) + '\\s*(<=|===)\\s*0').test(h);
    // اليوم: الشرط «arrearsDue > 0 && الخصم > 0» وarrearsH ما في الخانة · فالزرّ يختفي ولا سبب ظاهر
    expect(shownOnError || zeroWithoutDeduction).toBe(true);
  });
});
