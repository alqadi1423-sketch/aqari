/**
 * المراجعة الشاملة 2026-11-13 · D-8 · متوسط · app/(tabs)/contracts.tsx («فتح النموذج» بعد إنشاء العقد) · بيانات مصطنعة كلها.
 *
 * السيناريو: مسودة عقدٍ للمستأجر «س» أُنشئت يوم ١ ← يوم ٢ وُثّق له عقدٌ آخر على وحدة ثانية ← يوم ٣ وُثّقت المسودة
 *   (التوثيق يُبقي created_at القديم) ← «فتح النموذج» يبحث باسم المستأجر الأحدث إنشاءً فيجد عقد اليوم ٢
 *   ← محضر الاستلام والقراءات على الوحدة الخطأ.
 * الصحيح: معرّف العقد العائد من confirmContract نفسه.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { saveDraft, confirmContract } from '@/domain/contracts/service';

test('D-8 البحث باسم المستأجر يجد عقداً آخر له · والمعرّف العائد هو العقد الموثَّق', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار مصطنع D8' });
  const u1 = addUnit(db, p, { unit_no: 'D8-1' });
  const u2 = addUnit(db, p, { unit_no: 'D8-2' });
  const tenant = 'مستأجر مصطنع D8';
  const draftId = saveDraft(db, contractInput(u1, { tenant, idNumber: '1000000981', start: '2026-12-01', end: '2027-11-30' }));
  db.run(`UPDATE contracts SET created_at = '2026-11-01T08:00:00.000Z' WHERE id = ?`, [draftId]);
  const other = confirmContract(db, contractInput(u2, { tenant, idNumber: '1000000981', start: '2026-12-01', end: '2027-11-30' }));
  db.run(`UPDATE contracts SET created_at = '2026-11-02T08:00:00.000Z' WHERE id = ?`, [other]);
  // توثيق المسودة يوم ٣ · المعرّف نفسه ويبقى تاريخ إنشائها
  const id = confirmContract(db, contractInput(u1, { tenant, idNumber: '1000000981', start: '2026-12-01', end: '2027-11-30' }), draftId);
  expect(id).toBe(draftId);
  const byName = db.get<{ id: string }>(
    `SELECT id FROM contracts WHERE TRIM(tenant_name)=TRIM(?) ORDER BY created_at DESC LIMIT 1`, [tenant])!.id;
  expect(byName).toBe(other);
  expect(byName).not.toBe(id);
  db.close();
});

test('D-8 «فتح النموذج» يفتح نموذج العقد بمعرّفه العائد لا باسم مستأجره', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', '(tabs)', 'contracts.tsx'), 'utf8');
  const at = src.indexOf("label: 'فتح النموذج'");
  expect(at).toBeGreaterThan(0);
  const press = src.slice(at, src.indexOf('}', src.indexOf('onPress', at)) + 1);
  expect(press).not.toMatch(/tenant_name/);
  expect(press).toMatch(/setHandoverFor\(\s*id\s*\)/);
});
