/**
 * المراجعة الشاملة 2026-11-13 · D-27 · منخفض · زر الرجوع خلف شاشة القفل.
 * السيناريو: ورقةٌ مفتوحة فيها إدخال ← يخرج المستخدم ويعود بعد المهلة ← شاشة القفل والورقة مخفية ← يضغط رجوع الجوال
 * ← مستمع الورقة ما زال مسجَّلاً فيغلقها أو يضع حوار «إغلاق بلا حفظ» خفياً يظهر بعد الفتح، أو يرجع المسار تحت القفل.
 * الصحيح: مستمع رجوعٍ في LockGate يبتلع الضغطة ما دام مقفلاً، ومستمع الورقة لا يُسجَّل والتطبيق مقفل.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');

/** أجساد كل useEffect فيه BackHandler مع مصفوفة اعتمادها */
function backEffects(file: string): Array<{ body: string; deps: string }> {
  const src = read(...file.split('/'));
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Array<{ body: string; deps: string }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'useEffect' && n.arguments[0]
      && /BackHandler\.addEventListener/.test(n.arguments[0].getText(sf))) {
      out.push({ body: n.arguments[0].getText(sf), deps: n.arguments[1]?.getText(sf) ?? '' });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test('D-27 LockGate يبتلع رجوع الجوال ما دام مقفلاً', () => {
  const eff = backEffects('src/ui/LockGate.tsx');
  expect(eff).toHaveLength(1);
  expect(eff[0].body).toMatch(/if \(!locked\) return/);
  expect(eff[0].body).toMatch(/=> true/);
  expect(eff[0].deps).toMatch(/locked/);
});

test('D-27 مستمع رجوع الورقة لا يُسجَّل والتطبيق مقفل', () => {
  const eff = backEffects('src/ui/Sheet.tsx');
  expect(eff).toHaveLength(1);
  expect(eff[0].body).toMatch(/if \(!visible \|\| appLocked\) return/);
  expect(eff[0].deps).toMatch(/appLocked/);
});
