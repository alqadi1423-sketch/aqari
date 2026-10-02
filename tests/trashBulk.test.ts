/**
 * حالة مصطنعة: حذف ١٥٢٧ عنصراً من السلة واستعادتها · الزمن بالثواني،
 * بلا FOREIGN KEY constraint failed · ومعاملة واحدة لا معاملة لكل صف.
 */
import { memDb } from './helpers/testDb';
import { trashItems, deleteAllFromTrash, restoreAllFromTrash, purgeManyFromTrash } from '@/domain/trash';
import type { DB } from '@/db/adapter';

const NOW = "datetime('now')";

function seedTrashed(db: DB): number {
  let total = 0;
  db.transaction(() => {
    // عقار ووحدة حيّان يحملان المعالين
    db.run(`INSERT INTO properties (id, name, created_at) VALUES ('P', 'عقار', ${NOW})`);
    db.run(`INSERT INTO units (id, property_id, unit_no, created_at) VALUES ('U', 'P', '1', ${NOW})`);

    // ٤٠٠ عقد محذوف لكل منها دفعة (القاتل التاريخي: FK الدفعات يمنع حذف العقد)
    for (let k = 0; k < 400; k++) {
      db.run(
        `INSERT INTO contracts (id, contract_no, tenant_name, unit_id, start, end, value_halalas, cycle, status, created_at, deleted_at)
         VALUES ('C${k}', 'CN${k}', 'مستأجر${k}', 'U', '2026-01-01', '2026-12-31', 100000, 'شهرية', 'منتهٍ', ${NOW}, ${NOW})`);
      db.run(
        `INSERT INTO contract_payments (id, contract_id, date, gross_halalas, net_halalas, created_at)
         VALUES ('PAY${k}', 'C${k}', '2026-02-01', 1000, 1000, ${NOW})`);
      total += 1;
    }

    // ٤٠٠ قيد محذوف تشير إليه دفعات حية على عقد حي · مسودات: القيد المرحّل لا يدخل السلة منذ الهجرة ١٧
    db.run(
      `INSERT INTO contracts (id, contract_no, tenant_name, unit_id, start, end, value_halalas, cycle, status, created_at)
       VALUES ('CLIVE', 'CNL', 'حي', 'U', '2026-01-01', '2026-12-31', 100000, 'شهرية', 'سارٍ', ${NOW})`);
    for (let k = 0; k < 400; k++) {
      const id = 'JD' + k;
      db.run(`INSERT INTO journal_entries (id, no, date, memo, status, auto, created_at)
              VALUES (?, ?, '2026-03-01', ?, 'قيد الإنشاء', 1, ${NOW})`, [id, 'JE-D' + k, 'قيد ' + k]);
      db.run(`INSERT INTO journal_lines (id, entry_id, account_code, descr, debit_halalas, credit_halalas)
              VALUES (?, ?, '1100', '', 100, 0), (?, ?, '4200', '', 0, 100)`, [id + 'a', id, id + 'b', id]);
      db.run(`INSERT INTO contract_payments (id, contract_id, date, gross_halalas, net_halalas, journal_entry_id, created_at)
              VALUES ('LP${k}', 'CLIVE', '2026-03-01', 100, 100, ?, ${NOW})`, [id]);
      db.run(`UPDATE journal_entries SET deleted_at = ${NOW} WHERE id = ?`, [id]);
      total += 1;
    }

    // ٢٠٠ مورد محذوف لكل منها عداد حي
    for (let k = 0; k < 200; k++) {
      db.run(`INSERT INTO suppliers (id, name, created_at, deleted_at) VALUES ('S${k}', 'مورد${k}', ${NOW}, ${NOW})`);
      db.run(`INSERT INTO meters (id, owner_type, owner_id, kind, number, supplier_id) VALUES ('M${k}', 'unit', 'U', 'كهرباء', 'N${k}', 'S${k}')`);
      total += 1;
    }

    // ٥٢٧ مستأجراً محذوفاً يشير إليهم عقد حي
    for (let k = 0; k < 527; k++) {
      db.run(`INSERT INTO tenants (id, name, created_at, deleted_at) VALUES ('T${k}', 'شخص${k}', ${NOW}, ${NOW})`);
      total += 1;
    }
    db.run(`UPDATE contracts SET tenant_id = 'T0' WHERE id = 'CLIVE'`);
  });
  return total;
}

describe('السلة دفعة واحدة · ١٥٢٧ عنصراً', () => {
  test('الحذف النهائي: ثوانٍ لا دقائق · صفر FOREIGN KEY · والحي يبقى حياً', async () => {
    const db = memDb();
    const total = seedTrashed(db);
    expect(total).toBe(1527);
    expect(trashItems(db)).toHaveLength(1527);

    const t0 = Date.now();
    const purged = await deleteAllFromTrash(db);
    const seconds = (Date.now() - t0) / 1000;
    console.log(`حذف ${purged} عنصراً في ${seconds.toFixed(2)} ثانية`);

    expect(purged).toBe(1527);
    expect(seconds).toBeLessThan(5);
    expect(trashItems(db)).toHaveLength(0);
    // الحي سليم: العقد الحي باق ودفعاته فُكّت إشارتها للقيود المحذوفة
    expect(db.get(`SELECT id FROM contracts WHERE id = 'CLIVE'`)).toBeTruthy();
    expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE contract_id = 'CLIVE'`)!.n)).toBe(400);
    expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE journal_entry_id IS NOT NULL`)!.n)).toBe(0);
    // العدادات الحية فُكّ موردها المحذوف
    expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM meters WHERE supplier_id IS NOT NULL`)!.n)).toBe(0);
    const ic = db.get<Record<string, string>>(`PRAGMA integrity_check`)!;
    expect(String(Object.values(ic)[0])).toBe('ok');
    db.close();
  });

  test('الاستعادة الجماعية: ثوانٍ · وكل عنصر يرجع حياً', async () => {
    const db = memDb();
    seedTrashed(db);
    const t0 = Date.now();
    const restored = await restoreAllFromTrash(db);
    const seconds = (Date.now() - t0) / 1000;
    console.log(`استعادة ${restored} عنصراً في ${seconds.toFixed(2)} ثانية`);
    expect(restored).toBe(1527);
    expect(seconds).toBeLessThan(10);
    expect(trashItems(db)).toHaveLength(0);
    expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contracts WHERE deleted_at IS NULL`)!.n)).toBe(401);
    db.close();
  });

  test('حذف عنصر واحد يمر بالمسار الجماعي نفسه · عقد بدفعاته يُحذف بلا خطأ قيود', () => {
    const db = memDb();
    seedTrashed(db);
    purgeManyFromTrash(db, [{ table: 'contracts', id: 'C0' }]);
    expect(db.get(`SELECT id FROM contracts WHERE id = 'C0'`)).toBeFalsy();
    expect(db.get(`SELECT id FROM contract_payments WHERE contract_id = 'C0'`)).toBeFalsy();
    db.close();
  });

  /**
   * العطل المقيس على الجهاز: «حذف الكل نهائياً» يسقط بـ FOREIGN KEY constraint failed.
   * مصدره وحدةٌ في السلة ما زال يشير إليها عقدٌ حيّ (contracts.unit_id بلا تتالٍ)،
   * وعقارٌ في السلة له وحدة حيّة (units.property_id بلا تتالٍ).
   * القاعدة: ما عليه معالون أحياء يبقى في السلة، والباقي يُحذف، ولا خطأ.
   */
  test('وحدة في السلة يشير إليها عقد حي · وعقار في السلة له وحدة حية: لا سقوط والباقي يُحذف', async () => {
    const db = memDb();
    db.transaction(() => {
      db.run(`INSERT INTO properties (id, name, created_at, deleted_at) VALUES ('PT', 'عقار في السلة', ${NOW}, ${NOW})`);
      db.run(`INSERT INTO units (id, property_id, unit_no, created_at) VALUES ('ULIVE', 'PT', '1', ${NOW})`);
      db.run(`INSERT INTO units (id, property_id, unit_no, created_at, deleted_at) VALUES ('UT', 'PT', '2', ${NOW}, ${NOW})`);
      db.run(
        `INSERT INTO contracts (id, contract_no, tenant_name, unit_id, start, end, value_halalas, cycle, status, created_at)
         VALUES ('CL', 'CN1', 'حي', 'UT', '2026-01-01', '2026-12-31', 100000, 'شهرية', 'سارٍ', ${NOW})`);
      db.run(`INSERT INTO tenants (id, name, created_at, deleted_at) VALUES ('TT', 'شخص', ${NOW}, ${NOW})`);
    });
    expect(trashItems(db)).toHaveLength(3);
    await expect(deleteAllFromTrash(db)).resolves.toBeGreaterThan(0);
    // ما عليه معالون أحياء بقي في السلة · والذي لا معالين له ذهب
    expect(db.get(`SELECT id FROM units WHERE id = 'UT'`)).toBeTruthy();
    expect(db.get(`SELECT id FROM properties WHERE id = 'PT'`)).toBeTruthy();
    expect(db.get(`SELECT id FROM tenants WHERE id = 'TT'`)).toBeFalsy();
    expect(db.get(`SELECT id FROM contracts WHERE id = 'CL'`)).toBeTruthy();
    expect(db.all('PRAGMA foreign_key_check')).toHaveLength(0);
    db.close();
  });
});
