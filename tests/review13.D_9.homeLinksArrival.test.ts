/**
 * المراجعة الشاملة 2026-11-13 · D-9 · متوسط · app/(tabs)/collect.tsx و app/(tabs)/contracts.tsx (معاملات الوصول).
 *
 * السيناريو أ: الرئيسية ← «أكبر الأرصدة المستحقة» ← اسم مستأجر (?q=) ← رجوع ← «N دفعة متأخرة» (?filter=late)
 *   ← الأثر يعيّن الحالة ولا يمسح البحث ولا مدى التأخير ← متأخرات ذلك المستأجر وحده تحت رقمٍ يخص الجميع.
 * السيناريو ب: «المتأخرات» ← يغيّر الحالة في التحصيل ← رجوع ← «المتأخرات» ثانيةً ← المعامل لم يتغيّر فلا يجري الأثر ·
 *   وكذلك /contracts?detail= بعد إغلاق الورقة.
 * الصحيح: كل وصولٍ بمعاملات يبدأ بمسح المرشّحات ثم يطبّق ما جاء، ويُستهلك المعامل بعد تطبيقه.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { collectArrival, contractsArrival } from '@/ui/routeArrival';

const CLEAR = { filter: 'due', q: '', fProp: '', fLate: '', fAmt: '' };

test('D-9 وصول التحصيل يمسح المرشّحات كلها ثم يطبّق ما جاء', () => {
  expect(collectArrival({})).toBeNull();
  expect(collectArrival({ filter: undefined, bucket: undefined, q: undefined })).toBeNull();
  // ?filter=late بعد بحثٍ باسم مستأجر: البحث ومدى التأخير يُمسحان
  expect(collectArrival({ filter: 'late' })).toEqual({ ...CLEAR, filter: 'late' });
  expect(collectArrival({ filter: 'late', bucket: '2' })).toEqual({ ...CLEAR, filter: 'late', fLate: '31-60' });
  expect(collectArrival({ filter: 'late', bucket: '4' })).toEqual({ ...CLEAR, filter: 'late', fLate: '90+' });
  // اسم المستأجر وحده: على «غير مسدَّدة» لا على حالةٍ باقية من قبل
  expect(collectArrival({ q: 'مستأجر مصطنع' })).toEqual({ ...CLEAR, q: 'مستأجر مصطنع' });
  // المعامل قد يصل مصفوفة
  expect(collectArrival({ filter: ['month'] })).toEqual({ ...CLEAR, filter: 'month' });
});

test('D-9 وصول العقود بالحالة يمسح بقية المرشّحات · والتفصيل وحده لا يمسّها', () => {
  expect(contractsArrival({})).toBeNull();
  expect(contractsArrival({ status: 'ينتهي قريباً' })).toEqual({
    fStatus: 'ينتهي قريباً', fProp: '', fUnit: '', fPeriod: '', fCycle: '', q: '' });
  expect(contractsArrival({ detail: 'C-1' })).toBeNull();
});

/** جسد الأثر الذي يعتمد على معاملٍ بعينه */
function effectBody(file: string, dep: string): string {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'useEffect' && n.arguments.length === 2) {
      const deps = n.arguments[1];
      if (ts.isArrayLiteralExpression(deps) && deps.elements.some((e) => e.getText(sf) === dep)) found.push(n.arguments[0].getText(sf));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(found).toHaveLength(1);
  return found[0];
}

test('D-9 الشاشتان تطبّقان الوصول كاملاً ثم تستهلكان المعامل', () => {
  const collect = effectBody(path.resolve(__dirname, '..', 'app', '(tabs)', 'collect.tsx'), 'params.filter');
  expect(collect).toMatch(/collectArrival\(/);
  expect(collect).toMatch(/setParams\(\s*\{\s*filter:\s*undefined,\s*bucket:\s*undefined,\s*q:\s*undefined\s*\}/);
  const contracts = effectBody(path.resolve(__dirname, '..', 'app', '(tabs)', 'contracts.tsx'), 'params.detail');
  expect(contracts).toMatch(/contractsArrival\(/);
  expect(contracts).toMatch(/setParams\(\s*\{\s*detail:\s*undefined,\s*status:\s*undefined\s*\}/);
});
