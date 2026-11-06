/**
 * المراجعة الخارجية ٧ · النتيجة ٤٣: الهجرات تعطّل فحص المفاتيح الأجنبية فيُفحص ما بعدها ويُسجَّل عدده · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { schemaAt } from './helpers/oldSchema';
import { seed } from '@/db/seed';
import { migrate } from '@/db/migrations';
import { SCHEMA_VERSION } from '@/db/schema';

const fkMeta = (db: ReturnType<typeof memDb>) => db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'fk_violations_after_migrate'`)?.value;

// القاعدة ببنية الإصدار السابق لا بإرجاع رقم إصدار القاعدة الأحدث: الهجرة الأخيرة قد تضيف عموداً فلا تُعاد (الهجرة ٤٨)
const previous = () => { const db = schemaAt(':memory:', SCHEMA_VERSION - 1); seed(db); return db; };

test('بعد الهجرة يُسجَّل عدد مخالفات المفاتيح الأجنبية · صفرٌ لقاعدةٍ سليمة وعددها لقاعدةٍ فيها يتيم', () => {
  const db = previous();
  migrate(db);
  expect(fkMeta(db)).toBe('0');
  db.close();
  const bad = previous();
  bad.exec('PRAGMA foreign_keys = OFF');
  bad.run(`INSERT INTO units (id, property_id, unit_no, created_at) VALUES ('U-ORPHAN43', 'P-MISSING43', '1', '2026-10-15T00:00:00Z')`);
  bad.exec('PRAGMA foreign_keys = ON');
  migrate(bad);
  expect(Number(fkMeta(bad))).toBeGreaterThan(0);
  bad.close();
});
