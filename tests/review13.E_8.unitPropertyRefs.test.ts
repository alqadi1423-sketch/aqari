/**
 * المراجعة الشاملة 2026-11-13 · E-8: الوحدة والعقار اللذان تشير إليهما أصولٌ أو فواتير مبيعات أو نماذج استلام أو سطور قيود لا يُحذفان
 * (القاعدة الملزمة ١٢ · ٦ «لا حذف لمرتبط: أرشفة») · وما دخل السلة منهما قبل الإصلاح لا يكنسه الحذف النهائي ما دام يُشار إليه.
 * بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit } from './helpers/fixtures';
import { deleteProperty, deleteUnit } from '@/domain/propertiesService';
import { LinkedRefsError, linkedRefs } from '@/domain/refs';
import { purgeFromTrash } from '@/domain/trash';

const NOW = () => new Date().toISOString();
function asset(db: ReturnType<typeof memDb>, p: string | null, u: string | null) {
  db.run(`INSERT INTO assets (id, name, category, property_id, unit_id, life_months, cost_halalas, purchase_date, created_at)
          VALUES ('A-E8b', 'مكيف مصطنع', '1430', ?, ?, 60, 300000, '2026-01-01', ?)`, [p, u, NOW()]);
}
function entryWithLine(db: ReturnType<typeof memDb>, p: string | null, u: string | null) {
  db.run(`INSERT INTO journal_entries (id, no, date, memo, status, created_at) VALUES ('JE-E8', 'JE-E8-1', '2026-01-02', 'قيد مصطنع', 'قيد الإنشاء', ?)`, [NOW()]);
  db.run(`INSERT INTO journal_lines (id, entry_id, account_code, debit_halalas, credit_halalas, property_id, unit_id) VALUES ('JL-E8a', 'JE-E8', '5100', 50000, 0, ?, ?)`, [p, u]);
  db.run(`INSERT INTO journal_lines (id, entry_id, account_code, debit_halalas, credit_halalas) VALUES ('JL-E8b', 'JE-E8', '1100', 0, 50000)`);
}

test('E-8 عقارٌ فيه أصلٌ مباشرة (بلا وحدة): الحذف مرفوض ويسمّي الأصل', () => {
  const db = memDb();
  const p = addProperty(db);
  asset(db, p, null);
  expect(linkedRefs(db, 'property', p).map((r) => r.label)).toContain('أصلاً');
  expect(() => deleteProperty(db, p)).toThrow(LinkedRefsError);
  db.close();
});

test('E-8 وحدةٌ وعقارٌ عليهما سطر قيد بأبعاده: الحذف مرفوض', () => {
  const db = memDb();
  const p = addProperty(db);
  const u = addUnit(db, p);
  entryWithLine(db, p, u);
  expect(() => deleteUnit(db, u)).toThrow(LinkedRefsError);
  db.close();
});

test('E-8 وحدةٌ في السلة (من قبل الإصلاح) يشير إليها أصلٌ حيّ: الحذف النهائي يتركها', () => {
  const db = memDb();
  const p = addProperty(db);
  const u = addUnit(db, p);
  asset(db, p, u);
  db.run(`UPDATE units SET deleted_at = ? WHERE id = ?`, ['2025-01-01T00:00:00.000Z', u]);
  purgeFromTrash(db, 'units', u);
  expect(db.get(`SELECT id FROM units WHERE id = ?`, [u])).toBeTruthy();
  db.close();
});
