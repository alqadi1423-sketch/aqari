/**
 * فحص الكود العام (ESLint 9 بصيغة flat · المراجعة الشاملة 2026-11-13 · G-3): `npm run lint` محلياً وفي جيت هب مع كل دفعة (tests.yml ·
 * «فحص الكود») · يُسقطها خطأٌ واحد، والتحذيرات بسقفها اليوم (--max-warnings في package.json) فلا تزيد، وينزل السقف كلما نقصت.
 *  - إعداد إكسبو كما هو، و«قواعد الخطافات» خطأٌ (خطافٌ بعد عودةٍ مبكرة كـG-2 يُسقط التطبيق) و«اعتماديات الخطاف» تحذير · وقواعد مترجم
 *    React الجديدة في react-hooks 7 (refs وset-state-in-effect وأخواتها) تحذيرٌ لا خطأ: نصائح توافقٍ مع المترجم وهو غير مفعّل هنا، وفي
 *    الكود عشراتٌ منها تعديلها يمسّ سلوك الشاشات (القاعدة ٩٩) · والتحذيرات لها سقفٌ في جيت هب (--max-warnings) فلا تزيد.
 *  - src/vendor منقولٌ كما هو من مصدره (jsQR) فلا يُفحص.
 *  - قاعدة الحراسة: لا Text خام من react-native خارج مكوّنات الواجهة الأساسية، فمكوّن T الموحد (بانكماش النص وقصّه الأنيق) هو الطريق
 *    الوحيد للنصوص · وقائمة الاستثناء هي قائمة tests/noRawText.test.ts نفسها.
 */
const expoConfig = require('eslint-config-expo/flat');

/** قواعد react-hooks في إعداد إكسبو كلها تحذير، إلا قواعد الخطافات خطأ */
const hooksRules = Object.fromEntries(expoConfig.flatMap((c) => Object.keys(c.rules ?? {}))
  .filter((r) => r.startsWith('react-hooks/'))
  .map((r) => [r, r === 'react-hooks/rules-of-hooks' ? 'error' : 'warn']));

/** مكوّنات الواجهة الأساسية التي تستورد Text الخام (tests/noRawText.test.ts · ALLOWED) */
const RAW_TEXT_ALLOWED = [
  'src/ui/components.tsx',
  'src/ui/AppDialog.tsx',
  'src/ui/Sheet.tsx',
  'src/ui/FileViewer.tsx',
  'src/ui/Toast.tsx',
  'src/ui/Screen.tsx',
  'src/ui/ActionMenu.tsx',
  'src/ui/DateField.tsx',
  // تُرسم قبل مزوّد الحالة (نسخة ما قبل الترقية) · وT يقرأ مقياس الخط منه فلا يعمل هناك
  'src/ui/UpgradeGate.tsx',
];

module.exports = [
  {
    ignores: [
      'node_modules/**', 'android/**', 'ios/**', '.expo/**', 'dist/**', 'web-build/**', 'coverage/**', 'tmp/**',
      'docs/**', 'e2e/**', 'functions/**', 'scripts/**', 'tests/**', 'src/vendor/**', '*.config.js',
    ],
  },
  ...expoConfig,
  {
    rules: {
      ...hooksRules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['app/**/*.tsx', 'src/**/*.tsx'],
    ignores: RAW_TEXT_ALLOWED,
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'react-native',
          importNames: ['Text'],
          message: 'استعمل T أو Num من src/ui/components بدل Text الخام · فيض النصوص يحلّه المكوّن الموحد',
        }],
      }],
    },
  },
];
