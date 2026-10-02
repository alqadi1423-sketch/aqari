/**
 * «لا يُحذف شيء مرتبط بغيره»: قبل أي حذف تُعدّ المرتبطات من القاعدة نفسها،
 * فإن وُجدت رُفض الحذف بجملة تسمّي الأعداد («42 وحدة · 28 عقداً») وعُرض الأرشفة بدله.
 * الأرشفة إخفاء من القوائم فقط · الدفتر والتقارير لا يتغيّر فيهما رقم واحد.
 */
import type { DB } from '../db/adapter';

export type RefKind =
  | 'property' | 'unit' | 'contract' | 'tenant' | 'supplier'
  | 'bank' | 'account' | 'purchase' | 'invoice';

export interface LinkedRef {
  /** اسم النوع بصيغة تصلح بعد عدد: «وحدة · عقد · قيد» */
  label: string;
  count: number;
  /** وجهة «عرض المرتبطات» */
  route?: string;
}

const n = (db: DB, sql: string, params: unknown[] = []): number =>
  Number(db.get<{ c: number }>(sql, params as never)?.c ?? 0);

/** المرتبطات الحية بكيان بعينه · تُعاد الأنواع ذات العدد الموجب فقط */
export function linkedRefs(db: DB, kind: RefKind, id: string): LinkedRef[] {
  const out: LinkedRef[] = [];
  const add = (label: string, count: number, route?: string) => {
    if (count > 0) out.push({ label, count, route });
  };
  const att = (etype: string) =>
    n(db, `SELECT COUNT(*) c FROM attachments WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL`, [etype, id]);

  if (kind === 'property') {
    add('وحدة', n(db, `SELECT COUNT(*) c FROM units WHERE property_id = ? AND deleted_at IS NULL`, [id]), '/units');
    add('عقداً', n(db, `SELECT COUNT(*) c FROM contracts c JOIN units u ON u.id = c.unit_id
      WHERE u.property_id = ? AND c.deleted_at IS NULL`, [id]), '/contracts');
    add('فاتورة شراء', n(db, `SELECT COUNT(*) c FROM purchases WHERE property_id = ? AND deleted_at IS NULL`, [id]), '/purchases');
    add('فاتورة مبيعات', n(db, `SELECT COUNT(*) c FROM invoices WHERE property_id = ? AND deleted_at IS NULL`, [id]), '/invoices');
    add('عداداً', n(db, `SELECT COUNT(*) c FROM meters WHERE owner_type = 'property' AND owner_id = ? AND deleted_at IS NULL`, [id]));
    add('مرفقاً', att('property'), '/library');
  } else if (kind === 'unit') {
    add('عقداً', n(db, `SELECT COUNT(*) c FROM contracts WHERE unit_id = ? AND deleted_at IS NULL`, [id]), '/contracts');
    add('حجزاً', n(db, `SELECT COUNT(*) c FROM reservations WHERE unit_id = ? AND deleted_at IS NULL`, [id]));
    add('فاتورة شراء', n(db, `SELECT COUNT(*) c FROM purchases WHERE unit_id = ? AND deleted_at IS NULL`, [id]), '/purchases');
    add('ساكناً', n(db, `SELECT COUNT(*) c FROM occupants WHERE unit_id = ? AND deleted_at IS NULL`, [id]));
    add('عداداً', n(db, `SELECT COUNT(*) c FROM meters WHERE owner_type = 'unit' AND owner_id = ? AND deleted_at IS NULL`, [id]));
    add('مرفقاً', att('unit'), '/library');
  } else if (kind === 'contract') {
    add('قسطاً', n(db, `SELECT COUNT(*) c FROM contract_installments WHERE contract_id = ?`, [id]));
    add('دفعة محصَّلة', n(db, `SELECT COUNT(*) c FROM contract_payments WHERE contract_id = ?`, [id]));
    add('قيداً محاسبياً', n(db, `SELECT COUNT(*) c FROM journal_entries
      WHERE src_id = ? AND deleted_at IS NULL`, [id]), '/journal');
    add('مطالبة', n(db, `SELECT COUNT(*) c FROM claims WHERE contract_id = ? AND deleted_at IS NULL`, [id]), '/claims');
    add('ساكناً', n(db, `SELECT COUNT(*) c FROM occupants WHERE contract_id = ? AND deleted_at IS NULL`, [id]));
    add('مرفقاً', att('contract'), '/library');
  } else if (kind === 'tenant') {
    add('عقداً', n(db, `SELECT COUNT(*) c FROM contracts WHERE tenant_id = ? AND deleted_at IS NULL`, [id]), '/contracts');
    add('مرفقاً', att('tenant'), '/library');
  } else if (kind === 'supplier') {
    const name = db.get<{ name: string }>(`SELECT name FROM suppliers WHERE id = ?`, [id])?.name ?? '';
    add('فاتورة شراء', n(db, `SELECT COUNT(*) c FROM purchases WHERE supplier_name = ? AND deleted_at IS NULL`, [name]), '/purchases');
    add('عداداً مرتبطاً', n(db, `SELECT COUNT(*) c FROM meters WHERE supplier_id = ? AND deleted_at IS NULL`, [id]));
    add('مرفقاً', att('supplier'), '/library');
  } else if (kind === 'bank') {
    add('حركة بنكية', n(db, `SELECT COUNT(*) c FROM bank_tx WHERE bank_id = ? AND deleted_at IS NULL`, [id]), '/transactions');
    add('سطر دفع', n(db, `SELECT COUNT(*) c FROM payment_lines WHERE bank_id = ?`, [id]));
  } else if (kind === 'account') {
    add('سطر قيد', n(db, `SELECT COUNT(*) c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_code = ? AND e.deleted_at IS NULL`, [id]), '/journal');
  } else if (kind === 'purchase') {
    add('قيداً محاسبياً', n(db, `SELECT COUNT(*) c FROM journal_entries
      WHERE src_type IN ('purchase','purchase_pay','vat_refund') AND src_id = ? AND deleted_at IS NULL`, [id]), '/journal');
    add('مرفقاً', att('purchase'), '/library');
  } else if (kind === 'invoice') {
    add('قيداً محاسبياً', n(db, `SELECT COUNT(*) c FROM journal_entries
      WHERE src_type = 'invoice' AND src_id = ? AND deleted_at IS NULL`, [id]), '/journal');
    add('مرفقاً', att('invoice'), '/library');
  }
  return out;
}

/** «42 وحدة · 28 عقداً» */
export const refsSummary = (refs: LinkedRef[]): string =>
  refs.map((r) => `${r.count} ${r.label}`).join(' · ');

/** رفض حذفٍ لكيان مرتبط · يحمل المرتبطات كي تعرضها الواجهة قائمةً تُفتح */
export class LinkedRefsError extends Error {
  constructor(public refs: LinkedRef[], message: string) {
    super(message);
    this.name = 'LinkedRefsError';
  }
}

/** يرمي LinkedRefsError إن كان للكيان مرتبطات · وإلا يمرّ صامتاً */
export function assertNoRefs(db: DB, kind: RefKind, id: string, entityLabel: string, name: string): void {
  const refs = linkedRefs(db, kind, id);
  if (refs.length) throw new LinkedRefsError(refs, refuseDeleteMessage(entityLabel, name, refs));
}

/**
 * جملة الرفض الكاملة · تسمّي الكيان والسبب والأعداد.
 * تُعرض مع زرّي [أرشِفه بدل الحذف] و[عرض المرتبطات].
 */
export const refuseDeleteMessage = (entityLabel: string, name: string, refs: LinkedRef[]): string =>
  `لا يمكن حذف ${entityLabel} «${name}» لأن به ${refsSummary(refs)}. ` +
  `احذف المرتبطات أولاً أو أرشِفه فيختفي من القوائم وتبقى أرقامه في الدفتر والتقارير كما هي.`;
