/**
 * قاعدة الحراسة: لا Text خام من react-native خارج مكوّنات الواجهة الأساسية،
 * فمكوّن T الموحد (بانكماش النص وقصّه الأنيق) هو الطريق الوحيد للنصوص.
 */
module.exports = {
  root: true,
  extends: ['expo'],
  overrides: [
    {
      files: ['app/**/*.tsx', 'src/**/*.tsx'],
      excludedFiles: [
        'src/ui/components.tsx',
        'src/ui/AppDialog.tsx',
        'src/ui/Sheet.tsx',
        'src/ui/FileViewer.tsx',
        'src/ui/Toast.tsx',
        'src/ui/Screen.tsx',
        'src/ui/ActionMenu.tsx',
        'src/ui/DateField.tsx',
      ],
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
  ],
};
