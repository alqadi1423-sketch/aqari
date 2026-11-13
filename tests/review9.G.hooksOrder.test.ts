/**
 * G-2 · عالٍ · src/ui/DecisionSheet.tsx:21 و:30
 *
 * السيناريو: جهاز عضوٍ أُزيلت عضويته وفي طابوره تغييرات (أو مُسحت بيانات المنشأة من جهازٍ آخر) فتظهر ورقة «ما ينتظر قرارك»
 * فوق التطبيق (AuthGate:163). يضغط المستخدم «لاحقاً» أو يغلق الورقة بزر الرجوع ← setLater(true) ← يُعاد تصيير المكوّن فيعود
 * عند السطر 21 (`if (later) return null`) قبل `useAccess()` في السطر 30، و`useAccess` يحمل `useMemo` (src/ui/access.tsx:18).
 * فيُصيَّر المكوّن بخطّافين بعد أن صُيِّر بثلاثة، فيرمي React «Rendered fewer hooks than expected» (الخطأ #300، في بناء الإصدار
 * أيضاً)، ولا حاجز أخطاء فوق AuthGate (لا ErrorBoundary في app/_layout.tsx) فينهار عرض التطبيق كله.
 * والحال يُعاد بعد كل فتح (cloud.ts:276 و:294) فلا يبقى للعضو إلا «فرّغ هذا الجهاز».
 *
 * لماذا يهم: «لاحقاً» هو الخيار الوحيد غير الماسح للعضو، وقاعدة المالك 2026-10-05 «لا يُمسح شيء من الجهاز إلا بأمره»
 * (رأس DecisionSheet.tsx) تقوم عليه · والخطأ لم يكشفه شيء لأن ESLint (وفيه react-hooks/rules-of-hooks) لا يعمل في المستودع.
 *
 * السلوك الصحيح: لا خطّاف بعد عودةٍ مبكرة في أي مكوّن (قاعدة الخطافات) · هنا: `const owner = useAccess().owner` قبل
 * `if (later) return null`. والحارس أدناه يقوم مقام القاعدة حتى يعمل ESLint.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** هل في العقدة return خارج دالةٍ متداخلة */
function hasReturn(node: ts.Node): boolean {
  let found = false;
  const v = (n: ts.Node) => {
    if (found) return;
    if (n !== node && ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) { found = true; return; }
    ts.forEachChild(n, v);
  };
  v(node);
  return found;
}

/** نداءات use*() في العقدة خارج الدوال المتداخلة (فهي نداءات تصيير) */
function hookCalls(node: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const v = (n: ts.Node) => {
    if (n !== node && ts.isFunctionLike(n)) return;
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
      if (/^use[A-Z]/.test(name)) out.push(n);
    }
    ts.forEachChild(n, v);
  };
  v(node);
  return out;
}

/** نداءات الخطافات المشروطة في العقدة (داخل if أو ?: أو && || ?? أو حلقة أو switch)، خارج الدوال المتداخلة (مدقق المرحلة ٠ · P0-12) */
function conditionalHookCalls(node: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const v = (n: ts.Node, cond: boolean) => {
    if (n !== node && ts.isFunctionLike(n)) return;
    if (cond && ts.isCallExpression(n)) {
      const e = n.expression;
      const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
      if (/^use[A-Z]/.test(name)) out.push(n);
    }
    if (ts.isIfStatement(n)) { v(n.expression, cond); v(n.thenStatement, true); if (n.elseStatement) v(n.elseStatement, true); return; }
    if (ts.isConditionalExpression(n)) { v(n.condition, cond); v(n.whenTrue, true); v(n.whenFalse, true); return; }
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) { v(n.left, cond); v(n.right, true); return; }
    if (ts.isIterationStatement(n, false) || ts.isSwitchStatement(n) || ts.isCatchClause(n)) { ts.forEachChild(n, (c) => v(c, true)); return; }
    ts.forEachChild(n, (c) => v(c, cond));
  };
  v(node, false);
  return out;
}

const WRAPPERS = /^(?:memo|forwardRef)$/;

/** «<الملف>:<السطر> <المكوّن> <الخطاف>» لكل خطافٍ بعد عودةٍ مبكرة أو داخل شرط، في مكوّنٍ أو خطافٍ مخصص (ومنه الملفوف بـmemo/forwardRef) */
export function hooksAfterEarlyReturn(src: string, file: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const at = (name: string, c: ts.CallExpression, tag = '') =>
    `${file}:${sf.getLineAndCharacterOfPosition(c.getStart(sf)).line + 1} ${name} ${c.expression.getText(sf)}${tag}`;
  const check = (name: string, body: ts.Node | undefined) => {
    if (!body || !ts.isBlock(body) || !/^([A-Z]|use[A-Z])/.test(name)) return;
    let returned = false;
    const seen = new Set<ts.Node>();
    for (const st of body.statements) {
      if (returned) {
        for (const c of hookCalls(st)) { seen.add(c); out.push(at(name, c)); }
      }
      if (hasReturn(st)) returned = true;
    }
    for (const c of conditionalHookCalls(body)) if (!seen.has(c)) out.push(at(name, c, ' (شرطي)'));
  };
  /** الدالة الملفوفة: React.memo(() => …) · forwardRef(function X() …) · memo(forwardRef(…)) */
  const unwrap = (e: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | null => {
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
    if (ts.isCallExpression(e) && e.arguments.length) {
      const c = e.expression;
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : '';
      if (WRAPPERS.test(name)) return unwrap(e.arguments[0]);
    }
    return null;
  };
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name) check(n.name.text, n.body);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const f = unwrap(n.initializer);
      if (f) check(n.name.text, f.body);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test('الحارس نفسه: يمسك الخطاف بعد العودة المبكرة ويترك ما قبلها وما في الدوال المتداخلة', () => {
  const src = [
    'function Good({ x }) { const a = useA(); if (!x) return null; const f = () => useB(); return a; }',
    'function Bad({ x }) { const a = useA(); if (!x) return null; const b = useB(); return a + b; }',
    'const AlsoBad = () => { if (z) { return null; } return useC(); };',
  ].join('\n');
  expect(hooksAfterEarlyReturn(src, 'x.tsx')).toEqual(['x.tsx:2 Bad useB', 'x.tsx:3 AlsoBad useC']);
});

test('لا خطّاف بعد عودةٍ مبكرة في أي مكوّن (قاعدة الخطافات · بديل react-hooks/rules-of-hooks حتى يعمل ESLint)', () => {
  const offenders: string[] = [];
  for (const base of ['app', 'src']) {
    for (const f of walk(base)) {
      const rel = f.split(path.sep).join('/');
      offenders.push(...hooksAfterEarlyReturn(fs.readFileSync(path.join(ROOT, f), 'utf8'), rel));
    }
  }
  // الواقع اليوم: ['src/ui/DecisionSheet.tsx:30 DecisionSheet useAccess'] · فضغط «لاحقاً» يُسقط عرض التطبيق
  expect(offenders).toEqual([]);
});

// مدقق المرحلة ٠ · P0-12: الحارس يرى المكوّن الملفوف والخطّاف المشروط
test('مكوّنٌ ملفوف بـReact.memo أو forwardRef فيه خطّاف بعد عودةٍ مبكرة يُمسك', () => {
  const src = [
    'const Memo = React.memo(({ x }) => { if (!x) return null; const v = useB(); return v; });',
    'const Fwd = forwardRef(function Fwd(p, r) { if (!p.x) return null; const v = useC(); return v; });',
  ].join('\n');
  expect(hooksAfterEarlyReturn(src, 'x.tsx')).toEqual(['x.tsx:1 Memo useB', 'x.tsx:2 Fwd useC']);
});

test('خطّافٌ داخل شرطٍ بلا عودة (if، ?:، &&، حلقة) يُمسك، وخارجه لا', () => {
  expect(hooksAfterEarlyReturn('function Cond({ a }) { if (a) { useB(); } return null; }', 'x.tsx')).toEqual(['x.tsx:1 Cond useB (شرطي)']);
  expect(hooksAfterEarlyReturn('function T({ a }) { const v = a ? useB() : 0; return v; }', 'x.tsx')).toEqual(['x.tsx:1 T useB (شرطي)']);
  expect(hooksAfterEarlyReturn('function A({ a }) { const v = a && useB(); return v; }', 'x.tsx')).toEqual(['x.tsx:1 A useB (شرطي)']);
  expect(hooksAfterEarlyReturn('function L({ xs }) { for (const x of xs) useB(x); return null; }', 'x.tsx')).toEqual(['x.tsx:1 L useB (شرطي)']);
  expect(hooksAfterEarlyReturn('function Ok({ a }) { const v = useB(a ? 1 : 2); const f = () => (a ? useC() : 0); return v; }', 'x.tsx')).toEqual([]);
});
