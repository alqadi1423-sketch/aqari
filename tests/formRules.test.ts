/**
 * نماذج الإضافة والتعديل (قرار المالك 2026-10-07):
 * - لا أمثلة مكتوبة داخل الخانات (أرقام نموذجية، أو «05XXXXXXXX»، أو بريد، أو «مثل…»، أو قوائم خيارات) · والعبارة الإرشادية («اختر…») تبقى.
 * - الخانة الإلزامية لا تُظلَّل بالأحمر قبل محاولة حفظ ناقصة: لا `error={!x.trim()}` · بل useSaveAttempt.
 * - نموذج الساكن في ورقته الخاصة لا مضمَّناً في ورقة العقد.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..');
function sources(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.tsx$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(root, 'app'));
  walk(path.join(root, 'src', 'ui'));
  return out;
}
const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');

test('لا أمثلة مكتوبة داخل الخانات', () => {
  const EXAMPLE = /placeholder=(?:"[^"]*(?:\d|X{3}|@|مثل)[^"]*"|\{[A-Z_]+\.join\()/;
  const bad: string[] = [];
  for (const f of sources()) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (EXAMPLE.test(l)) bad.push(`${rel(f)}:${i + 1}`); });
  }
  expect(bad).toEqual([]);
});

test('الخانة الإلزامية لا تُظلَّل قبل محاولة الحفظ', () => {
  const EAGER = /error=\{!\s*[\w.]+\.trim\(\)\s*\}/;
  const bad: string[] = [];
  for (const f of sources()) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (EAGER.test(l)) bad.push(`${rel(f)}:${i + 1}`); });
  }
  expect(bad).toEqual([]);
});

test('إضافة الساكن في ورقته الخاصة · لا قيمة مختارة سلفاً', () => {
  const contracts = fs.readFileSync(path.join(root, 'app', '(tabs)', 'contracts.tsx'), 'utf8');
  expect(contracts).toContain('<OccupantSheet');
  expect(contracts).not.toMatch(/useState<string>\('زوجة'\)/);
  const sheet = fs.readFileSync(path.join(root, 'src', 'ui', 'OccupantSheet.tsx'), 'utf8');
  expect(sheet).toMatch(/<Sheet visible/);
  expect(sheet).toMatch(/useSaveAttempt/);
});
