/**
 * مفردات موحّدة: كانت «مفروشة جزئياً» في الإنشاء و«مؤثثة جزئياً» في التجديد،
 * فالتجديد كان يغيّر القيمة المخزّنة خلسة · القائمة واحدة والهجرة توحّد القديم.
 */
import { memDb } from './helpers/testDb';
import { MIGRATION_11 } from '@/db/schema';
import { FURNISHED_OPTIONS, CYCLE_OPTIONS } from '@/domain/contracts/vocab';
import { CYCLE_MONTHS } from '@/domain/contracts/installments';

describe('مفردات العقد الموحّدة', () => {
  test('الهجرة ١١ توحّد «مفروشة جزئياً» المخزّنة قديماً إلى «مؤثثة جزئياً»', () => {
    const db = memDb();
    db.run(
      `INSERT INTO contracts (id, contract_no, tenant_name, unit_id, start, end, value_halalas, cycle, status, furnished, created_at)
       VALUES ('c1', 'C-1', 'مستأجر', NULL, '2026-01-01', '2026-12-31', 1200000, 'شهرية', 'سارٍ', 'مفروشة جزئياً', datetime('now'))`);
    db.exec(MIGRATION_11);
    expect(db.get<{ furnished: string }>(`SELECT furnished FROM contracts WHERE id = 'c1'`)!.furnished)
      .toBe('مؤثثة جزئياً');
    db.close();
  });

  test('الهجرة ١١ تطبّع مفردات الضريبة القديمة التي يتركها افتراضي العمود', () => {
    const db = memDb();
    db.run(
      `INSERT INTO purchases (id, no, supplier_name, date, subtotal_halalas, tax_halalas, total_halalas, created_at)
       VALUES ('p1', 'PB-1', 'مورد', '2026-01-10', 10000, 1500, 11500, datetime('now'))`);
    db.run(`UPDATE purchases SET tax_status = 'مستبعدة من الإقرار' WHERE id = 'p1'`);
    db.exec(MIGRATION_11);
    expect(db.get<{ tax_status: string }>(`SELECT tax_status FROM purchases WHERE id = 'p1'`)!.tax_status)
      .toBe('غير قابلة للخصم');
    db.close();
  });

  test('قائمة التأثيث الواحدة لا تحوي المفردة القديمة', () => {
    expect(FURNISHED_OPTIONS).toContain('مؤثثة جزئياً');
    expect(FURNISHED_OPTIONS as readonly string[]).not.toContain('مفروشة جزئياً');
  });

  test('دوريات الدفع من خريطة الأشهر نفسها · لا قائمة ثانية تفترق عنها', () => {
    expect(CYCLE_OPTIONS).toEqual(Object.keys(CYCLE_MONTHS));
    expect(CYCLE_OPTIONS.length).toBeGreaterThanOrEqual(4);
    for (const c of CYCLE_OPTIONS) expect(CYCLE_MONTHS[c]).toBeGreaterThan(0);
  });
});
