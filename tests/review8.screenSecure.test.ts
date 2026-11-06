/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ٢٢: منع لقطة الشاشة وجدولة التنبيهات كانا يُتركان حين تكون نسخة الترقية معلّقة (appDb
 * يرمي فيبتلعه الإقلاع) · الواجهة والأصلي لا يُحمَّلان على Node فيُفحص موضعهما · بيانات مصطنعة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

test('٢٢ بوابة الترقية تطبّق منع لقطة الشاشة وتجدول التنبيهات حين تصل إلى «جاهز»', () => {
  const g = src('src/ui/UpgradeGate.tsx');
  const run = g.slice(g.indexOf('const run = useCallback'), g.indexOf('}, []);', g.indexOf('const run = useCallback')));
  const ready = run.indexOf("setPhase('ready')");
  expect(ready).toBeGreaterThan(0);
  const before = run.slice(0, ready);
  expect(before).toMatch(/applyScreenSecureFrom\(appDb\(\)\)/);
  expect(before).toMatch(/rescheduleAllNotifications\(appDb\(\)\)/);
});

test('٢٢ والأصلي يحفظ العلم ويعيده في onCreate قبل جافاسكربت', () => {
  const mod = src('android/app/src/main/java/com/aqari/app/AqariSecure.kt');
  expect(mod).toMatch(/getSharedPreferences\(PREFS, Context\.MODE_PRIVATE\)\.edit\(\)\.putBoolean\(KEY, on\)/);
  const main = src('android/app/src/main/java/com/aqari/app/MainActivity.kt');
  const onCreate = main.slice(main.indexOf('override fun onCreate'), main.indexOf('override fun onPause'));
  expect(onCreate).toMatch(/AqariSecureModule\.saved\(this\)[^\n]*FLAG_SECURE/);
});
