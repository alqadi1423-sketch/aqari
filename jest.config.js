/**
 * الاختبارات كلها على منطق العمل الخالص (src/domain, src/db) وتعمل على Node
 * عبر محوّل better-sqlite3 — لا حاجة لبيئة React Native.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx', types: ['jest', 'node'] } }],
  },
  testTimeout: 120000,
  // الملفات المؤقتة وذاكرة jest على D دائماً، وكل تشغيلٍ يمسح ما أنشأه (قرار المالك 2026-10-09 · tests/helpers/tmpRoot.js)
  ...(process.platform === 'win32' ? { cacheDirectory: 'D:/android-tools/tmp/jestcache' } : {}),
  globalSetup: '<rootDir>/tests/helpers/globalSetup.js',
  globalTeardown: '<rootDir>/tests/helpers/globalTeardown.js',
  setupFiles: ['<rootDir>/tests/helpers/setupTmp.js'],
};
