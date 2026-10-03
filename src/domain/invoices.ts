/**
 * الفواتير · الإنشاء والتعديل وتغيير الحالة، بترحيل النموذج نفسه:
 * الإصدار يرحّل (1200 / 4100 + 2200)، والعودة لمسودة تعكس القيد.
 */
import type { DB } from '../db/adapter';
import { uid } from './ids';
import { postInvoiceToLedger, reverseEntryBySource, reverseEntryById, voidEntryById } from './accounting/post';
import { mulQty, pctOf } from './money';
import { logAudit } from './audit';
import { deviceLetter, ownNumbersSql, withLetter } from './numbering';

export interface InvoiceLineInput {
  descr: string;
  qty: number;
  priceHalalas: number;
  taxPct: number;
}

export interface InvoiceInput {
  customer: string;
  customerVat: string;
  issue: string;
  due: string;
  notes: string;
  unitId?: string | null;
  propertyId?: string | null;
  lines: InvoiceLineInput[];
}

export function invoiceTotals(lines: InvoiceLineInput[]): { subtotal: number; tax: number; total: number } {
  let subtotal = 0, tax = 0;
  for (const l of lines) {
    const lineTotal = mulQty(l.qty, l.priceHalalas);
    subtotal += lineTotal;
    tax += pctOf(lineTotal, l.taxPct);
  }
  return { subtotal, tax, total: subtotal + tax };
}

export function nextInvoiceNo(db: DB): string {
  const yr = new Date().getFullYear();
  // تسلسل هذا الجهاز وحده (numbering.ts) · الرقم بعد السنة، وبحرف الجهاز بعده
  const letter = deviceLetter(db);
  const own = ownNumbersSql('no', 'INV-[0-9]*', letter);
  const row = db.get<{ mx: number }>(
    `SELECT COALESCE(MAX(CAST(substr(no, 10) AS INTEGER)),0) AS mx FROM invoices WHERE ${own.sql}`, own.params
  );
  return withLetter(`INV-${yr}-` + String((row ? Number(row.mx) : 0) + 1).padStart(4, '0'), letter);
}

/** حفظ فاتورة (مسودة أو إصدار). التعديل يعكس القيد القديم ويعيد الترحيل. */
export function saveInvoice(
  db: DB,
  input: InvoiceInput,
  status: 'مسودة' | 'مستحقة',
  existingId?: string
): string {
  return db.transaction(() => {
    const { subtotal, tax, total } = invoiceTotals(input.lines);
    let beforeSnap: Record<string, unknown> | undefined;
    let id = existingId ?? uid();
    let no: string;
    if (existingId) {
      // القيم قبل التعديل تُحفظ لسجل العمليات · «من أي قيمة إلى أي قيمة»
      const v = db.get<{
        no: string; journal_entry_id: string | null; customer_name: string;
        issue: string; due: string; subtotal_halalas: number; tax_halalas: number; total_halalas: number;
      }>(
        `SELECT no, journal_entry_id, customer_name, issue, due, subtotal_halalas, tax_halalas, total_halalas
         FROM invoices WHERE id = ?`, [existingId]
      );
      if (v) {
        beforeSnap = {
          العميل: v.customer_name, التاريخ: v.issue, الاستحقاق: v.due,
          'قبل الضريبة': Number(v.subtotal_halalas), الضريبة: Number(v.tax_halalas), الإجمالي: Number(v.total_halalas),
        };
      }
      if (!v) throw new Error('تعذّر العثور على الفاتورة');
      no = v.no;
      // القيد المرحّل لا يُخفى · يُعكس بقيد مرآة يبقى في الدفتر ثم يُرحَّل قيد القيم الجديدة
      if (v.journal_entry_id) {
        if (!reverseEntryById(db, v.journal_entry_id, 'عكس قيد فاتورة ' + no + ' · تعديل الفاتورة'))
          voidEntryById(db, v.journal_entry_id);
      }
      db.run(
        `UPDATE invoices SET customer_name=?, customer_vat=?, issue=?, due=?, status=?,
          subtotal_halalas=?, tax_halalas=?, total_halalas=?, notes=?, unit_id=?, property_id=?, journal_entry_id=NULL
         WHERE id = ?`,
        [input.customer, input.customerVat, input.issue, input.due, status,
         subtotal, tax, total, input.notes, input.unitId ?? null, input.propertyId ?? null, existingId]
      );
      db.run(`DELETE FROM invoice_lines WHERE invoice_id = ?`, [existingId]);
    } else {
      no = nextInvoiceNo(db);
      db.run(
        `INSERT INTO invoices (id, no, customer_name, customer_vat, issue, due, status,
          subtotal_halalas, tax_halalas, total_halalas, notes, unit_id, property_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, no, input.customer, input.customerVat, input.issue, input.due, status,
         subtotal, tax, total, input.notes, input.unitId ?? null, input.propertyId ?? null,
         new Date().toISOString()]
      );
    }
    input.lines.forEach((l, i) => {
      db.run(
        `INSERT INTO invoice_lines (id, invoice_id, descr, qty, price_halalas, tax_pct, sort)
         VALUES (?,?,?,?,?,?,?)`,
        [uid(), id, l.descr, l.qty, l.priceHalalas, l.taxPct, i]
      );
    });
    if (status !== 'مسودة') {
      const entry = postInvoiceToLedger(db, { id, no, customer: input.customer, issue: input.issue, subtotal, tax, total });
      if (entry) db.run(`UPDATE invoices SET journal_entry_id = ? WHERE id = ?`, [entry.id, id]);
    }
    logAudit(db, 'الفواتير', existingId ? 'update' : 'create', 'فاتورة', no, beforeSnap,
      existingId ? {
        العميل: input.customer, التاريخ: input.issue, الاستحقاق: input.due,
        'قبل الضريبة': subtotal, الضريبة: tax, الإجمالي: total,
      } : undefined);
    return id;
  });
}

/** تغيير حالة الفاتورة · العودة لمسودة تلغي القيد، والخروج منها يرحّل */
export function setInvoiceStatus(db: DB, id: string, newStatus: 'مسودة' | 'مستحقة' | 'مدفوعة' | 'متأخرة'): void {
  db.transaction(() => {
    const v = db.get<{
      no: string; customer_name: string; issue: string;
      subtotal_halalas: number; tax_halalas: number; total_halalas: number;
      journal_entry_id: string | null; status: string;
    }>(`SELECT no, customer_name, issue, subtotal_halalas, tax_halalas, total_halalas, journal_entry_id, status
        FROM invoices WHERE id = ?`, [id]);
    if (!v) return;
    if (newStatus === 'مسودة' && v.journal_entry_id) {
      // العودة لمسودة تُلغي أثر القيد بعكسه لا بإخفائه · فيبقى الحدثان في الدفتر
      if (!reverseEntryById(db, v.journal_entry_id, 'عكس قيد فاتورة ' + v.no + ' · إعادتها مسودة'))
        voidEntryById(db, v.journal_entry_id);
      db.run(`UPDATE invoices SET status = ?, journal_entry_id = NULL WHERE id = ?`, [newStatus, id]);
    } else if (newStatus !== 'مسودة' && !v.journal_entry_id) {
      const entry = postInvoiceToLedger(db, {
        id, no: v.no, customer: v.customer_name, issue: v.issue,
        subtotal: Number(v.subtotal_halalas), tax: Number(v.tax_halalas), total: Number(v.total_halalas),
      });
      db.run(`UPDATE invoices SET status = ?, journal_entry_id = ? WHERE id = ?`, [newStatus, entry ? entry.id : null, id]);
    } else {
      db.run(`UPDATE invoices SET status = ? WHERE id = ?`, [newStatus, id]);
    }
    logAudit(db, 'الفواتير', 'update', 'فاتورة', v.no, { status: v.status }, { status: newStatus });
  });
}

/** حذف ناعم · القيد المرحّل يُعكَس بقيد مرآة ولا يُخفى فالتاريخ لا يُمحى */
export function deleteInvoice(db: DB, id: string): void {
  db.transaction(() => {
    const v = db.get<{ no: string; journal_entry_id: string | null }>(
      `SELECT no, journal_entry_id FROM invoices WHERE id = ?`, [id]
    );
    if (!v) return;
    if (v.journal_entry_id) {
      if (!reverseEntryById(db, v.journal_entry_id)) voidEntryById(db, v.journal_entry_id);
    }
    db.run(`UPDATE invoices SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    logAudit(db, 'الفواتير', 'delete', 'فاتورة', v.no);
  });
}

/** الاستعادة من السلة: تعاد وترحَّل من جديد إن لم تكن مسودة */
export function restoreInvoice(db: DB, id: string): void {
  db.transaction(() => {
    const v = db.get<{
      no: string; customer_name: string; issue: string; status: string;
      subtotal_halalas: number; tax_halalas: number; total_halalas: number;
    }>(`SELECT no, customer_name, issue, status, subtotal_halalas, tax_halalas, total_halalas
        FROM invoices WHERE id = ?`, [id]);
    if (!v) return;
    db.run(`UPDATE invoices SET deleted_at = NULL WHERE id = ?`, [id]);
    if (v.status !== 'مسودة') {
      const entry = postInvoiceToLedger(db, {
        id, no: v.no, customer: v.customer_name, issue: v.issue,
        subtotal: Number(v.subtotal_halalas), tax: Number(v.tax_halalas), total: Number(v.total_halalas),
      });
      db.run(`UPDATE invoices SET journal_entry_id = ? WHERE id = ?`, [entry ? entry.id : null, id]);
    }
  });
}

export { reverseEntryBySource };
