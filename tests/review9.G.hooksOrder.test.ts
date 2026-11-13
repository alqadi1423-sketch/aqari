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

/** «<الملف>:<السطر> <المكوّن> <الخطاف>» لكل خطافٍ بعد عودةٍ مبكرة في مكوّنٍ أو خطافٍ مخصص */
export function hooksAfterEarlyReturn(src: string, file: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const check = (name: string, body: ts.Node | undefined) => {
    if (!body || !ts.isBlock(body) || !/^([A-Z]|use[A-Z])/.test(name)) return;
    let returned = false;
    for (const st of body.statements) {
      if (returned) {
        for (const c of hookCalls(st)) {
          out.push(`${file}:${sf.getLineAndCharacterOfPosition(c.getStart(sf)).line + 1} ${name} ${c.expression.getText(sf)}`);
        }
      }
      if (hasReturn(st)) returned = true;
    }
  };
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name) check(n.name.text, n.body);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) check(n.name.text, n.initializer.body);
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

test.failing('لا خطّاف بعد عودةٍ مبكرة في أي مكوّن (قاعدة الخطافات · بديل react-hooks/rules-of-hooks حتى يعمل ESLint)', () => {
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
