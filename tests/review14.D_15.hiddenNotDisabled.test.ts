/**
 * المراجعة الشاملة 2026-11-13 · D-15 · منخفض · أزرارٌ معطَّلة تظهر بدل أن تغيب.
 * قرار المالك 2026-08-24: «الزر الذي لا يصحّ فعله في هذه الحالة لا يُعرض إطلاقاً. لا معطَّلاً».
 * السيناريو: «ترحيل القيد» معطَّل حتى يتوازن القيد، وأزرار رمز القفل معطَّلة حتى يكتمل الرمز.
 * الصحيح: الزر يغيب، وسبب غيابه ظاهر (شريط التوازن في القيد، وخانة الرمز نفسها في القفل).
 * المستثنى: التعطيل أثناء عمليةٍ جارية (busy وأمثالها) ريثما تنتهي، فليس حالةً لا يصحّ فيها الفعل بل انتظار.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}
const IN_PROGRESS = new Set(['busy', 'exporting', 'scanning', 'saving', 'loading', 'working']);

test('D-15 لا زرّ معطَّل لشرطٍ لم يتحقق · يغيب بدل ذلك', () => {
  const bad: string[] = [];
  for (const f of [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'src', 'ui'))]) {
    const src = fs.readFileSync(f, 'utf8');
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node) => {
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && /^Btn/.test(n.tagName.getText(sf))) {
        for (const a of n.attributes.properties) {
          if (!ts.isJsxAttribute(a) || a.name.getText(sf) !== 'disabled') continue;
          const e = a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
          const ok = e && ts.isIdentifier(e) && IN_PROGRESS.has(e.text);
          if (!ok) bad.push(`${path.relative(ROOT, f)}:${sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1} ${a.getText(sf)}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  expect(bad).toEqual([]);
});
