/**
 * المراجعة الشاملة 2026-11-13 · G-14 · منخفض · انجراف الوثائق عن الكود (الجزء الذي في الكود).
 * السيناريو: jest.config.js وsrc/db/adapter.ts يقولان إن الاختبارات «عبر محوّل better-sqlite3»، والمحوّل node:sqlite
 * (src/db/nodeAdapter.ts) · فالمطوّر الجديد يبحث عن حزمةٍ غير موجودة.
 * الصحيح: التعليقات تسمّي المحوّل الحقيقي · وانجراف docs/DESIGN.md (الإصدار وعدد الاختبارات وجدول الهجرات) يُصحَّح في الوثيقة نفسها.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');

test('G-14 لا ذكر لـbetter-sqlite3 في إعداد الاختبارات وطبقة القاعدة، والمحوّل node:sqlite', () => {
  for (const f of ['jest.config.js', 'src/db/adapter.ts']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    expect([f, /better-sqlite3/.test(src)]).toEqual([f, false]);
  }
  expect(fs.readFileSync(path.join(ROOT, 'src', 'db', 'nodeAdapter.ts'), 'utf8')).toMatch(/from 'node:sqlite'/);
  expect(fs.readFileSync(path.join(ROOT, 'jest.config.js'), 'utf8')).toMatch(/node:sqlite/);
});
