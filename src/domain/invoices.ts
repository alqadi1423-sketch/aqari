/**
 * الفواتير · الإنشاء والتعديل وتغيير الحالة، بترحيل النموذج نفسه:
 * الإصدار يرحّل (1200 / 4100 + 2200)، والعودة لمسودة تعكس القيد.
 */
import type { DB } from '../db/adapter';
import { requireCash, reversalCashOut } from './cashGuard';
import { uid } from './ids';
import { ambientCostCenter } from './accounting/dimensions';
import { postInvoiceToLedger, reverseEntryBySource, reverseEntryById, voidEntryById, postInvoicePayment, postCreditNoteToLedger } from './accounting/post';
import { t } from '../i18n';
import { lineTaxCode, type TaxCode } from './taxCode';
import { lastReversedOf, repostDate } from './accounting/repost';
import { isFiledDate } from './vatFilings';
import { mulQty, pctOf } from './money';
import { logAudit } from './audit';
import { deviceLetter, ownNumbersSql, withLetter } from './numbering';
import { today } from './dates';

export interface InvoiceLineInput {
  descr: string;
  qty: number;
  priceHalalas: number;
  taxPct: number;
  /** رمز الضريبة (الهجرة ٣٩): خاضع S، صفري Z، معفى E · وبدونه يُشتق من النسبة */
  taxCode?: TaxCode;
}
export type { TaxCode } from './taxCode';

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
  // لا فاتورة تصدر بتاريخٍ في فترةٍ قُدِّم إقرارها: التصحيح في فترة مفتوحة (دراسة القائم · بروح قرار المالك 2026-10-09)
  if (status !== 'مسودة' && isFiledDate(db, input.issue)) throw new Error(t('invoice.filedPeriod')); // i18n-exempt: حالة مخزّنة
  return db.transaction(() => {
    const { subtotal, tax, total } = invoiceTotals(input.lines);
    let beforeSnap: Record<string, unknown> | undefined;
    let id = existingId ?? uid();
    let no: string;
    if (existingId) {
      // الصادرة لا تُعدَّل: تصحيحها بإشعار دائن مرتبط بها (قرار المالك على #30) · والمسودة تُعدَّل وتصدر
      if (db.get(`SELECT 1 FROM invoices WHERE id = ? AND status != 'مسودة'`, [existingId])) throw new Error(t('invoice.locked')); // i18n-exempt: حالة مخزّنة
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
        `INSERT INTO invoice_lines (id, invoice_id, descr, qty, price_halalas, tax_pct, sort, tax_code)
         VALUES (?,?,?,?,?,?,?,?)`,
        [uid(), id, l.descr, l.qty, l.priceHalalas, l.taxPct, i, lineTaxCode(l.taxCode, l.taxPct)]
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

/** تاريخ القيد · لحركة البنك التي تقابله */
const entryDateOf = (db: DB, id: string): string =>
  db.get<{ date: string }>(`SELECT date FROM journal_entries WHERE id = ?`, [id])?.date ?? today();

/** العملية في رسالة كفاية النقد لكل عكسٍ لتحصيل الفاتورة */
const REVERSE_COLLECTION = 'عكس تحصيل الفاتورة';

/** تغيير حالة الفاتورة · العودة لمسودة تلغي القيد، والخروج منها يرحّل */
export type InvoicePayMethod = 'bank' | 'cash' | 'cheque' | 'card';
export const INV_PAY_LABEL: Record<InvoicePayMethod, string> = { cash: 'نقداً', bank: 'تحويل بنكي', cheque: 'شيك', card: 'بطاقة' };

type PayRow = { no: string; customer_name: string; total_halalas: number };

/** يرحّل قيد التحصيل وحركة البنك ويعيد معرّف القيد · مشترك بين التحصيل والاسترجاع من السلة */
function postCollection(db: DB, id: string, v: PayRow, pay: { method: InvoicePayMethod; bankId: string | null; date: string }): string | null {
  // ما بقي على العميل بعد إشعاراتها الدائنة (#30)
  const total = invoiceRemaining(db, id, Number(v.total_halalas));
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
    if (isCreditNote(db, id)) throw new Error(t('invoice.creditNotCollectable'));
    if (invoiceRemaining(db, id, Number(v.total_halalas)) <= 0) throw new Error(t('invoice.nothingDue'));
    if (pay.method !== 'cash' && !pay.bankId) throw new Error('اختر الحساب البنكي (' + INV_PAY_LABEL[pay.method] + ')، أو بدِّل الطريقة لنقداً');
    // تحصيلٌ قائم يُعكس أولاً فيخرج نقده · بكفاية النقد (التحقق المستقل · قرار المالك 2026-10-05)
    if (v.payment_journal_entry_id) {
      requireCash(db, collectionCashOut(db, id), REVERSE_COLLECTION);
      reverseInvoicePayment(db, id);
    }
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
        [uid(), t.bank_id, entryDateOf(db, rev.id), 'عكس تحصيل الفاتورة ' + v.no, -Number(t.amount_halalas), rev.no, 'عكس تحصيل فاتورة', new Date().toISOString()]);
    }
  }
  db.run(keepTerms
    ? `UPDATE invoices SET payment_journal_entry_id = NULL WHERE id = ?`
    : `UPDATE invoices SET payment_journal_entry_id = NULL, paid_date = NULL, payment_method = NULL, payment_bank_id = NULL WHERE id = ?`, [id]);
}

export function setInvoiceStatus(db: DB, id: string, newStatus: 'مسودة' | 'مستحقة' | 'مدفوعة' | 'متأخرة', issuedNo?: string): void {
  // «مدفوعة» بتحصيلٍ له قيد وحده (payInvoice) · لا تُضبط حالةً مجردة فتبقى الذمة بلا سداد
  if (newStatus === 'مدفوعة') throw new Error('سجّل التحصيل بتاريخه وطريقته · «مدفوعة» لا تُختار حالةً وحدها');
  // الصادرة لا تعود مسودة (قرار المالك على #30): تصحيحها بإشعار دائن
  if (newStatus === 'مسودة' && db.get(`SELECT 1 FROM invoices WHERE id = ? AND status != 'مسودة'`, [id])) throw new Error(t('invoice.locked')); // i18n-exempt: حالة مخزّنة
  requireCash(db, collectionCashOut(db, id), REVERSE_COLLECTION);
  db.transaction(() => {
    const v = db.get<{
      no: string; customer_name: string; issue: string;
      subtotal_halalas: number; tax_halalas: number; total_halalas: number;
      journal_entry_id: string | null; status: string;
    }>(`SELECT no, customer_name, issue, subtotal_halalas, tax_halalas, total_halalas, journal_entry_id, status
        FROM invoices WHERE id = ?`, [id]);
    if (!v) return;
    if (newStatus !== 'مسودة' && v.status === 'مسودة' && isFiledDate(db, v.issue)) throw new Error(t('invoice.filedPeriod')); // i18n-exempt: حالة مخزّنة
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
  // الصادرة والإشعار الدائن لا يُحذفان (قرار المالك على #30) · المسودة وحدها
  if (db.get(`SELECT 1 FROM invoices WHERE id = ? AND status != 'مسودة'`, [id])) throw new Error(t('invoice.locked')); // i18n-exempt: حالة مخزّنة
  requireCash(db, collectionCashOut(db, id), REVERSE_COLLECTION);
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
    // القيدان الجديدان بتاريخ عكس قيدَي الحذف (التحقق المستقل على #29): لا تتضاعف فترة وتنقص أخرى
    const revIssue = lastReversedOf(db, 'invoice', id);
    const revPay = lastReversedOf(db, 'invoice_pay', id);
    db.run(`UPDATE invoices SET deleted_at = NULL WHERE id = ?`, [id]);
    if (v.status !== 'مسودة') {
      const entry = postInvoiceToLedger(db, {
        id, no: v.no, customer: v.customer_name, issue: revIssue ? repostDate(db, revIssue) : v.issue,
        subtotal: Number(v.subtotal_halalas), tax: Number(v.tax_halalas), total: Number(v.total_halalas),
      });
      db.run(`UPDATE invoices SET journal_entry_id = ? WHERE id = ?`, [entry ? entry.id : null, id]);
    }
    if (paid) {
      const entryId = postCollection(db, id, v, { method, bankId: v.payment_bank_id, date: revPay ? repostDate(db, revPay) : v.paid_date! });
      db.run(`UPDATE invoices SET payment_journal_entry_id = ? WHERE id = ?`, [entryId, id]);
    } else if (v.status === 'مدفوعة') {
      // «مدفوعة» من نسخة سابقة بلا تحصيل مسجّل: تعود مستحقة فلا تُخفى ذمتها
      db.run(`UPDATE invoices SET status = 'مستحقة' WHERE id = ?`, [id]);
    }
  });
}

export { reverseEntryBySource };

/* ═══════════ الإشعار الدائن (قرار المالك 2026-10-07 على #30) ═══════════ */

export const KIND_INVOICE = 'invoice';
export const KIND_CREDIT = 'credit_note';

const hasKind = (db: DB): boolean => db.all<{ name: string }>(`PRAGMA table_info(invoices)`).some((c) => c.name === 'kind');

/** هل الصفّ إشعارٌ دائن */
export function isCreditNote(db: DB, id: string): boolean {
  return hasKind(db) && !!db.get(`SELECT 1 FROM invoices WHERE id = ? AND kind = ?`, [id, KIND_CREDIT]);
}

/** ما بقي على العميل من الفاتورة بعد إشعاراتها الدائنة (مبالغ الإشعار سالبة) */
export function invoiceRemaining(db: DB, id: string, total?: number): number {
  const tot = total ?? Number(db.get<{ t: number }>(`SELECT total_halalas AS t FROM invoices WHERE id = ?`, [id])?.t ?? 0);
  if (!hasKind(db)) return tot;
  const credits = Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(total_halalas), 0) AS s FROM invoices WHERE ref_invoice_id = ? AND kind = ? AND deleted_at IS NULL`,
    [id, KIND_CREDIT])?.s ?? 0);
  return tot + credits;
}

export interface CreditNoteInput {
  date: string;
  reason: string;
  /** المبلغ قبل الضريبة · وضريبته بنسبة ضريبة الفاتورة */
  subtotalHalalas: number;
}

/** ما بقي من صافي الفاتورة وضريبتها بعد إشعاراتها الدائنة */
export function creditLeft(db: DB, id: string, subtotal: number, tax: number): { sub: number; tax: number } {
  const c = db.get<{ s: number; t: number }>(
    `SELECT COALESCE(SUM(subtotal_halalas), 0) AS s, COALESCE(SUM(tax_halalas), 0) AS t FROM invoices
     WHERE ref_invoice_id = ? AND kind = ? AND deleted_at IS NULL`, [id, KIND_CREDIT]);
  return { sub: subtotal + Number(c?.s ?? 0), tax: tax + Number(c?.t ?? 0) };
}

/** ضريبة مبلغٍ بنسبة ضريبة الفاتورة نفسها (صافيها إلى ضريبتها) */
export function creditTaxFor(inv: { subtotal: number; tax: number }, subtotal: number): number {
  return inv.subtotal ? Math.round((subtotal * inv.tax) / inv.subtotal) : 0;
}

/**
 * إشعار دائن على فاتورة صادرة غير محصّلة (قرار المالك على #30): صفٌّ في الفواتير بنوعه ومرجعه وسببه ورقمه من
 * تسلسل الفواتير نفسه، ومبالغه سالبة فتنقص بها المجاميع والإقرار في فترة تاريخه، وقيده يعكس ما يقابله.
 * المحصّلة يُعكس تحصيلها أولاً، ولا يزيد الإشعار على ما بقي منها.
 */
export function saveCreditNote(db: DB, invoiceId: string, input: CreditNoteInput, issuedNo?: string): string {
  return db.transaction(() => {
    const v = db.get<{
      id: string; no: string; status: string; kind: string; customer_name: string; customer_vat: string; issue: string;
      subtotal_halalas: number; tax_halalas: number; total_halalas: number; payment_journal_entry_id: string | null;
      unit_id: string | null; property_id: string | null; deleted_at: string | null;
    }>(`SELECT * FROM invoices WHERE id = ?`, [invoiceId]);
    if (!v || v.deleted_at) throw new Error(t('invoice.notFound'));
    if (v.kind === KIND_CREDIT || v.status === 'مسودة') throw new Error(t('invoice.creditOnIssued')); // i18n-exempt: حالة مخزّنة
    if (v.payment_journal_entry_id) throw new Error(t('invoice.creditPaid'));
    const reason = input.reason.trim();
    if (!reason) throw new Error(t('invoice.creditReason'));
    // لا قبل تاريخ فاتورته، ولا في فترةٍ قُدِّم إقرارها فيتغيّر المجمَّد (التحقق المستقل)
    if (input.date < v.issue) throw new Error(t('invoice.creditBeforeInvoice'));
    if (isFiledDate(db, input.date)) throw new Error(t('invoice.creditFiledPeriod'));
    const sub = Math.round(input.subtotalHalalas);
    if (sub <= 0) throw new Error(t('invoice.creditAmount'));
    // ما بقي من صافيها وضريبتها بعد إشعاراتها: الصافي لا يتجاوز الباقي منه، وإشعار الباقي كله يأخذ ما بقي من الضريبة
    const left = creditLeft(db, invoiceId, Number(v.subtotal_halalas), Number(v.tax_halalas));
    if (sub > left.sub) throw new Error(t('invoice.creditOver'));
    const tax = sub === left.sub ? left.tax
      : Math.min(left.tax, creditTaxFor({ subtotal: Number(v.subtotal_halalas), tax: Number(v.tax_halalas) }, sub));
    const total = sub + tax;
    if (total > invoiceRemaining(db, invoiceId, Number(v.total_halalas))) throw new Error(t('invoice.creditOver'));
    const id = uid();
    const no = issuedNo ?? nextInvoiceNo(db, input.date);
    db.run(
      `INSERT INTO invoices (id, no, customer_name, customer_vat, issue, due, status, subtotal_halalas, tax_halalas, total_halalas,
        notes, unit_id, property_id, created_at, kind, ref_invoice_id, credit_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,'',?,?,?,?,?,?)`,
      [id, no, v.customer_name, v.customer_vat, input.date, input.date,
       'مستحقة', // i18n-exempt: حالة مخزّنة · الإشعار لا يُحصَّل ولا يتأخر، وذمته تتبع فاتورته
       -sub, -tax, -total, v.unit_id, v.property_id, new Date().toISOString(), KIND_CREDIT, invoiceId, reason]);
    const pct = Number(v.subtotal_halalas) ? Math.round((Number(v.tax_halalas) * 100) / Number(v.subtotal_halalas)) : 0;
    // رمز الإشعار رمز فاتورته (التحقق المستقل: كان من مبلغ ضريبته، فالصفري يُرمَّز معفى، والخاضع الصغير معفى) ·
    // والفاتورة المختلطة بالضريبة كما كانت حتى قرار المالك
    const codes = new Set(db.all<{ c: string; p: number }>(
      `SELECT tax_code AS c, tax_pct AS p FROM invoice_lines WHERE invoice_id = ?`, [invoiceId]).map((l) => lineTaxCode(l.c, Number(l.p))));
    const code = codes.size === 1 ? [...codes][0] : tax > 0 ? 'S' : 'E';
    db.run(`INSERT INTO invoice_lines (id, invoice_id, descr, qty, price_halalas, tax_pct, sort, tax_code) VALUES (?,?,?,?,?,?,0,?)`,
      [uid(), id, reason, 1, -sub, pct, code]);
    const entry = postCreditNoteToLedger(db, { id, no, refNo: v.no, customer: v.customer_name, date: input.date, subtotal: sub, tax, total });
    if (entry) db.run(`UPDATE invoices SET journal_entry_id = ? WHERE id = ?`, [entry.id, id]);
    logAudit(db, 'الفواتير', 'create', t('invoice.creditNote', { lng: 'ar' }), no + ' · ' + v.no); // i18n-exempt: سجل العمليات بالعربية
    return id;
  });
}
