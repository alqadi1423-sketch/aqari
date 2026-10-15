/**
 * المراجعة الخارجية ٧ · النتيجة ٤٣: الهجرات تعطّل فحص المفاتيح الأجنبية فيُفحص ما بعدها ويُسجَّل عدده · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { migrate } from '@/db/migrations';
import { SCHEMA_VERSION } from '@/db/schema';

const fkMeta = (db: ReturnType<typeof memDb>) => db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'fk_violations_after_migrate'`)?.value;

test('بعد الهجرة يُسجَّل عدد مخالفات المفاتيح الأجنبية · صفرٌ لقاعدةٍ سليمة وعددها لقاعدةٍ فيها يتيم', () => {
  const db = memDb();
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  migrate(db);
  expect(fkMeta(db)).toBe('0');
  db.exec('PRAGMA foreign_keys = OFF');
  db.run(`INSERT INTO units (id, property_id, unit_no, created_at) VALUES ('U-ORPHAN43', 'P-MISSING43', '1', '2026-10-15T00:00:00Z')`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  migrate(db);
  expect(Number(fkMeta(db))).toBeGreaterThan(0);
  db.close();
});
