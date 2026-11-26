/**
 * مدقق خارجي B · 1adf0a0 «جُرد ٩ مواضع يكبر فيها طول القائمة بالبيانات وأُصلحت كلها» · فاته موضعٌ عاشر في app/units.tsx:216-218:
 * مرشِّح «شاغرة/مؤجرة» يمرّر معرّف كل وحدةٍ بتلك الحالة متغيّراً في `u.id IN (?, …)` ثم COUNT وLIMIT/OFFSET (فلا يصلح له allIn) ·
 * والعبارة هنا منسوخة حرفاً من الشاشة (useMemo لا يُستدعى خارج React) · بيانات مصطنعة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit } from './helpers/fixtures';

test('الشاشة لا تبني القائمة متغيّراً لكل وحدة، بل قائمةً واحدة بـ json_each', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app/units.tsx'), 'utf8');
  expect(/u\.id IN \(\$\{ids\.map\(\(\) => '\?'\)\.join\(','\)\}\)/.test(src)).toBe(false);
  expect(src).toContain("where.push(`u.id IN (SELECT value FROM json_each(?))`); params.push(JSON.stringify(ids));");
});

test('مرشِّح «شاغرة» على ٣٣ ألف وحدة شاغرة: لا too many SQL variables', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار وحدات كثيرة مصطنع' });
  const u0 = addUnit(db, p, { unit_no: 'V0' });
  db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 33000)
          INSERT INTO units (id, property_id, unit_no, type, floor, rent_monthly_halalas, archived, created_at)
          SELECT 'V-' || i, property_id, 'V' || i, type, floor, rent_monthly_halalas, 0, created_at FROM units, n WHERE units.id = ?`, [u0]);
  const ids = db.all<{ id: string }>(`SELECT id FROM units WHERE deleted_at IS NULL`).map((r) => r.id);
  // app/units.tsx بالمرشِّح «شاغرة» وحده، كما صارت بعد الإصلاح
  const where: string[] = ['u.deleted_at IS NULL', 'u.archived = ?'];
  const params: (string | number)[] = [0];
  where.push(`u.id IN (SELECT value FROM json_each(?))`); params.push(JSON.stringify(ids));
  const src = `FROM units u LEFT JOIN properties p ON p.id = u.property_id WHERE ${where.join(' AND ')}`;
  expect(Number(db.get<{ c: number }>(`SELECT COUNT(*) c ${src}`, params)?.c)).toBe(ids.length);
});
