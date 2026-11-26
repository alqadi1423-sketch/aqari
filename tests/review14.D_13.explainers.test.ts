/**
 * المراجعة الشاملة 2026-11-13 · D-13 · منخفض · جملٌ تشرح الواجهة.
 * قرار المالك (س٢٨): تُحذف كل جملةٍ تشرح الواجهة إلا رسالة الخطأ والحالة الفارغة والتأكيد ونتيجة العملية، والقائمة تُعرض عليه ·
 * ثم «أعطيك الإذن تنفّذ … حذف الجمل الشارحة حسب توصيتك» (2026-11-26).
 * المحذوف: ملاحظة مراكز التكلفة، وست ملاحظاتٍ في أوراق الأصول، وشرح قفل التطبيق، وأعضاء القناة التلقائيون، وإعلان المرفقات بعد
 * الفوترة (ميزةٌ لا تعمل)، و«ترى في المنشأة ما تجيزه لك صلاحيتك وحدها»، وفقرتا شرح نوع الخصم تحت الاختيار (تكرارٌ لوصف الخيار).
 * الباقي بالتوصية: «على هذا الجهاز بيانات من إصدار سابق…» (حالةٌ تسبق قرار الربط)، ووصف خياري الخصم داخل الاختيار، وتنبيه منصة إيجار.
 */
import fs from 'fs';
import path from 'path';

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const ar = JSON.parse(read('src/i18n/locales/ar.json'));
const en = JSON.parse(read('src/i18n/locales/en.json'));
const get = (o: Record<string, unknown>, k: string) => k.split('.').reduce<unknown>((x, p) => (x as Record<string, unknown> | undefined)?.[p], o);

const KEYS = ['assets.ui.newNote', 'assets.ui.setCostNote', 'assets.ui.transferNote', 'assets.ui.disposeNote', 'assets.ui.sellNote',
  'assets.contents.note', 'lock.about', 'chat.channelMembersAuto', 'chat.attachmentsLater'];

test('D-13 المفاتيح الشارحة خارج ملفي الترجمة وخارج الشاشات', () => {
  for (const k of KEYS) {
    expect([k, get(ar, k)]).toEqual([k, undefined]);
    expect([k, get(en, k)]).toEqual([k, undefined]);
  }
  const srcs = ['src/ui/AssetSheets.tsx', 'src/ui/AppLockSettings.tsx', 'app/chat.tsx'].map(read).join('\n');
  for (const k of KEYS) expect([k, srcs.includes(`t('${k}')`)]).toEqual([k, false]);
});

test('D-13 الجمل المكتوبة في الشاشات محذوفة، وما يبقى بالتوصية باقٍ', () => {
  expect(read('src/ui/CostCenters.tsx')).not.toMatch(/بُعدٌ مستقل فوق العقار والوحدة/);
  const gate = read('src/ui/AuthGate.tsx');
  expect(gate).not.toMatch(/ترى في المنشأة ما تجيزه لك صلاحيتك وحدها/);
  expect(gate).toMatch(/على هذا الجهاز بيانات من إصدار سابق لم تُربط بأي حساب/);
  const collect = read('app/(tabs)/collect.tsx');
  expect(collect).not.toMatch(/يُسجَّل الإيراد بقيمة ما غطّته الدفعة كاملاً، والخصم مصروفاً/);
  expect(collect).not.toMatch(/تُخفَّض قيمة القسط نفسه بمبلغ الخصم · يُسجَّل الإيراد بالمقبوض وحده/);
  expect(collect).toMatch(/sub: 'القسط يبقى بقيمته/);
  expect(collect).toMatch(/تنبيه: تخفيض القسط يخالف قيمة العقد الموثّقة في منصة إيجار/);
});
