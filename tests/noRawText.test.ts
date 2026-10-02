/**
 * حارس فيض النصوص: لا استيراد Text الخام من react-native خارج مكوّنات الواجهة
 * الأساسية المعتمدة · فالنصوص كلها عبر T/Num الموحدين بانكماشهما وقصّهما.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const ALLOWED = new Set([
  'src/ui/components.tsx',
  'src/ui/AppDialog.tsx',
  'src/ui/Sheet.tsx',
  'src/ui/FileViewer.tsx',
  'src/ui/Toast.tsx',
  'src/ui/Screen.tsx',
  'src/ui/ActionMenu.tsx',
  'src/ui/DateField.tsx',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

test('لا Text خام من react-native خارج المكوّنات المعتمدة', () => {
  const offenders: string[] = [];
  for (const base of ['app', 'src']) {
    for (const f of walk(path.join(ROOT, base))) {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      if (ALLOWED.has(rel)) continue;
      const src = fs.readFileSync(f, 'utf8');
      const m = src.match(/import\s*\{[^}]*\bText\b[^}]*\}\s*from\s*'react-native'/);
      if (m) offenders.push(rel);
    }
  }
  expect(offenders).toEqual([]);
});
