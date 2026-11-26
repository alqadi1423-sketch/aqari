/**
 * المدقق الخارجي J · الجولة الخامسة · حجب الموضع وسطر الفشل (failureWhere/whereLabel · 09afd0b إصلاح H٣) كما هو في 662e4ae.
 * الوعد (crashReport.ts:74-77 وDESIGN §١٣.١٨ د): «كل كلمةٍ لاتينية أو بكتابةٍ أخرى تُحجب، والكلمة العربية تبقى إن كانت من كلمات
 * التطبيق وحدها» · لكن الخطوة الثالثة تُبقي كتلة U+0600–U+06FF كلها، والرابعة لا تفحص إلا U+0621–U+0652 وU+0670 · فحروف الكتابة
 * العربية الممتدة (الفارسية والأردية: پ چ ژ ک گ ی ہ ھ ٹ ڈ ڤ …) تعبر بلا حجبٍ ولا مطابقةٍ بكلمات التطبيق، وتقطع الكلمة فيبقى منها ما
 * بينها · وسطر الفشل يقرؤه أعضاء المنشأة ذوو سجل العمليات، والتقرير يصل المالك · بيانات مصطنعة.
 *   TZ=Asia/Riyadh npx jest tests/auditJ.whereMask.test.ts
 */
import { failureWhere } from '@/domain/crashReport';

const EXTENDED = /[ٱ-ۓەۮۯۺ-ۿ]/;

test('J١٢ · اسم ملفٍ بالأردية أو الفارسية في الموضع (library.tsx:280 «تعذّر حفظ » + اسم المرفق) يعبر حجبه حروفاً', () => {
  const cases = ['تعذّر حفظ عقد پرویز چوہدری', 'تعذّر حفظ صورة ھویت', 'تعذّر حفظ عقد کریم'];
  const out = cases.map((s) => failureWhere(s));
  // eslint-disable-next-line no-console
  console.log('J12 ·', cases.map((s, i) => `«${s}» ← «${out[i]}»`).join(' · '));
  for (const o of out) expect(o).not.toMatch(EXTENDED);
});
