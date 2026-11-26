/**
 * المراجعة الشاملة 2026-11-13 · E-7: سجل العداد يتبع فاتورته · يُشتق من فواتير الشراء الحيّة (عدادها وقراءتها ومبلغها وتاريخها)، ومعه قراءات
 * محضر الاستلام وحدها من جدول القراءات · فالتعديل يغيّر السطر، والحذف يُخرجه، والاستعادة تعيده، و«القراءة السابقة» من الحيّ وحده.
 * بيانات مصطنعة، والمبالغ بالهللات.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit } from './helpers/fixtures';
import { replaceMeters, meterReadings, lastMeterReading } from '@/domain/meters';
import { savePurchase, deletePurchase, type PurchaseInput } from '@/domain/purchases';
import { restoreFromTrash } from '@/domain/trash';

function setup() {
  const db = memDb();
  const u = addUnit(db, addProperty(db));
  db.run(`INSERT INTO suppliers (id, name, utility_type, created_at) VALUES ('S-E7b', 'مزوّد كهرباء مصطنع', 'كهرباء', ?)`, [new Date().toISOString()]);
  replaceMeters(db, 'unit', u, [{ id: 'M-E7b', kind: 'كهرباء', number: '900002', supplierId: 'S-E7b' }]);
  const input: PurchaseInput = {
    supplier: 'مزوّد كهرباء مصطنع', date: '2026-05-01', due: '2026-05-31', category: 'كهرباء', incorpItem: '',
    amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false,
    subtotalHalalas: 50_000, taxHalalas: 0, totalHalalas: 50_000, meterId: 'M-E7b', meterReading: 1200, unitId: u,
  };
  return { db, input };
}
const total = (db: ReturnType<typeof memDb>) => meterReadings(db, 'M-E7b').reduce((s, r) => s + Number(r.amount_halalas), 0);

test('E-7 حذف الفاتورة ثم استعادتها: السطر يخرج من الإجمالي ثم يعود بـ50,000 هللة', () => {
  const { db, input } = setup();
  const id = savePurchase(db, input);
  expect(total(db)).toBe(50_000);
  deletePurchase(db, id);
  expect(total(db)).toBe(0);
  expect(lastMeterReading(db, 'M-E7b')).toBeNull();
  restoreFromTrash(db, 'purchases', id);
  expect(total(db)).toBe(50_000);
  expect(lastMeterReading(db, 'M-E7b')).toBe(1200);
  db.close();
});

test('E-7 قراءة محضر الاستلام تبقى في السجل بلا مبلغ، وقراءةٌ قديمة كُتبت لفاتورةٍ لا تتكرر', () => {
  const { db, input } = setup();
  const id = savePurchase(db, input);
  const no = db.get<{ no: string }>(`SELECT no FROM purchases WHERE id = ?`, [id])!.no;
  // سطرٌ كتبه إصدارٌ سابق لهذه الفاتورة نفسها، وقراءة محضر استلام
  db.run(`INSERT INTO meter_readings (id, meter_id, date, reading, amount_halalas, ref) VALUES ('MR-old', 'M-E7b', '2026-05-01', 1200, 50000, ?)`, [no]);
  db.run(`INSERT INTO meter_readings (id, meter_id, date, reading, amount_halalas, ref) VALUES ('MR-h', 'M-E7b', '2026-01-01', 900, 0, 'HND-1')`);
  expect(meterReadings(db, 'M-E7b').map((r) => [r.date, r.reading, Number(r.amount_halalas)])).toEqual([
    ['2026-05-01', 1200, 50_000], ['2026-01-01', 900, 0],
  ]);
  db.close();
});

test('E-7 نافذة تعديل الفاتورة تحمل عدادها وقراءتها فلا يُفكّ ربطه بالحفظ', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app/purchases.tsx'), 'utf8');
  const edit = src.slice(src.indexOf('const openEdit = useCallback'), src.indexOf('setFormOpen(true);', src.indexOf('const openEdit = useCallback')));
  expect(edit).toMatch(/setMeterId\(p\.meter_id \?\? ''\)/);
  expect(src).toMatch(/lastMeterReading\(db, meterId/);
});
