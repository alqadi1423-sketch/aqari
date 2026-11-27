/**
 * قرار المالك 2026-11-26: «الودجت اخفها حاليا واجل العمل عليها».
 * مخفيةٌ لا محذوفة: الكود والاختبارات باقية لتُستأنف، والإظهار بعلمٍ واحد WIDGETS_ENABLED وثلاث سماتٍ في البيان:
 *  - لا بطاقة «ودجت الشاشة» في الإعدادات.
 *  - مستقبلات الودجت الثلاثة في البيان android:enabled="false"، فلا تظهر في قائمة ودجت المشغّل، وما وُضع منها يُزال.
 *  - لا تُكتب لقطة الودجت (لا عمل بلا فائدة، ولا مبالغ في ملفٍ لا يقرؤه شيء)، وما كُتب قبلُ يُحذف عند الإقلاع.
 *  - الجوال الافتراضي (٠٧) يثبت أن النظام لا يعرض أياً منها.
 */
import fs from 'fs';
import path from 'path';
import { WIDGETS_ENABLED } from '@/domain/features';

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

test('العلم مطفأ', () => {
  expect(WIDGETS_ENABLED).toBe(false);
});

test('البيان: مستقبلات الودجت الثلاثة معطّلة', () => {
  const m = read('android/app/src/main/AndroidManifest.xml');
  for (const r of ['TodayStripWidget', 'QuickActionsWidget', 'CollectionPanelWidget']) {
    expect([r, m]).toEqual([r, expect.stringMatching(new RegExp(`<receiver android:name="\\.${r}" android:exported="false" android:enabled="false">`))]);
  }
});

test('الإعدادات: بطاقة «ودجت الشاشة» مشروطةٌ بالعلم', () => {
  const s = read('app/settings.tsx');
  expect(s).toMatch(/\{WIDGETS_ENABLED && canView\(access, 'collect'\) \? <Card>\s*<CardTitle>ودجت الشاشة<\/CardTitle>/);
});

test('المخزن: لا لقطة والعلم مطفأ، وما كُتب قبلُ يُحذف عند الإقلاع', () => {
  const s = read('src/ui/store.tsx');
  expect(s).toMatch(/if \(WIDGETS_ENABLED\) scheduleWidgetSnapshot\(db\);/);
  expect(s).toMatch(/if \(WIDGETS_ENABLED\) writeWidgetSnapshot\(db\);\s*else removeWidgetSnapshot\(\);/);
  expect(read('src/services/widgetService.ts')).toMatch(/export function removeWidgetSnapshot\(\): void \{/);
});

test('الجوال الافتراضي ٠٧: لا ودجت من التطبيق لدى النظام', () => {
  const f = read('e2e/maestro/07-widget.sh');
  expect(f).toMatch(/\[ "\$\{n:-0\}" -eq 0 \]/);
});
