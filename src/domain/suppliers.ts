/**
 * حفظ المورد في موضعٍ واحد (دراسة القائم · قرار المالك 2026-10-09 أولاً ٨):
 *  - تعديل اسمه يتبعه في فواتير شرائه (تربطه المشتريات باسمه)، فلا يسقط تاريخه من تقريره وكشفه
 *  - مورد الغاز نوعاً للخدمة كالكهرباء والماء (قرار 2026-10-07: «عداد الغاز: يُضاف نوعاً للعدادات» · الهجرة ٤٠)
 */
import type { DB } from '../db/adapter';
import { uid } from './ids';
import { logAudit } from './audit';
import { t } from '../i18n';
import { isUtilityKind } from './meters';

export interface SupplierInput {
  name: string;
  vat: string;
  phone: string;
  category: string;
  amountHalalas: number | null;
  /** نوع الخدمة: فارغ للمورد العادي، أو أحد UTILITY_KINDS */
  utility: string;
}

/** إضافة مورد أو تعديله · يعيد معرّفه · الاسم والرقم الضريبي لا يتكرران */
export function saveSupplier(db: DB, id: string | null, f: SupplierInput): string {
  const name = f.name.trim();
  if (!name) throw new Error(t('suppliers.nameRequired'));
  if (f.utility && !isUtilityKind(f.utility)) throw new Error(t('suppliers.badUtility'));
  const vat = f.vat.trim();
  const dup = db.get(
    `SELECT id FROM suppliers WHERE deleted_at IS NULL AND id != ? AND (TRIM(name) = ? OR (? != '' AND TRIM(vat) = ?))`,
    [id ?? '', name, vat, vat]);
  if (dup) throw new Error(t('suppliers.duplicate'));
  return db.transaction(() => {
    const category = f.category.trim();
    const fields = [name, vat, f.phone.trim(), category, category, f.amountHalalas, f.utility];
    let sid = id;
    if (id) {
      const old = db.get<{ name: string }>(`SELECT name FROM suppliers WHERE id = ?`, [id]);
      db.run(
        `UPDATE suppliers SET name=?, vat=?, phone=?, category=?, default_category=?, default_amount_halalas=?, utility_type=? WHERE id=?`,
        [...fields, id]);
      // فواتير شرائه تتبع اسمه الجديد
      if (old && old.name.trim() !== name) {
        db.run(`UPDATE purchases SET supplier_name = ? WHERE TRIM(supplier_name) = TRIM(?)`, [name, old.name]);
      }
    } else {
      sid = uid();
      db.run(
        `INSERT INTO suppliers (id, name, vat, phone, category, default_category, default_amount_halalas, utility_type, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [sid, ...fields, new Date().toISOString()]);
    }
    logAudit(db, 'الموردون', id ? 'update' : 'create', 'مورد', name); // i18n-exempt: سجل العمليات بالعربية
    return sid!;
  });
}
