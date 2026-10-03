/**
 * مصفوفة الترقية: قاعدة اصطناعية ببيانات في كل إصدار من ١ إلى ٢٠ تُرقّى إلى الأحدث
 * ثم تُفحص بالفحص الدلالي الكامل وفحوص الدفتر · ولا يتغيّر فيها مبلغ ولا يضيع صف.
 * ومعها الإغلاق في منتصف الترقية: لقطة الملفات على القرص بعد كل هجرة داخل المعاملة
 * (كما لو قُتل التطبيق أو انقطعت الكهرباء في تلك اللحظة) تُفتح فتكون كما كانت قبل الترقية
 * بإصدارها وبنيتها وصفوفها، ثم تترقّى منها ترقيةً كاملة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openNodeDb } from '@/db/nodeAdapter';
import { SCHEMA_VERSION } from '@/db/schema';
import { migrate, currentSchemaVersion } from '@/db/migrations';
import { seed } from '@/db/seed';
import { semanticIssues } from '@/domain/backup/semantic';
import { integrityChecks } from '@/domain/accounting/integrity';
import type { DB } from '@/db/adapter';
import { tempDir, rmrf } from './helpers/testDb';
import { schemaAt, fill, snapshot } from './helpers/oldSchema';

/** البنية كاملة · جداول وأعمدة وفهارس ومحفّزات */
function structure(db: DB): string {
  return JSON.stringify(db.all(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`));
}

/** لقطة الملفات كما هي على القرص الآن · بلا ملف الذاكرة المشتركة فيُعاد بناؤه من السجل عند الفتح */
function crashCopy(src: string, dst: string): void {
  for (const suffix of ['', '-wal', '-journal']) {
    if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, dst + suffix);
  }
}

let dir: string;
beforeAll(() => { dir = tempDir('aqari-matrix-'); });
afterAll(() => rmrf(dir));

const VERSIONS = Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1);

test.each(VERSIONS)('قاعدة الإصدار %i ببياناتها تترقّى إلى الأحدث سليمةً', (v) => {
  const file = path.join(dir, `v${v}.db`);
  const db = schemaAt(file, v);
  fill(db);
  const before = snapshot(db);

  migrate(db);
  seed(db);

  expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(semanticIssues(db)).toEqual([]);
  expect(integrityChecks(db).filter((c) => !c.ok)).toEqual([]);
  expect(snapshot(db)).toEqual(before);
  const ic = db.get<Record<string, string>>(`PRAGMA integrity_check`)!;
  expect(Object.values(ic)[0]).toBe('ok');
  expect(db.all(`PRAGMA foreign_key_check`)).toEqual([]);
  // ما تُصلحه الهجرات في البيانات القديمة وقع فعلاً
  if (v < 7) expect(db.get<{ s: string }>(`SELECT tax_status AS s FROM purchases WHERE id = 'PU1'`)!.s).toBe('معفاة من الضريبة');
  if (v < 10) expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM occupants WHERE id = 'OC1'`)!.n).toBe(1);
  if (v < 11) expect(db.get<{ f: string }>(`SELECT furnished AS f FROM contracts WHERE id = 'C1'`)!.f).toBe('مؤثثة جزئياً');
  // والقاعدة المرقّاة تقبل الكتابة بقواعد الإصدار الأحدث: الخصم لا يتجاوز المتبقي
  expect(() => db.run(`UPDATE contract_installments SET paid_halalas = 300000 WHERE id = 'I2'`)).toThrow();
  db.close();
});

test.each(VERSIONS.filter((v) => v < SCHEMA_VERSION))('إغلاق التطبيق في منتصف الترقية من %i لا يترك حالة وسطى', (v) => {
  const file = path.join(dir, `crash-v${v}.db`);
  const db = schemaAt(file, v);
  fill(db);
  const before = snapshot(db);
  const shape = structure(db);
  db.close();

  // لقطة بعد كل هجرة داخل المعاملة · وهي ما يجده التطبيق لو أُغلق في تلك اللحظة
  const live = openNodeDb(file);
  const shots: string[] = [];
  migrate(live, (step) => {
    const shot = path.join(dir, `crash-v${v}-at${step}.db`);
    crashCopy(file, shot);
    shots.push(shot);
  });
  live.close();
  expect(shots.length).toBe(SCHEMA_VERSION - v);

  for (const shot of shots) {
    const reopened = openNodeDb(shot);
    expect(currentSchemaVersion(reopened)).toBe(v);
    expect(structure(reopened)).toBe(shape);
    expect(snapshot(reopened)).toEqual(before);
    // والفتح التالي يترقّى منها كاملاً · لا عمود مكرر ولا نصف هجرة
    migrate(reopened);
    expect(currentSchemaVersion(reopened)).toBe(SCHEMA_VERSION);
    expect(semanticIssues(reopened)).toEqual([]);
    expect(snapshot(reopened)).toEqual(before);
    reopened.close();
  }
});

test('فشل هجرة في منتصفها يعيد القاعدة كما كانت · ورقم الإصدار معها', () => {
  const file = path.join(dir, 'fail.db');
  const db = schemaAt(file, 16);
  fill(db);
  const before = snapshot(db);
  const shape = structure(db);
  expect(() => migrate(db, (step) => { if (step === 18) throw new Error('انقطاع مصطنع'); })).toThrow('انقطاع مصطنع');
  expect(currentSchemaVersion(db)).toBe(16);
  expect(structure(db)).toBe(shape);
  expect(snapshot(db)).toEqual(before);
  migrate(db);
  expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
  db.close();
});

test('الالتزام يحمل رقم الإصدار معه · لقطة بعد الترقية مباشرة بالإصدار الأحدث', () => {
  const file = path.join(dir, 'committed.db');
  const db = schemaAt(file, 19);
  fill(db);
  migrate(db);
  const shot = path.join(dir, 'committed-shot.db');
  crashCopy(file, shot);
  db.close();
  const reopened = openNodeDb(shot);
  expect(currentSchemaVersion(reopened)).toBe(SCHEMA_VERSION);
  expect(() => migrate(reopened)).not.toThrow();
  reopened.close();
});
