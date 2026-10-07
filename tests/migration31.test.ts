/**
 * الهجرة ٣١ · عداد الغاز (قرار المالك ٢٠٢٦-١٠-٠٧): إعادة بناء جدول العدادات تُبقي صفوفه وقراءاتها كما هي،
 * وتقبل «غاز»، وتعيد فهارسه ومحفّزات مزامنته · بيانات مصطنعة.
 */
import { openNodeDb } from '@/db/nodeAdapter';
import { MIGRATIONS } from '@/db/schema';
import { migrate } from '@/db/migrations';

test('العدادات وقراءاتها تبقى بعد الهجرة ٣١ · و«غاز» مقبول · والمزامنة تلتقط العداد', () => {
  const db = openNodeDb(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  for (let v = 0; v < 30; v++) db.exec(MIGRATIONS[v]);
  db.exec('PRAGMA user_version = 30');
  db.exec('PRAGMA foreign_keys = ON');
  db.run(`INSERT INTO properties (id, name, created_at) VALUES ('P1', 'عقار مصطنع', '2026-01-01')`);
  db.run(`INSERT INTO units (id, property_id, unit_no, created_at) VALUES ('U1', 'P1', '1', '2026-01-01')`);
  db.run(`INSERT INTO meters (id, owner_type, owner_id, kind, number) VALUES ('M1', 'unit', 'U1', 'كهرباء', '11112222')`);
  db.run(`INSERT INTO meter_readings (id, meter_id, date, reading, amount_halalas, ref) VALUES ('R1', 'M1', '2026-02-01', 100, 5000, 'مصطنع')`);
  expect(() => db.run(`INSERT INTO meters (id, owner_type, owner_id, kind, number) VALUES ('MX', 'unit', 'U1', 'غاز', '1')`)).toThrow();

  migrate(db);
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM meters`)!.n).toBe(1);
  expect(db.get<{ r: number; a: number }>(`SELECT reading AS r, amount_halalas AS a FROM meter_readings WHERE id = 'R1'`)).toEqual({ r: 100, a: 5000 });
  db.run(`INSERT INTO meters (id, owner_type, owner_id, kind, number) VALUES ('M2', 'unit', 'U1', 'غاز', '33334444')`);
  expect(() => db.run(`INSERT INTO meters (id, owner_type, owner_id, kind, number) VALUES ('M3', 'unit', 'U1', 'بخار', '1')`)).toThrow();
  // الفهارس ومحفّزات المزامنة عادت
  const idx = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'meters'`).map((x) => x.name);
  expect(idx).toEqual(expect.arrayContaining(['ix_meters_owner', 'ix_meters_supplier']));
  const trg = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'meters'`).length;
  expect(trg).toBeGreaterThanOrEqual(3);
  // والمفتاح الأجنبي من القراءات ما زال يشير إلى الجدول
  expect(db.all(`PRAGMA foreign_key_check`)).toEqual([]);
});
