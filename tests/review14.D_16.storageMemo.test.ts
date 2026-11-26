/**
 * المراجعة الشاملة 2026-11-13 · D-16 · منخفض · app/settings.tsx · مسحٌ متزامن لمجلدات الجهاز مع كل رسمٍ للإعدادات.
 * السيناريو: «اكتب مسح للتأكيد» أو كلمة المرور في الإعدادات ← كل حرفٍ يعيد رسم الشاشة ← storageBreakdown يمشي مجلدي
 * المؤقتات والمصغّرات بنداءاتٍ متزامنة كل مرة فتبطؤ الكتابة.
 * الصحيح: الإحصاء محفوظٌ بذاكرة لا يُعاد إلا بتغيّر البيانات (version) · والتفريغ يستدعي bump فيتجدد.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

test('D-16 storageBreakdown داخل useMemo يتبع db وversion وحدهما', () => {
  const file = path.resolve(__dirname, '..', 'app', 'settings.tsx');
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls: Array<{ inMemo: boolean; deps: string }> = [];
  const visit = (n: ts.Node, memo: ts.CallExpression | null) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'storageBreakdown') {
      const deps = memo && memo.arguments[1] ? memo.arguments[1].getText(sf) : '';
      calls.push({ inMemo: !!memo, deps });
    }
    const next = ts.isCallExpression(n) && n.expression.getText(sf) === 'useMemo' ? n : memo;
    ts.forEachChild(n, (c) => visit(c, next));
  };
  visit(sf, null);
  expect(calls.length).toBe(1);
  expect(calls[0].inMemo).toBe(true);
  expect(calls[0].deps.replace(/\s/g, '')).toBe('[db,version]');
});
