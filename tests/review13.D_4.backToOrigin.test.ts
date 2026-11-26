/**
 * المراجعة الشاملة 2026-11-13 · D-4 · متوسط · app/(tabs)/_layout.tsx و app/(tabs)/contracts.tsx · قرار المالك س١٣ (قائم).
 *
 * السيناريو: «العقود» ← عقد ← «تحصيل» ← تسجيل الدفعة ← زر الرجوع في أندرويد ← «الرئيسية» لا العقد ·
 *   ومن شاشة الوحدات: «تحصيل» ثم رجوع يمرّ بـ«رئيسيةٍ» ثانية قبل أن يعود.
 * السبب: Tabs بلا backBehavior (الافتراضي firstRoute) · والشاشة تغلق ورقة العقد قبل الانتقال فلا تعود.
 * القرار: 2026-08-20 «والرجوع يعيدني من حيث أتيت · لا للشاشة الأولى» و2026-09-09 «الرجوع يغلق الطبقة العليا وحدها،
 *   ويعيد ما تحتها بحالته» · س١٣ في خطة المراجعة: الرجوع بين التبويبات يعيدك إلى التبويب الذي أتيت منه.
 * الصحيح: backBehavior="history"، والورقة التي أُغلقت للانتقال تُفتح ثانيةً حين يعود التركيز إلى شاشتها.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { ReturnLayer } from '@/ui/returnLayerStore';
import { TabRouter } from '../node_modules/expo-router/build/react-navigation/routers/TabRouter';

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');

test('D-4 الرجوع بين التبويبات بالتاريخ: من التحصيل إلى العقود لا إلى الرئيسية (موجّه التبويبات نفسه)', () => {
  const names = ['index', 'properties', 'contracts', 'collect', 'more'];
  const opts = { routeNames: names, routeParamList: {}, routeGetIdList: {} } as never;
  const back = (behavior: string) => {
    const r = TabRouter({ backBehavior: behavior } as never);
    let s = r.getInitialState(opts) as never;
    for (const to of ['contracts', 'collect']) s = r.getStateForAction(s, { type: 'NAVIGATE', payload: { name: to } } as never, opts) as never;
    const after = r.getStateForAction(s, { type: 'GO_BACK' } as never, opts) as { index: number; routes: Array<{ name: string }> };
    return after.routes[after.index].name;
  };
  // الافتراضي قبل الإصلاح يعيد إلى الرئيسية
  expect(back('firstRoute')).toBe('index');
  expect(back('history')).toBe('contracts');
});

test('D-4 التبويبات تُبنى بـ backBehavior="history"', () => {
  const file = path.resolve(__dirname, '..', 'app', '(tabs)', '_layout.tsx');
  const sf = ts.createSourceFile(file, read('app', '(tabs)', '_layout.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let value: string | null = null;
  const visit = (n: ts.Node) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === 'Tabs') {
      for (const a of n.attributes.properties) {
        if (ts.isJsxAttribute(a) && a.name.getText(sf) === 'backBehavior') value = a.initializer?.getText(sf) ?? null;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(value).toBe('"history"');
});

test('D-4 الطبقة التي أُغلقت للانتقال تعود مرةً واحدة عند العودة', () => {
  const l = new ReturnLayer<string>();
  expect(l.take()).toBeNull();
  l.leave('C-1');
  expect(l.take()).toBe('C-1');
  // لا تُفتح ثانيةً في كل تركيزٍ بعدها
  expect(l.take()).toBeNull();
  // المغادرة الأخيرة هي ما يعود
  l.leave('C-1'); l.leave('C-2');
  expect(l.take()).toBe('C-2');
});

test('D-4 ورقة العقد وورقة الوحدة تُذكَران قبل الانتقال وتعودان عند الرجوع', () => {
  const contracts = read('app', '(tabs)', 'contracts.tsx');
  // داخل ورقة العقد: كل انتقالٍ إلى شاشة أخرى يمرّ بـ onLeave لا بـ onClose
  expect(contracts).not.toMatch(/onClose\(\);\s*router\.push/);
  expect(contracts).toMatch(/onLeave\(\);\s*router\.push\(`\/collect\?pay=\$\{i\.id\}`\)/);
  expect(contracts).toMatch(/useReturnLayer</);
  const units = read('src', 'ui', 'unitSheets.tsx');
  const detail = units.slice(units.indexOf('export function UnitDetailSheet'));
  expect(detail).not.toMatch(/onClose\(\);\s*router\.push/);
  for (const owner of [['app', 'units.tsx'], ['app', '(tabs)', 'properties.tsx']]) {
    const src = read(...owner);
    const at = src.indexOf('<UnitDetailSheet');
    expect(src.slice(at, at + 600)).toMatch(/onLeave=\{/);
  }
});
