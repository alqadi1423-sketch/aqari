/**
 * المراجعة الشاملة 2026-11-13 · D-20 · منخفض · دائرة تحميل عائمة.
 * قرار المالك 2026-08-22: «ومؤشّر التحميل بشريط تقدّم ونصّ المرحلة، لا دائرة عائمة.»
 * السيناريو: تحميل الخطوط عند الإقلاع، وبوابة الدخول، و«تأكيد» أثناء التنفيذ، وتجهيز التقرير، ونسخة ما قبل الترقية،
 * وفتح الملف: كلها ActivityIndicator.
 * الصحيح: مكوّنٌ واحد (ProgressTrack/StageProgress) شريطٌ بنسبته إن عُرفت ويتحرّك إن لم تُعرف، ومعه نص المرحلة.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

test('D-20 لا ActivityIndicator في الواجهة', () => {
  const hits = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'src', 'ui'))]
    .filter((f) => /ActivityIndicator/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f));
  expect(hits).toEqual([]);
});

test('D-20 المؤشّر الموحَّد: شريطٌ بنسبته أو متحرّك، ومعه نص المرحلة', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components.tsx'), 'utf8');
  expect(src).toMatch(/export function ProgressTrack\(/);
  expect(src).toMatch(/export function StageProgress\(/);
  const stage = src.slice(src.indexOf('export function StageProgress('));
  expect(stage.slice(0, stage.indexOf('\n}\n'))).toMatch(/<ProgressTrack/);
  // بوابة الدخول تقول المرحلة دائماً
  const auth = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'AuthGate.tsx'), 'utf8');
  expect(auth).toMatch(/<StageProgress label=\{msg \?\? t\('common\.loading'\)\}/);
});
