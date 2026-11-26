/**
 * حفظ المورد في موضعٍ واحد (دراسة القائم · قرار المالك 2026-10-09 أولاً ٨):
 *  - فواتير شرائه مربوطةٌ بمعرّفه (purchases.supplier_id · الهجرة ٦٦ · A2.17)، فتعديل اسمه لا يُسقط تاريخه من تقريره وكشفه ·
 *    والاسم في الفاتورة لقطةٌ تتبع الاسم الجديد، إلا المقفلة في إقرارٍ مقدَّم فتُبقي اسمه يوم تقديمه
 *  - مورد الغاز نوعاً للخدمة كالكهرباء والماء (قرار 2026-10-07: «عداد الغاز: يُضاف نوعاً للعدادات» · الهجرة ٤٠)
 */
import type { DB } from '../db/adapter';
import { uid } from './ids';
import { logAudit } from './audit';
import { t } from '../i18n';
import { isUtilityKind } from './meters';
import { isPurchaseFiled, isVatSettled } from './purchases';
import { isFiledDate } from './vatFilings';

/**
 * شرط فواتير المورد (الهجرة ٦٦ · A2.17): بمعرّفه، وما لا معرّف له (قبل الهجرة أو من إصدارٍ أقدم أو التبس اسمه) باسمه الحالي ·
 * يأخذ معرّف المورد مرتين: `[id, id]` · alias اسم جدول المشتريات في الاستعلام، والفارغ بلا تسمية
 */
export const supplierPurchasesSql = (alias = 'purchases'): string => {
  const c = alias ? alias + '.' : '';
  return `(${c}supplier_id = ? OR (${c}supplier_id IS NULL AND TRIM(${c}supplier_name) = (SELECT TRIM(s.name) FROM suppliers s WHERE s.id = ?)))`;
};

/** الشرط نفسه مربوطاً بصفّ موردٍ في الاستعلام نفسه (s) بلا معاملات */
export const supplierPurchasesJoin = (alias: string, supplier: string): string =>
  `(${alias}.supplier_id = ${supplier}.id OR (${alias}.supplier_id IS NULL AND TRIM(${alias}.supplier_name) = TRIM(${supplier}.name)))`;

/**
 * فاتورةٌ يبقى فيها اسم المورد كما كُتب (A2.17): ضريبتها مسترَدة أو مرفوضة، أو هي في إقرارٍ مقدَّم، أو سُدِّدت في ربعٍ قُدِّم إقراره
 * (جدول التحويلات في الإقرار بتاريخ السداد)
 */
function keepsSupplierName(db: DB, p: { id: string; s: string | null; paid: number; paid_date: string | null }): boolean {
  return isVatSettled(p.s) || isPurchaseFiled(db, p.id) || (!!Number(p.paid) && !!p.paid_date && isFiledDate(db, p.paid_date));
}

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
      // فواتير شرائه مربوطةٌ بمعرّفه (الهجرة ٦٦ · A2.17): تتبع اسمه الجديد، إلا المقفلة في إقرارٍ مقدَّم فتُبقي اسمه يومها فلا يتغيّر
      // كشفه المساند بعد تقديمه · وكلها تُكتب بمعرّفه، ومنها ما لا معرّف له بعد (يُربط باسمه القديم)، فيُرفع المعرّف لكل فواتيره ويعرفها
      // الجهاز الذي سحبها بلا معرّف (هجرة كل جهاز لا ترفعه) ولا يرثها من يُنشأ بالاسم القديم
      if (old && old.name.trim() !== name) {
        const rows = db.all<{ id: string; s: string | null; paid: number; paid_date: string | null }>(
          `SELECT id, refund_status AS s, paid, paid_date FROM purchases
           WHERE supplier_id = ? OR (supplier_id IS NULL AND TRIM(supplier_name) = TRIM(?))`, [id, old.name]);
        for (const p of rows) {
          if (keepsSupplierName(db, p)) db.run(`UPDATE purchases SET supplier_id = ? WHERE id = ?`, [id, p.id]);
          else db.run(`UPDATE purchases SET supplier_id = ?, supplier_name = ? WHERE id = ?`, [id, name, p.id]);
        }
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
