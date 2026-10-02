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
};
