/**
 * قرار المالك 2026-10-08T05:31Z: «حذف سجل المراجعات في نافذة الحذف: مقبول، بشرط ألا تُفتح النافذة إلا مع حذف الحساب
 * أو المسح الشامل، لا أداةً مستقلة.» · حارس: كل ما يفتح نافذة الحذف لا يُستدعى إلا من هذين المسارين.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
/** الدالة أو الطريقة المحيطة باستدعاءٍ في الملف · أقرب تعريفٍ قبله (function اسم، أو طريقة صنف async اسم() {) */
function enclosing(src: string, at: number): string {
  const before = src.slice(0, at);
  const all = [...before.matchAll(/(?:function\s+([A-Za-z0-9_]+)\s*\(|^\s{2}(?:async\s+)?([A-Za-z0-9_]+)\s*\(.*\)\s*(?::[^{]+)?\{\s*$)/gm)];
  const names = all.map((m) => m[1] ?? m[2]).filter((n) => !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(n));
  return names.length ? names[names.length - 1] : '';
}
// ما يفتح النافذة ← من يجوز أن يستدعيه
const ALLOWED: Record<string, string[]> = {
  openDeletionWindow: ['chatPurgeOrg'],
  chatPurgeOrg: ['deleteMyAccount', 'wipeEverything'],
  deleteAllData: ['deleteMyAccount'],
  deleteRowsOnly: ['wipeOrgCloud'],
  wipeOrgCloud: ['wipeEverything'],
};

test('نافذة الحذف لا تُفتح إلا من حذف الحساب أو المسح الشامل', () => {
  const found: string[] = [];
  for (const f of [...files(join(ROOT, 'src')), ...files(join(ROOT, 'app'))]) {
    const src = readFileSync(f, 'utf8');
    for (const name of Object.keys(ALLOWED)) {
      for (const m of src.matchAll(new RegExp('(?<![A-Za-z0-9_])' + name + '\\(', 'g'))) {
        const line = src.slice(src.lastIndexOf('\n', m.index!) + 1, src.indexOf('\n', m.index!));
        if (/^\s*(export\s+)?(async\s+)?function\s/.test(line) || /^\s*async\s+[A-Za-z]+\(/.test(line)) continue; // التعريف نفسه
        const fn = enclosing(src, m.index!);
        found.push(name + ' ← ' + fn);
        expect(ALLOWED[name]).toContain(fn);
      }
    }
  }
  // وكلٌّ مستدعى فعلاً (فلا يمرّ الحارس بلا شيء)
  for (const name of Object.keys(ALLOWED)) expect(found.some((x) => x.startsWith(name + ' '))).toBe(true);
});

test('مستند نافذة الحذف لا يُكتب إلا من دوالها', () => {
  const OWNERS = new Set(['openDeletionWindow', 'closeDeletionWindow', 'deleteRowsOnly', 'deleteAllData']);
  const seen: string[] = [];
  for (const f of [...files(join(ROOT, 'src')), ...files(join(ROOT, 'app'))]) {
    if (f.includes('rulesGen')) continue; // نصّ القواعد المولَّدة لا كتابة
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/meta\/deletion|'meta\/deletion'/g)) {
      const line = src.slice(src.lastIndexOf('\n', m.index!) + 1, src.indexOf('\n', m.index!));
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue; // تعليق
      const fn = enclosing(src, m.index!);
      seen.push(fn);
      expect(OWNERS).toContain(fn);
    }
  }
  expect(seen.length).toBeGreaterThan(0);
});
