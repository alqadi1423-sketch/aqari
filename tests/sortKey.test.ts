/**
 * الترتيب الطبيعي · جداول المالك نصاً:
 * المفاتيح، القائمة المختلطة، وحدات ١..١٠٠ عبر SQL بالفهرس، والبيانات القديمة بعد الهجرة.
 */
import { memDb } from './helpers/testDb';
import { addProperty } from './helpers/fixtures';
import { naturalKey, naturalCompare } from '@/domain/sortKey';
import { saveUnit, bulkAddUnits } from '@/domain/propertiesService';

describe('مفتاح الترتيب الطبيعي', () => {
  test('جدول الأمثلة: كل مقطع رقمي يُحشى إلى عشر خانات', () => {
    expect(naturalKey('1')).toBe('#0000000001');
    expect(naturalKey('10')).toBe('#0000000010');
    expect(naturalKey('100')).toBe('#0000000100');
    expect(naturalKey('A-1')).toBe('A-#0000000001');
    expect(naturalKey('A-10')).toBe('A-#0000000010');
    expect(naturalKey('G-01')).toBe('G-#0000000001');
    expect(naturalKey('EJ-2026-001')).toBe('EJ-#0000002026-#0000000001');
  });

  test('القائمة المختلطة تُرتَّب كما حدَّد المالك', () => {
    const input = ['A-10', '100', 'B-12', '2أ', 'ب-11', '1', 'G-01', '101', 'A-2', '20', 'ب-3', '12', 'A-1', '2', '10'];
    const sorted = [...input].sort(naturalCompare);
    expect(sorted).toEqual(['1', '2', '2أ', '10', '12', '20', '100', '101', 'A-1', 'A-2', 'A-10', 'B-12', 'G-01', 'ب-3', 'ب-11']);
  });

  test('وحدات 1 إلى 100 تُعرض بترتيبها الصحيح من SQL بالفهرس', () => {
    const db = memDb();
    const pid = addProperty(db);
    // إدخال بترتيب عشوائي ثم القراءة مرتَّبة
    const nums = Array.from({ length: 100 }, (_, i) => String(i + 1)).sort(() => 0.5 - 0.5); // ثابت
    for (const n of nums.reverse()) {
      saveUnit(db, { propertyId: pid, unitNo: n, floor: '', type: 'سكني', subtype: '', rentMonthlyHalalas: 0, rooms: [], meters: [] });
    }
    const rows = db.all<{ unit_no: string }>(
      `SELECT unit_no FROM units WHERE property_id = ? AND deleted_at IS NULL
       ORDER BY COALESCE(unit_no_key, unit_no), unit_no`, [pid]
    );
    expect(rows.map((r) => r.unit_no)).toEqual(Array.from({ length: 100 }, (_, i) => String(i + 1)));
    db.close();
  });

  test('A-1 و A-2 و A-10 بهذا الترتيب · والدفعات المولَّدة كذلك', () => {
    const db = memDb();
    const pid = addProperty(db);
    for (const n of ['A-10', 'A-1', 'A-2']) {
      saveUnit(db, { propertyId: pid, unitNo: n, floor: '', type: 'سكني', subtype: '', rentMonthlyHalalas: 0, rooms: [], meters: [] });
    }
    bulkAddUnits(db, pid, 3, { prefix: 'B-', start: 8, floor: '', type: 'سكني', subtype: '', rentHalalas: 0 });
    const rows = db.all<{ unit_no: string }>(
      `SELECT unit_no FROM units WHERE property_id = ? AND deleted_at IS NULL
       ORDER BY COALESCE(unit_no_key, unit_no), unit_no`, [pid]
    );
    expect(rows.map((r) => r.unit_no)).toEqual(['A-1', 'A-2', 'A-10', 'B-8', 'B-9', 'B-10']);
    db.close();
  });

  test('بيانات قديمة بلا مفتاح تُرتَّب صحيحاً بعد هجرة الإقلاع', () => {
    const db = memDb();
    const pid = addProperty(db);
    // صفوف قديمة: بلا unit_no_key (كما قبل التعديل)
    for (const n of ['10', '2', '1']) {
      db.run(`INSERT INTO units (id, property_id, unit_no, created_at) VALUES (?,?,?,?)`,
        ['U_' + n, pid, n, new Date().toISOString()]);
    }
    // هجرة الإقلاع
    for (const r of db.all<{ id: string; unit_no: string }>(`SELECT id, unit_no FROM units WHERE unit_no_key IS NULL`)) {
      db.run(`UPDATE units SET unit_no_key = ? WHERE id = ?`, [naturalKey(r.unit_no), r.id]);
    }
    const rows = db.all<{ unit_no: string }>(
      `SELECT unit_no FROM units WHERE property_id = ? ORDER BY COALESCE(unit_no_key, unit_no), unit_no`, [pid]
    );
    expect(rows.map((r) => r.unit_no)).toEqual(['1', '2', '10']);
    db.close();
  });

  test('أرقام العقود EJ-2026-1 إلى EJ-2026-100 بالمقارن الطبيعي', () => {
    const nos = Array.from({ length: 100 }, (_, i) => `EJ-2026-${i + 1}`);
    const shuffled = [...nos].reverse();
    expect([...shuffled].sort(naturalCompare)).toEqual(nos);
  });
});
