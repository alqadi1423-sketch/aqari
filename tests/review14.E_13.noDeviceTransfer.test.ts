/**
 * المراجعة الشاملة 2026-11-13 · E-13 · منخفض · allowBackup=false لا يمنع النقل من جهاز لجهاز في أندرويد ١٢ فأحدث.
 * السيناريو: targetSdk 36 · أداة نقل الجوال (Smart Switch وأمثالها) تنقل القاعدة كاملةً والمرفقات ونسخ الحسابات المركونة،
 * لأن allowBackup="false" يمنع نسخ قوقل السحابي وحده للتطبيقات التي تستهدف ١٢ فأحدث.
 * الصحيح (س١٥ · «allowBackup يبقى false»): android:dataExtractionRules بملفٍ يستثني كل نطاقٍ في <cloud-backup> و<device-transfer>،
 * فلا تخرج بيانات التطبيق بأداة النقل، وتعود من السحابة عند الدخول.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const DOMAINS = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'];

test('E-13 الـManifest يشير إلى قواعد الاستخراج ويُبقي allowBackup=false', () => {
  const m = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const app = /<application\b[^>]*>/.exec(m)![0];
  expect(app).toMatch(/android:allowBackup="false"/);
  expect(app).toMatch(/android:dataExtractionRules="@xml\/data_extraction_rules"/);
});

test('E-13 كل نطاقٍ مستثنى من النسخ السحابي ومن النقل بين الأجهزة', () => {
  const x = read('android', 'app', 'src', 'main', 'res', 'xml', 'data_extraction_rules.xml');
  for (const sec of ['cloud-backup', 'device-transfer']) {
    const body = new RegExp(`<${sec}>([\\s\\S]*?)</${sec}>`).exec(x)?.[1] ?? '';
    expect(body).not.toMatch(/<include\b/);
    for (const d of DOMAINS) expect(body).toMatch(new RegExp(`<exclude domain="${d}" path="\\."\\s*/>`));
  }
});
