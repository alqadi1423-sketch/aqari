/**
 * لا نص يراه المستخدم خارج ملفات الترجمة (المرحلة الأولى من تعدد اللغات · قرار المالك ٢٠٢٦-١٠-٠٧).
 *
 * النصوص القائمة قبل هذه المرحلة تُنقل إلى المفاتيح في مرحلةٍ لاحقة، فعددها لكل ملف مجمّدٌ في
 * tests/i18n-baseline.json: لا يزيد أبداً، ويُخفَّض كلما نُقلت. والملف الجديد عدده صفر.
 * فكل شاشة أو رسالة جديدة تُكتب بمفاتيح الترجمة باللغتين.
 *
 * يُعدّ: كل نص فيه حرف عربي (نصاً أو قالباً أو نص JSX)، وكل نص إنجليزي ظاهر (نص JSX، أو قيمة خاصية
 * عرضٍ كالعنوان والتسمية). ولا يُعدّ: التعليقات، ومسارات الاستيراد، والسطر الموسوم «i18n-exempt»
 * بسببه (قيمة مخزّنة يقارن بها الكود حتى تصير رمزاً ثابتاً، أو سجل فني).
 *
 * تحديث الأساس بعد نقل نصوص: I18N_BASELINE=write npx jest tests/i18nLiterals.test.ts
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'i18n-baseline.json');
const DIRS = ['app', 'src'];
const SKIP = [path.join('src', 'i18n', 'locales')];
const ARABIC = /[؀-ۿ]/;
const LATIN_WORD = /[A-Za-z]{2,}/;
const UI_KEYS = new Set(['text','title', 'label', 'placeholder', 'body', 'message', 'caption', 'emptyText', 'sub', 'subtitle', 'hint', 'note', 'text', 'accessibilityLabel']);

function files(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (SKIP.some((s) => rel.startsWith(s))) continue;
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel);
    }
  };
  DIRS.forEach(walk);
  return out.sort();
}

/** عدد النصوص الظاهرة في ملف */
export function countLiterals(src: string, fileName: string): number {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = src.split('\n');
  const exempt = (n: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    // الوسم في سطر النص نفسه، أو في سطر تعليقٍ وحده فوقه
    return /i18n-exempt/.test(lines[line] ?? '') || /^\s*(\/\/|\*|\{\/\*).*i18n-exempt/.test(lines[line - 1] ?? '');
  };
  let n = 0;
  const uiKeyOf = (node: ts.Node): string | null => {
    const p = node.parent;
    if (p && ts.isJsxAttribute(p)) return p.name.getText(sf);
    // نصٌّ ابنٌ مباشر في JSX: <T>{'…'}</T>
    if (p && ts.isJsxExpression(p) && p.parent && (ts.isJsxElement(p.parent) || ts.isJsxFragment(p.parent))) return 'text';
    if (p && ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent)) return p.parent.name.getText(sf);
    if (p && ts.isPropertyAssignment(p) && p.initializer === node) return p.name.getText(sf).replace(/['"]/g, '');
    return null;
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'require') return;
    let text: string | null = null;
    let jsxText = false;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) text = node.head.text + node.templateSpans.map((s) => s.literal.text).join(' ');
    else if (ts.isJsxText(node)) { text = node.text; jsxText = true; }
    if (text !== null && !exempt(node)) {
      if (ARABIC.test(text)) n++;
      else if (LATIN_WORD.test(text) && (jsxText || UI_KEYS.has(uiKeyOf(node) ?? ''))) n++;
    }
    if (!ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
    else node.templateSpans.forEach((s) => visit(s.expression));
  };
  visit(sf);
  return n;
}

test('لا نص جديد خارج ملفات الترجمة · والقائم لا يزيد في أي ملف', () => {
  const counts: Record<string, number> = {};
  for (const f of files()) {
    const c = countLiterals(fs.readFileSync(path.join(ROOT, f), 'utf8'), f);
    if (c) counts[f.split(path.sep).join('/')] = c;
  }
  if (process.env.I18N_BASELINE === 'write') {
    fs.writeFileSync(BASELINE, JSON.stringify(counts, null, 1) + '\n');
    return;
  }
  const base: Record<string, number> = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const over = Object.entries(counts)
    .filter(([f, c]) => c > (base[f] ?? 0))
    .map(([f, c]) => `${f}: ${c} نصاً والمسموح ${base[f] ?? 0} · اكتب النص الجديد بمفتاح في src/i18n/locales`);
  expect(over).toEqual([]);
});

test('الفاحص يعدّ النص الظاهر ويترك التعليق والاستيراد والموسوم', () => {
  const src = [
    "import x from './مسار';",
    '// تعليق عربي',
    "const a = 'نص عربي';",
    "const b = `قالب ${a} عربي`;",
    "const c = <T title=\"Hello world\">{'Shown'}</T>;",
    'const d = <T>Plain text</T>;',
    "const e = 'key.name';",
    "const f = 'مرحّل'; // i18n-exempt: قيمة مخزّنة",
    "const g = { title: 'Visible title', id: 'internal_id' };",
  ].join('\n');
  expect(countLiterals(src, 'x.tsx')).toBe(6);
});
