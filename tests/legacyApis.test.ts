/**
 * منذ SDK 57 تَرمي الدوال القديمة في expo-media-library و expo-file-system «deprecated» حين تُستدعى من
 * المسار الرئيسي · فكان «الحفظ في المعرض» يفشل على الجهاز ولا يكشفه اختبار. هذا الحارس يمنع العودة إليها.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..');
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : sources(p);
    return /\.(ts|tsx)$/.test(d.name) ? [p] : [];
  });
}
const files = [...sources(path.join(root, 'src')), ...sources(path.join(root, 'app'))];

test('expo-media-library لا يُستورد إلا من مساره القديم الصريح', () => {
  const bad = files.filter((f) => /from 'expo-media-library'/.test(fs.readFileSync(f, 'utf8')));
  expect(bad.map((f) => path.relative(root, f))).toEqual([]);
});

test('expo-file-system من مساره الرئيسي: الأصناف الجديدة وحدها', () => {
  const allowed = new Set(['File', 'Directory', 'Paths']);
  const bad: string[] = [];
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/import\s+([^;'"]+?)\s+from 'expo-file-system';/g)) {
      const names = /^\{([^}]*)\}$/.exec(m[1].trim());
      if (!names || names[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean).some((n) => !allowed.has(n))) {
        bad.push(path.relative(root, f) + ': ' + m[1].trim());
      }
    }
  }
  expect(bad).toEqual([]);
});
