/**
 * المراجعة الشاملة 2026-11-13 · D-17 · منخفض · قوائم ثقيلة.
 * السيناريو أ: تبويب العقود حيٌّ دائماً، وكل بطاقة عقد تستعلم rowBy وattachmentsFor مع كل رسم ← استعلامان لكل صف مع كل تحديث.
 * السيناريو ب: العقارات rows.map داخل ScrollView بحجم صفحة حتى ٥٠٠، والعدّاد فوق القائمة لا أسفلها (قرار المالك 2026-08-22).
 * الصحيح: ما تحتاجه البطاقات يُحسب مرةً للصفحة باستعلامٍ واحد، والعقارات FlatList افتراضية والعدّاد في ذيلها.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');

/** جسد دالةٍ مسمّاة داخل الملف */
function fnBody(src: string, file: string, name: string): string {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let out = '';
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === name && n.initializer) out = n.initializer.getText(sf);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test('D-17 بطاقة العقد لا تستعلم لكل صف: rowBy والمرفقات محسوبةٌ للصفحة', () => {
  const src = read('app', '(tabs)', 'contracts.tsx');
  const body = fnBody(src, 'contracts.tsx', 'renderContract');
  expect(body).not.toBe('');
  expect(body).not.toMatch(/rowBy\(/);
  expect(body).not.toMatch(/attachmentsFor\(/);
});

test('D-17 العقارات قائمة افتراضية والعدّاد في ذيلها', () => {
  const src = read('app', '(tabs)', 'properties.tsx');
  expect(src).not.toMatch(/rows\.map\(\(p\)/);
  expect(src).toMatch(/<FlatList/);
  expect(src).toMatch(/ListFooterComponent=\{<Pager pager=\{pager\} total=\{totalRows\} \/>\}/);
});
