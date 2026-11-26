/**
 * المراجعة الشاملة 2026-11-13 · D-5 · متوسط · app/_layout.tsx (لا حاجز) و app/form-templates.tsx:43 · بيانات مصطنعة كلها.
 *
 * السيناريو: `form_templates.sections_json` يصل بالمزامنة نصاً غير صالح (جهاز عضو بإصدار سابق أو كتابة مزوّرة)
 *   ← `JSON.parse` يرمي داخل الرسم في «قوالب النماذج» أو في نموذج الاستلام ← لا حاجز حول الشاشات
 *   ← تُفكّ الشجرة كلها ومعها حوار الخطأ ← شاشة فارغة لا يُخرج منها إلا بإغلاق التطبيق.
 * الصحيح: كل شاشة محاطة بحاجز (expo-router: `unstable_settings.screenErrorBoundary` في التخطيط الجذري)
 *   يعرض بطاقة عربية بزرّي «أعد المحاولة» و«الرئيسية» والتطبيق حيّ حولها · و`sections_json` يُقرأ بلا رمي.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { memDb } from './helpers/testDb';
import { parseTemplateSections, parseHandoverSections, sectionsFromTemplate } from '@/domain/handover/build';

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');

test('D-5 أقسام القالب والنموذج تُقرأ بلا رمي من نصٍّ تالف', () => {
  expect(parseTemplateSections('{not json')).toEqual([]);
  expect(parseTemplateSections('null')).toEqual([]);
  expect(parseTemplateSections('{"section":"x"}')).toEqual([]);
  // عناصر ناقصة تُصحَّح ولا تُسقط ما سلم
  expect(parseTemplateSections('[{"section":"المطبخ","items":["موقد",3,null]},{"items":"x"},7]')).toEqual([
    { section: 'المطبخ', items: ['موقد'] },
    { section: '', items: [] },
  ]);
  expect(parseHandoverSections('[broken')).toEqual([]);
  expect(parseHandoverSections('[{"section":"الصالة","items":[{"name":"مكيف","count":"2"},"x"]}]')).toEqual([
    { section: 'الصالة', items: [{ name: 'مكيف', count: '2', receiveCondition: '', deliverCondition: '', notes: '' }] },
  ]);
});

test('D-5 قالبٌ تالف وصل بالمزامنة لا يُسقط بناء نموذج الاستلام', () => {
  const db = memDb();
  db.run(`INSERT INTO form_templates (id, name, sections_json, is_system, created_at)
          VALUES ('FT-BAD', 'قالب مصطنع تالف', '{oops', 0, '2026-11-01')`);
  expect(() => sectionsFromTemplate(db, 'FT-BAD')).not.toThrow();
  expect(sectionsFromTemplate(db, 'FT-BAD')).toEqual([]);
  db.close();
});

test('D-5 لا JSON.parse خامٌ لأعمدة sections_json في الشاشات', () => {
  for (const f of [['app', 'form-templates.tsx'], ['src', 'ui', 'HandoverSheet.tsx'], ['src', 'domain', 'handover', 'build.ts']]) {
    expect(read(...f)).not.toMatch(/JSON\.parse\([^)]*sections_json/);
  }
});

test('D-5 التخطيط الجذري يحيط كل شاشة بحاجز أخطاء عربي بزرّ «الرئيسية»', () => {
  const file = path.resolve(__dirname, '..', 'app', '_layout.tsx');
  const sf = ts.createSourceFile(file, read('app', '_layout.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let boundary: string | null = null;
  sf.forEachChild((n) => {
    if (ts.isVariableStatement(n) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of n.declarationList.declarations) {
        if (d.name.getText(sf) === 'unstable_settings' && d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
          for (const p of d.initializer.properties) {
            if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'screenErrorBoundary') boundary = p.initializer.getText(sf);
          }
        }
      }
    }
  });
  expect(boundary).toBe('ScreenErrorFallback');
  // expo-router نفسه يقرأ هذا الإعداد ويلفّ به كل شاشة (لا يُعتمد على اسمٍ لا يقرؤه)
  expect(read('node_modules', 'expo-router', 'build', 'useScreens.js')).toMatch(/unstable_settings\?\.screenErrorBoundary/);
  const fb = read('src', 'ui', 'ScreenErrorFallback.tsx');
  expect(fb).toMatch(/ErrorBoundaryProps/);
  expect(fb).toMatch(/retry/);
  // زر «الرئيسية» لا يُعرض في الرئيسية نفسها (زرٌّ لا يعمل لا يُعرض)
  expect(fb).toMatch(/crash\.home/);
  expect(fb).toMatch(/pathname\s*!==\s*'\/'/);
  const ar = JSON.parse(read('src', 'i18n', 'locales', 'ar.json'));
  const en = JSON.parse(read('src', 'i18n', 'locales', 'en.json'));
  expect(ar.crash.home).toBe('الرئيسية');
  expect(typeof en.crash.home).toBe('string');
  expect(typeof ar.crash.screen).toBe('string');
  expect(typeof en.crash.screen).toBe('string');
});
