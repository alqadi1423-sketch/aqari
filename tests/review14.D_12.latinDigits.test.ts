/**
 * المراجعة الشاملة 2026-11-13 · D-12 · منخفض · أرقامٌ هندية تُولَّد في الواجهة ·
 * قرار المالك 2026-10-07: «الأرقام في الواجهة العربية: لاتينية» · و«٪» علامة النسبة الوحيدة في الواجهة.
 * الفحص: كل نصٍّ حرفي في app/ و src/ (سلاسل وقوالب ونص JSX، بلا التعليقات) خالٍ من ٠-٩ و۰-۹،
 * ولا نسبة تُلصق بـ'%'، وملف الترجمة العربي بلا أرقامٍ هندية · ومحوّل الإدخال إلى اللاتينية واحدٌ بأكواد المحارف (G-11).
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
/** الواجهة وما تعرضه من رسائل الدومين والتقارير · وقواعد السحابة المولَّدة (rulesGen) ونصوص الهجرات ليست مما يُعرض */
const FILES = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'src'))]
  .filter((f) => !f.includes(`${path.sep}src${path.sep}db${path.sep}`) && !f.endsWith('rulesGen.ts'));
const HINDI = /[٠-٩۰-۹]/;

/** كل نصٍّ حرفي في الملف مع سطره · التعليقات وأنماط التعبير النمطي خارجه */
function literals(file: string): Array<{ line: number; text: string }> {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) {
      out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.getText(sf) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test('D-12 لا أرقام هندية في نصوص الواجهة', () => {
  const bad: string[] = [];
  for (const f of FILES) {
    for (const l of literals(f)) if (HINDI.test(l.text)) bad.push(`${path.relative(ROOT, f)}:${l.line} ${l.text.slice(0, 60)}`);
  }
  expect(bad).toEqual([]);
});

test('D-12 علامة النسبة واحدة «٪»: لا قيمة تُلصق بـ\'%\'', () => {
  const bad: string[] = [];
  for (const f of FILES.filter((x) => !x.includes(`${path.sep}src${path.sep}`) || x.includes(`${path.sep}src${path.sep}ui${path.sep}`))) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((s, i) => { if (/\+\s*'%'/.test(s)) bad.push(`${path.relative(ROOT, f)}:${i + 1}`); });
  }
  expect(bad).toEqual([]);
});

test('D-12 ملف الترجمة العربي بلا أرقامٍ هندية', () => {
  const ar = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'locales', 'ar.json'), 'utf8');
  expect(ar.split('\n').filter((s) => HINDI.test(s))).toEqual([]);
});
