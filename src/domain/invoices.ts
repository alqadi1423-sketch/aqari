/**
 * الفواتير · الإنشاء والتعديل وتغيير الحالة، بترحيل النموذج نفسه:
 * الإصدار يرحّل (1200 / 4100 + 2200)، والعودة لمسودة تعكس القيد.
 */
import type { DB } from '../db/adapter';
import { requireCash, reversalCashOut } from './cashGuard';
import { uid } from './ids';
import { ambientCostCenter } from './accounting/dimensions';
import { postInvoiceToLedger, reverseEntryBySource, reverseEntryById, voidEntryById, postInvoicePayment } from './accounting/post';
import { mulQty, pctOf } from './money';
import { logAudit } from './audit';
import { deviceLetter, ownNumbersSql, withLetter } from './numbering';
import { today } from './dates';

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

/**
 * الفاتورة الضريبية بلا فجوات (قرار المالك ٢٠٢٦-١٠-٠٥): المسودة برقم مؤقت لا يُطبع، ورقمها الحقيقي يُعطى
 * لحظة إصدارها · من عدّاد السحابة على جهازٍ يزامن (services/cloud.ts)، ومن تسلسل الجهاز على جهازٍ وحده.
 */
export const INVOICE_TEMP_PREFIX = 'TMP-';
export const isTempInvoiceNo = (no: string | null | undefined): boolean => !!no && no.startsWith(INVOICE_TEMP_PREFIX);
export const tempInvoiceNo = (): string => INVOICE_TEMP_PREFIX + uid().slice(-6).toUpperCase();
/** رقم الفاتورة من تسلسلها · السنة من تاريخ إصدارها */
export function invoiceNoFor(seq: number, issue?: string): string {
  const yr = /^\d{4}-/.test(issue ?? '') ? issue!.slice(0, 4) : today().slice(0, 4);
  return `INV-${yr}-` + String(seq).padStart(4, '0');
}
/** رقم الفاتورة كما يُعرض · المؤقت لا يُعرض رقماً */
export const invoiceNoLabel = (no: string): string => (isTempInvoiceNo(no) ? 'مسودة بلا رقم' : no);
/** الإصدار يحتاج رقماً: فاتورة جديدة تصدر، أو مسودةٌ برقم مؤقت تخرج من المسودة */
export function needsIssueNumber(db: DB, id: string | null | undefined, status: string): boolean {
  if (status === 'مسودة') return false;
  if (!id) return true;
  return isTempInvoiceNo(db.get<{ no: string }>(`SELECT no FROM invoices WHERE id = ?`, [id])?.no);
}

/** تسلسل الجهاز وحده · لجهازٍ لا يزامن */
export function nextInvoiceNo(db: DB, issue?: string): string {
  // السنة من تاريخ الإصدار لا من تاريخ الجهاز · ففاتورة ديسمبر المدخلة في يناير بسنتها (المراجعة ٤.١٧)
  const yr = /^\d{4}-/.test(issue ?? '') ? issue!.slice(0, 4) : today().slice(0, 4);
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
  existingId?: string,
  /** رقم الإصدار من عدّاد السحابة · وبدونه تسلسل الجهاز */
  issuedNo?: string,
): string {
  return db.transaction(() => {
    const { subtotal, tax, total } = invoiceTotals(input.lines);
    let beforeSnap: Record<string, unknown> | undefined;
    let id = existingId ?? uid();
    let no: string;
    if (existingId) {
      // المحصّلة لا تُعدَّل وتحصيلها قائم · وإلا بقي قيد تحصيلٍ لإجماليٍ تغيّر (المراجعة ٤.٢)
      if (db.get(`SELECT 1 FROM invoices WHERE id = ? AND payment_journal_entry_id IS NOT NULL`, [existingId]))
        throw new Error('الفاتورة محصّلة · أعدها «مستحقة» أولاً ليُعكس التحصيل، ثم عدّلها');
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
      // مسودةٌ برقم مؤقت تصدر الآن: رقمها الحقيقي لحظة إصدارها
      if (status !== 'مسودة' && isTempInvoiceNo(no)) {
        no = issuedNo ?? nextInvoiceNo(db, input.issue);
        db.run(`UPDATE invoices SET no = ? WHERE id = ?`, [no, existingId]);
      }
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
      no = status === 'مسودة' ? tempInvoiceNo() : (issuedNo ?? nextInvoiceNo(db, input.issue));
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
    // مركز التكلفة الذي اختارته شاشة الفاتورة يُحفظ معها · فترثه إن صدرت لاحقاً بلا شاشة (الهجرة ٣٠)
    const cc = ambientCostCenter();
    if (cc && db.all<{ name: string }>(`PRAGMA table_info(invoices)`).some((c) => c.name === 'cost_center_id')) {
      db.run(`UPDATE invoices SET cost_center_id = ? WHERE id = ?`, [cc, id]);
    }
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
export type InvoicePayMethod = 'bank' | 'cash' | 'cheque' | 'card';
export const INV_PAY_LABEL: Record<InvoicePayMethod, string> = { cash: 'نقداً', bank: 'تحويل بنكي', cheque: 'شيك', card: 'بطاقة' };

type PayRow = { no: string; customer_name: string; total_halalas: number };

/** يرحّل قيد التحصيل وحركة البنك ويعيد معرّف القيد · مشترك بين التحصيل والاسترجاع من السلة */
function postCollection(db: DB, id: string, v: PayRow, pay: { method: InvoicePayMethod; bankId: string | null; date: string }): string | null {
  const total = Number(v.total_halalas);
  const entry = postInvoicePayment(db, { id, no: v.no, customer: v.customer_name, total }, pay.date, pay.method === 'cash');
  if (pay.method !== 'cash' && pay.bankId) {
    db.run(
      `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
       VALUES (?,?,?,?,?,1,?,?,?)`,
      [uid(), pay.bankId, pay.date, 'تحصيل فاتورة ' + v.no + ' · ' + v.customer_name, total, entry ? entry.no : '',
       'تحصيل فاتورة · ' + INV_PAY_LABEL[pay.method], new Date().toISOString()]);
  }
  return entry ? entry.id : null;
}

/**
 * تحصيل فاتورة مبيعات (المراجعة ٤.٢) · قيد مدين النقد أو البنك / دائن الذمم بإجماليها، وحركة البنك إن لم يكن نقداً،
 * والفاتورة «مدفوعة» بتاريخ التحصيل وطريقته. فاتورةٌ مسودة لا تُحصَّل (لا ذمة لها بعد).
 */
export function payInvoice(db: DB, id: string, pay: { method: InvoicePayMethod; bankId: string | null; date: string }): void {
  db.transaction(() => {
    const v = db.get<PayRow & { status: string; journal_entry_id: string | null; payment_journal_entry_id: string | null }>(
      `SELECT no, customer_name, total_halalas, status, journal_entry_id, payment_journal_entry_id FROM invoices WHERE id = ? AND deleted_at IS NULL`, [id]);
    if (!v) throw new Error('تعذّر العثور على الفاتورة');
    if (v.status === 'مسودة' || !v.journal_entry_id) throw new Error('أصدر الفاتورة أولاً · المسودة لا تُحصَّل');
    if (pay.method !== 'cash' && !pay.bankId) throw new Error('اختر الحساب البنكي (' + INV_PAY_LABEL[pay.method] + ')، أو بدِّل الطريقة لنقداً');
    if (v.payment_journal_entry_id) reverseInvoicePayment(db, id);
    const entryId = postCollection(db, id, v, pay);
    db.run(`UPDATE invoices SET status = 'مدفوعة', paid_date = ?, payment_method = ?, payment_bank_id = ?, payment_journal_entry_id = ? WHERE id = ?`,
      [pay.date, pay.method, pay.method !== 'cash' ? pay.bankId : null, entryId, id]);
    logAudit(db, 'الفواتير', 'update', 'تحصيل فاتورة', v.no, { status: v.status }, { status: 'مدفوعة', date: pay.date, method: INV_PAY_LABEL[pay.method] });
  });
}

/**
 * عكس تحصيل فاتورة · القيد يُعكس وحركة البنك تقابلها حركة معاكسة مرتبطة بقيد العكس (كسداد المشتريات).
 * keepTerms: الحذف إلى السلة يُبقي تاريخ التحصيل وطريقته وبنكه ليعيدها الاسترجاع كما كانت.
 */
export function reverseInvoicePayment(db: DB, id: string, keepTerms = false): void {
  const v = db.get<{ no: string; payment_journal_entry_id: string | null }>(`SELECT no, payment_journal_entry_id FROM invoices WHERE id = ?`, [id]);
  if (!v || !v.payment_journal_entry_id) return;
  const je = db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ?`, [v.payment_journal_entry_id]);
  const rev = reverseEntryById(db, v.payment_journal_entry_id, 'عكس تحصيل الفاتورة ' + v.no + (je ? ' · القيد ' + je.no : ''));
  if (je && rev) {
    for (const t of db.all<{ bank_id: string; amount_halalas: number }>(
      `SELECT bank_id, amount_halalas FROM bank_tx WHERE journal_no = ? AND deleted_at IS NULL`, [je.no])) {
      db.run(
        `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
         VALUES (?,?,?,?,?,1,?,?,?)`,
        [uid(), t.bank_id, today(), 'عكس تحصيل الفاتورة ' + v.no, -Number(t.amount_halalas), rev.no, 'عكس تحصيل فاتورة', new Date().toISOString()]);
    }
  }
  db.run(keepTerms
    ? `UPDATE invoices SET payment_journal_entry_id = NULL WHERE id = ?`
    : `UPDATE invoices SET payment_journal_entry_id = NULL, paid_date = NULL, payment_method = NULL, payment_bank_id = NULL WHERE id = ?`, [id]);
}

export function setInvoiceStatus(db: DB, id: string, newStatus: 'مسودة' | 'مستحقة' | 'مدفوعة' | 'متأخرة', issuedNo?: string): void {
  // «مدفوعة» بتحصيلٍ له قيد وحده (payInvoice) · لا تُضبط حالةً مجردة فتبقى الذمة بلا سداد
  if (newStatus === 'مدفوعة') throw new Error('سجّل التحصيل بتاريخه وطريقته · «مدفوعة» لا تُختار حالةً وحدها');
  requireCash(db, collectionCashOut(db, id), 'عكس تحصيل الفاتورة');
  db.transaction(() => {
    const v = db.get<{
      no: string; customer_name: string; issue: string;
      subtotal_halalas: number; tax_halalas: number; total_halalas: number;
      journal_entry_id: string | null; status: string;
    }>(`SELECT no, customer_name, issue, subtotal_halalas, tax_halalas, total_halalas, journal_entry_id, status
        FROM invoices WHERE id = ?`, [id]);
    if (!v) return;
    // مسودةٌ برقم مؤقت تصدر الآن: رقمها الحقيقي لحظة إصدارها
    if (newStatus !== 'مسودة' && isTempInvoiceNo(v.no)) {
      v.no = issuedNo ?? nextInvoiceNo(db, v.issue);
      db.run(`UPDATE invoices SET no = ? WHERE id = ?`, [v.no, id]);
    }
    // الخروج من «مدفوعة» يعكس التحصيل أولاً
    reverseInvoicePayment(db, id);
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

/** ما يُخرجه عكس تحصيل الفاتورة من المحفظة · صفر إن حُصّلت بنكياً أو لم تُحصَّل */
export function collectionCashOut(db: DB, id: string): number {
  const pj = db.get<{ pj: string | null }>(`SELECT payment_journal_entry_id AS pj FROM invoices WHERE id = ?`, [id])?.pj;
  return pj ? reversalCashOut(db, pj) : 0;
}

/** حذف ناعم · القيد المرحّل يُعكَس بقيد مرآة ولا يُخفى فالتاريخ لا يُمحى */
export function deleteInvoice(db: DB, id: string): void {
  requireCash(db, collectionCashOut(db, id), 'عكس تحصيل الفاتورة');
  db.transaction(() => {
    const v = db.get<{ no: string; journal_entry_id: string | null }>(
      `SELECT no, journal_entry_id FROM invoices WHERE id = ?`, [id]
    );
    if (!v) return;
    // التحصيل يُعكس قبل الإصدار · بالترتيب كحذف فاتورة الشراء المسددة، وشروطه تبقى للاسترجاع
    reverseInvoicePayment(db, id, true);
    if (v.journal_entry_id) {
      if (!reverseEntryById(db, v.journal_entry_id)) voidEntryById(db, v.journal_entry_id);
    }
    db.run(`UPDATE invoices SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    logAudit(db, 'الفواتير', 'delete', 'فاتورة', v.no);
  });
}

/**
 * الاستعادة من السلة (المراجعة ٤.٦): تعاد وترحَّل من جديد إن لم تكن مسودة، والمحصّلة يُعاد تحصيلها بتاريخه
 * وطريقته وبنكه. فإن كان بنك التحصيل محذوفاً رُفضت الاستعادة بسببها ولم يتغير شيء.
 */
export function restoreInvoice(db: DB, id: string): void {
  db.transaction(() => {
    const v = db.get<PayRow & {
      issue: string; status: string; subtotal_halalas: number; tax_halalas: number;
      paid_date: string | null; payment_method: string | null; payment_bank_id: string | null;
    }>(`SELECT no, customer_name, issue, status, subtotal_halalas, tax_halalas, total_halalas, paid_date, payment_method, payment_bank_id
        FROM invoices WHERE id = ?`, [id]);
    if (!v) return;
    const paid = v.status === 'مدفوعة' && !!v.paid_date;
    const method = (v.payment_method && v.payment_method in INV_PAY_LABEL ? v.payment_method : 'cash') as InvoicePayMethod;
    if (paid && method !== 'cash') {
      const bank = db.get<{ name: string; deleted_at: string | null }>(`SELECT name, deleted_at FROM banks WHERE id = ?`, [v.payment_bank_id]);
      if (!bank || bank.deleted_at)
        throw new Error('لا تُسترجع الفاتورة ' + v.no + ': البنك الذي حُصّلت فيه' + (bank ? ' «' + bank.name + '»' : '') + ' محذوف · استرجع البنك أولاً');
    }
    db.run(`UPDATE invoices SET deleted_at = NULL WHERE id = ?`, [id]);
    if (v.status !== 'مسودة') {
      const entry = postInvoiceToLedger(db, {
        id, no: v.no, customer: v.customer_name, issue: v.issue,
        subtotal: Number(v.subtotal_halalas), tax: Number(v.tax_halalas), total: Number(v.total_halalas),
      });
      db.run(`UPDATE invoices SET journal_entry_id = ? WHERE id = ?`, [entry ? entry.id : null, id]);
    }
    if (paid) {
      const entryId = postCollection(db, id, v, { method, bankId: v.payment_bank_id, date: v.paid_date! });
      db.run(`UPDATE invoices SET payment_journal_entry_id = ? WHERE id = ?`, [entryId, id]);
    } else if (v.status === 'مدفوعة') {
      // «مدفوعة» من نسخة سابقة بلا تحصيل مسجّل: تعود مستحقة فلا تُخفى ذمتها
      db.run(`UPDATE invoices SET status = 'مستحقة' WHERE id = ?`, [id]);
    }
  });
}

export { reverseEntryBySource };
