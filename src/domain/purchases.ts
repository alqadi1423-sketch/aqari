/**
 * فواتير الشراء · التسجيل والتعديل والسداد والتراجع، بترحيل النموذج:
 * التسجيل: مصروف الفئة + ضريبة / ذمم دائنة. السداد: 2100 / 1100 + حركة بنكية.
 */
import type { DB } from '../db/adapter';
import { requireCash, entryCashEffect } from './cashGuard';
import { uid } from './ids';
import { today } from './dates';
import { pctOf, fmt as fmtH } from './money';
import { postPurchaseToLedger, postPurchasePayment, voidEntryById, reverseEntryById, postEntry, purchaseExpenseAccount } from './accounting/post';
import { addMeterReading } from './meters';
import { repostBlockers, repostCopy } from './accounting/repost';
import { logAudit } from './audit';
import { deviceLetter, ownNumbersSql, withLetter } from './numbering';

export interface PurchaseInput {
  supplier: string;
  date: string;
  due: string;
  category: string;
  incorpItem: string;
  amortize: boolean;
  amortizeMonths: number | null;
  exempt: boolean;
  excludeFromVat: boolean;
  /**
   * الوضع الضريبي · المعيار الوحيد: هل الفاتورة باسم المنشأة وبرقمها الضريبي؟
   * الافتراض «مستبعدة من الإقرار» · التحوّل إلى خاضعة بفعل صريح.
   */
  taxStatus?: TaxStatus;
  /** سبب الاستبعاد · قائمة مفتوحة (نص حر) */
  excludeReason?: string;
  unitId?: string | null;
  propertyId?: string | null;
  subtotalHalalas: number;
  /** الضريبة والإجمالي كما في مستند المورد · ما أُدخل يُحفظ ولا يُعاد حسابه */
  taxHalalas: number;
  totalHalalas: number;
  /** فرق تقريب قبله المستخدم صراحة: subtotal + tax + roundingDiff = total */
  roundingDiffHalalas?: number;
  meterId?: string | null;
  meterReading?: number | null;
}

// بلغة الهيئة: «قابلة للخصم» المصطلح الرسمي · الاسم وحده يكفي بلا شرح
export type TaxStatus = 'فاتورة ضريبية · قابلة للخصم' | 'غير قابلة للخصم' | 'معفاة من الضريبة' | 'خاضعة بنسبة صفرية';
export const TS_DEDUCTIBLE: TaxStatus = 'فاتورة ضريبية · قابلة للخصم';
export const TS_EXCLUDED: TaxStatus = 'غير قابلة للخصم';
export const TS_EXEMPT: TaxStatus = 'معفاة من الضريبة';
export const TS_ZERO: TaxStatus = 'خاضعة بنسبة صفرية';
export const TAX_STATUSES: TaxStatus[] = [TS_EXCLUDED, TS_DEDUCTIBLE, TS_EXEMPT, TS_ZERO];
export const EXCLUDE_REASONS = [
  'الفاتورة باسم المالك',
  'الفاتورة باسم المستأجر',
  'المورد غير مسجَّل في الضريبة',
  'إيصال لا فاتورة ضريبية',
  'الفاتورة ناقصة البيانات النظامية',
];

/** الفترة الضريبية من التاريخ: 2026-Q1 … 2026-Q4 */
export function taxPeriodOf(date: string): string {
  const m = parseInt(date.slice(5, 7), 10) || 1;
  return date.slice(0, 4) + '-Q' + (Math.floor((m - 1) / 3) + 1);
}

export function purchaseTax(subtotalHalalas: number, exempt: boolean): number {
  return exempt ? 0 : pctOf(subtotalHalalas, 15);
}

export function nextPurchaseNo(db: DB): string {
  // تسلسل هذا الجهاز وحده (numbering.ts)
  const letter = deviceLetter(db);
  const own = ownNumbersSql('no', 'PUR-[0-9]*', letter);
  const row = db.get<{ mx: number }>(
    `SELECT COALESCE(MAX(CAST(substr(no, 5) AS INTEGER)),0) AS mx FROM purchases WHERE ${own.sql}`, own.params
  );
  return withLetter('PUR-' + String((row ? Number(row.mx) : 0) + 1).padStart(3, '0'), letter);
}

export function savePurchase(db: DB, input: PurchaseInput, existingId?: string): string {
  if (!input.subtotalHalalas && !input.totalHalalas) throw new Error('الرجاء إدخال مبالغ الفاتورة');
  return db.transaction(() => {
    // الافتراض مستبعدة ما لم يُثبَت العكس · و«خاضعة باسمنا» تشترط الرقم الضريبي للمورد
    const taxStatus: TaxStatus = input.taxStatus ?? (input.exempt ? TS_EXEMPT : TS_EXCLUDED);
    // الرقم الضريبي يأتي من بطاقة المورد · مصدر واحد للحقيقة، ويُلتقط لقطةً في الفاتورة
    let supplierVat = '';
    if (taxStatus === TS_DEDUCTIBLE) {
      supplierVat = (db.get<{ vat: string }>(
        `SELECT vat FROM suppliers WHERE name = ? AND deleted_at IS NULL`, [input.supplier]
      )?.vat ?? '').trim();
      if (!supplierVat) {
        throw new Error('المورد «' + input.supplier + '» بلا رقم ضريبي في بطاقته · أضِفه في نافذة المورد أولاً، فالرقم شرط نظامي للخصم');
      }
    }
    const tax = input.taxHalalas;
    const total = input.totalHalalas;
    const diff = input.roundingDiffHalalas ?? 0;
    if (input.subtotalHalalas + tax + diff !== total) {
      throw new Error(
        `الأساس + الضريبة = ${fmtH(input.subtotalHalalas + tax)} والإجمالي المُدخل ${fmtH(total)} · الفرق ${fmtH(Math.abs(total - input.subtotalHalalas - tax))}`
      );
    }
    const id = existingId ?? uid();
    let no: string;
    let beforeSnap: Record<string, unknown> | undefined;
    if (existingId) {
      // القيم قبل التعديل لسجل العمليات · «من أي قيمة إلى أي قيمة»
      const p = db.get<{
        no: string; journal_entry_id: string | null; supplier_name: string; date: string; due: string;
        subtotal_halalas: number; tax_halalas: number; total_halalas: number; tax_status: string;
      }>(
        `SELECT no, journal_entry_id, supplier_name, date, due, subtotal_halalas, tax_halalas, total_halalas, tax_status
         FROM purchases WHERE id = ?`, [existingId]
      );
      if (!p) throw new Error('تعذّر العثور على الفاتورة');
      no = p.no;
      beforeSnap = {
        المورد: p.supplier_name, التاريخ: p.date, الاستحقاق: p.due,
        'قبل الضريبة': Number(p.subtotal_halalas), الضريبة: Number(p.tax_halalas),
        الإجمالي: Number(p.total_halalas), 'الوضع الضريبي': p.tax_status,
      };
      // القيد المرحّل يُعكس بقيد مرآة يبقى في الدفتر ثم يُرحَّل قيد القيم الجديدة · لا إخفاء
      if (p.journal_entry_id) {
        if (!reverseEntryById(db, p.journal_entry_id, 'عكس قيد فاتورة شراء ' + no + ' · تعديل الفاتورة'))
          voidEntryById(db, p.journal_entry_id);
      }
      db.run(
        `UPDATE purchases SET supplier_name=?, date=?, due=?, category=?, incorp_item=?, amortize=?,
          amortize_months=?, exempt=?, exclude_from_vat=?, unit_id=?, property_id=?,
          subtotal_halalas=?, tax_halalas=?, total_halalas=?,
          tax_status=?, exclude_reason=?, supplier_vatno=? WHERE id = ?`,
        [input.supplier, input.date, input.due, input.category, input.incorpItem,
         input.amortize ? 1 : 0, input.amortizeMonths, taxStatus === TS_EXEMPT ? 1 : 0,
         taxStatus === TS_EXCLUDED ? 1 : 0, input.unitId ?? null, input.propertyId ?? null,
         input.subtotalHalalas, tax, total,
         taxStatus, input.excludeReason ?? '', supplierVat, existingId]
      );
    } else {
      no = nextPurchaseNo(db);
      db.run(
        `INSERT INTO purchases (id, no, supplier_name, date, due, category, incorp_item, amortize,
          amortize_months, exempt, exclude_from_vat, tax_status, exclude_reason, supplier_vatno, unit_id, property_id,
          subtotal_halalas, tax_halalas, total_halalas, meter_id, meter_reading, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, no, input.supplier, input.date, input.due, input.category, input.incorpItem,
         input.amortize ? 1 : 0, input.amortizeMonths, taxStatus === TS_EXEMPT ? 1 : 0,
         taxStatus === TS_EXCLUDED ? 1 : 0, taxStatus, input.excludeReason ?? '', supplierVat, input.unitId ?? null, input.propertyId ?? null,
         input.subtotalHalalas, tax, total, input.meterId ?? null, input.meterReading ?? null,
         new Date().toISOString()]
      );
      if (input.meterId) {
        addMeterReading(db, input.meterId, input.meterReading ?? null, total, input.date, no);
      }
    }
    const entry = postPurchaseToLedger(db, {
      id, no, supplier: input.supplier, date: input.date,
      category: input.category, subtotal: input.subtotalHalalas, tax, total,
      roundingDiff: diff, deductible: taxStatus === TS_DEDUCTIBLE,
    });
    db.run(`UPDATE purchases SET journal_entry_id = ? WHERE id = ?`, [entry ? entry.id : null, id]);
    logAudit(db, 'فواتير الشراء', existingId ? 'update' : 'create', 'فاتورة شراء', no, beforeSnap,
      existingId ? {
        المورد: input.supplier, التاريخ: input.date, الاستحقاق: input.due,
        'قبل الضريبة': input.subtotalHalalas, الضريبة: tax, الإجمالي: total, 'الوضع الضريبي': taxStatus,
      } : undefined);
    return id;
  });
}

/**
 * التراجع عن سداد قائم (لتعديل بيانات السداد أو التراجع عنه) ·
 * القيد المرحَّل لا يُمس ولا يُخفى: يُرحَّل قيد عكس مرآة بتاريخ اليوم ويبقى الأصل في الدفتر.
 */
/** ما أخرجه سداد الفاتورة القائم من المحفظة · يعود بعكسه قبل السداد الجديد */
export function priorPaymentCashOut(db: DB, id: string): number {
  const p = db.get<{ paid: number; pj: string | null }>(`SELECT paid, payment_journal_entry_id AS pj FROM purchases WHERE id = ?`, [id]);
  if (!p || !Number(p.paid) || !p.pj) return 0;
  return Math.max(0, -entryCashEffect(db, p.pj));
}

export function reversePurchasePayment(db: DB, id: string, keepTerms = false): void {
  const p = db.get<{
    no: string; payment_journal_entry_id: string | null;
    payment_method: string | null; payment_bank_id: string | null; total_halalas: number;
  }>(`SELECT no, payment_journal_entry_id, payment_method, payment_bank_id, total_halalas
      FROM purchases WHERE id = ?`, [id]);
  if (!p || !p.payment_journal_entry_id) return;
  const je = db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ?`, [p.payment_journal_entry_id]);
  const rev = reverseEntryById(db, p.payment_journal_entry_id,
    'عكس سداد الفاتورة ' + p.no + ' · تراجع عن القيد ' + (je ? je.no : ''));
  // حركات البنوك لا تُخفى: لكل حركة مرتبطة بقيد السداد تُضاف حركة معاكسة (وارد يقابل الصادر)
  // مرتبطة بقيد العكس فيبقى كشف البنك صادقاً مع الدفتر · يشمل السداد المقسَّم على حسابات عدة
  if (je && rev) {
    const txs = db.all<{ bank_id: string; amount_halalas: number }>(
      `SELECT bank_id, amount_halalas FROM bank_tx WHERE journal_no = ? AND deleted_at IS NULL`,
      [je.no]
    );
    for (const t of txs) {
      db.run(
        `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
         VALUES (?,?,?,?,?,1,?,?,?)`,
        [uid(), t.bank_id, today(), 'عكس سداد الفاتورة ' + p.no + ' · تراجع',
         -Number(t.amount_halalas), rev.no, 'عكس سداد فاتورة · تراجع', new Date().toISOString()]
      );
    }
  }
  // الحذف إلى السلة يُبقي السداد وربط قيده المعكوس لتعيده الاستعادة كما كان (المراجعة ٤.٦)
  if (keepTerms) return;
  db.run(
    `UPDATE purchases SET paid = 0, payment_journal_entry_id = NULL, paid_date = NULL,
      payment_method = NULL, payment_bank_id = NULL WHERE id = ?`,
    [id]
  );
}

/** تسديد فاتورة شراء (أو تعديل بيانات سداد قائم) */
export type PurchasePayMethod = 'bank' | 'cash' | 'cheque' | 'card';
const PAY_LABEL: Record<PurchasePayMethod, string> = {
  cash: 'نقداً', bank: 'تحويل بنكي', cheque: 'شيك', card: 'بطاقة',
};

export function payPurchase(
  db: DB,
  id: string,
  method: PurchasePayMethod,
  bankId: string | null,
  payDate: string = today()
): void {
  db.transaction(() => {
    const p = db.get<{
      no: string; supplier_name: string; category: string; total_halalas: number; paid: number;
    }>(`SELECT no, supplier_name, category, total_halalas, paid FROM purchases WHERE id = ?`, [id]);
    if (!p) throw new Error('تعذّر العثور على الفاتورة');
    if (method !== 'cash' && !bankId) throw new Error('اختر الحساب البنكي (' + PAY_LABEL[method] + ')، أو بدِّل الطريقة لنقداً');
    // كفاية النقد (قرار المالك ٢٠٢٦-١٠-٠٥) · وسدادٌ سابق يُعكس أولاً يعيد ما أخرجه
    if (method === 'cash') requireCash(db, Number(p.total_halalas) - priorPaymentCashOut(db, id), 'سداد الفاتورة ' + p.no);
    if (Number(p.paid)) reversePurchasePayment(db, id);
    const entry = postPurchasePayment(
      db,
      { id, no: p.no, supplier: p.supplier_name, total: Number(p.total_halalas) },
      payDate,
      method === 'cash'
    );
    if (method !== 'cash' && bankId) {
      db.run(
        `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
         VALUES (?,?,?,?,?,1,?,?,?)`,
        [uid(), bankId, payDate, 'سداد ' + p.category + ' · ' + p.supplier_name,
         -Number(p.total_halalas), entry ? entry.no : '',
         'سداد فاتورة · ' + PAY_LABEL[method], new Date().toISOString()]
      );
    }
    db.run(
      `UPDATE purchases SET paid = 1, paid_date = ?, payment_method = ?, payment_bank_id = ?,
        payment_journal_entry_id = ? WHERE id = ?`,
      [payDate, PAY_LABEL[method], method !== 'cash' ? bankId : null, entry ? entry.id : null, id]
    );
    logAudit(db, 'فواتير الشراء', 'update', 'سداد فاتورة', p.no);
  });
}

export interface PurchasePayLine {
  method: PurchasePayMethod;
  bankId?: string | null;
  amountHalalas: number;
}

/**
 * سداد فاتورة شراء مقسَّماً على طرق دفع متعددة (نقداً + تحويل + شيك + بطاقة) ·
 * مجموع الأسطر يجب أن يساوي إجمالي الفاتورة، وكل سطر غير نقدي يسجّل حركته البنكية.
 */
export function payPurchaseSplit(db: DB, id: string, lines: PurchasePayLine[], payDate: string = today()): void {
  db.transaction(() => {
    const p = db.get<{
      no: string; supplier_name: string; category: string; total_halalas: number; paid: number;
    }>(`SELECT no, supplier_name, category, total_halalas, paid FROM purchases WHERE id = ?`, [id]);
    if (!p) throw new Error('تعذّر العثور على الفاتورة');
    const valid = lines.filter((l) => (l.amountHalalas || 0) > 0);
    if (!valid.length) throw new Error('أدخل مبلغاً واحداً على الأقل');
    for (const l of valid) {
      if (l.method !== 'cash' && !l.bankId)
        throw new Error('اختر الحساب البنكي (' + PAY_LABEL[l.method] + ')، أو بدِّل الطريقة لنقداً');
    }
    const sum = valid.reduce((s, l) => s + l.amountHalalas, 0);
    const total = Number(p.total_halalas);
    if (sum !== total) {
      throw new Error(`مجموع طرق السداد ${fmtH(sum)} لا يساوي إجمالي الفاتورة ${fmtH(total)} · الفارق ${fmtH(Math.abs(total - sum))}`);
    }
    const cashPart = valid.filter((l) => l.method === 'cash').reduce((s, l) => s + l.amountHalalas, 0);
    requireCash(db, cashPart - priorPaymentCashOut(db, id), 'سداد الفاتورة ' + p.no + ' نقداً');
    if (Number(p.paid)) reversePurchasePayment(db, id);
    const allCash = valid.every((l) => l.method === 'cash');
    const entry = postPurchasePayment(
      db, { id, no: p.no, supplier: p.supplier_name, total }, payDate, allCash
    );
    for (const l of valid) {
      if (l.method === 'cash') continue;
      db.run(
        `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
         VALUES (?,?,?,?,?,1,?,?,?)`,
        [uid(), l.bankId!, payDate, 'سداد ' + p.category + ' · ' + p.supplier_name,
         -l.amountHalalas, entry ? entry.no : '',
         'سداد فاتورة · ' + PAY_LABEL[l.method], new Date().toISOString()]
      );
    }
    const methodLabel = valid.map((l) => PAY_LABEL[l.method]).join(' + ');
    const firstBank = valid.find((l) => l.method !== 'cash')?.bankId ?? null;
    db.run(
      `UPDATE purchases SET paid = 1, paid_date = ?, payment_method = ?, payment_bank_id = ?,
        payment_journal_entry_id = ? WHERE id = ?`,
      [payDate, methodLabel, firstBank, entry ? entry.id : null, id]
    );
    logAudit(db, 'فواتير الشراء', 'update', 'سداد فاتورة (' + methodLabel + ')', p.no);
  });
}

export function unmarkPurchasePaid(db: DB, id: string): void {
  db.transaction(() => {
    reversePurchasePayment(db, id);
    const p = db.get<{ no: string }>(`SELECT no FROM purchases WHERE id = ?`, [id]);
    if (p) logAudit(db, 'فواتير الشراء', 'update', 'تراجع عن سداد', p.no);
  });
}

/** حذف ناعم · قيدا التسجيل والسداد يُعكَسان بقيدي مرآة ولا يُخفيان */
export function deletePurchase(db: DB, id: string): void {
  db.transaction(() => {
    const p = db.get<{ no: string; journal_entry_id: string | null; paid: number }>(
      `SELECT no, journal_entry_id, paid FROM purchases WHERE id = ?`, [id]
    );
    if (!p) return;
    if (Number(p.paid)) reversePurchasePayment(db, id, true); // السداد يبقى مربوطاً بقيده المعكوس لتعيده الاستعادة
    if (p.journal_entry_id) {
      if (!reverseEntryById(db, p.journal_entry_id)) voidEntryById(db, p.journal_entry_id);
    }
    db.run(`UPDATE purchases SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    logAudit(db, 'فواتير الشراء', 'delete', 'فاتورة شراء', p.no);
  });
}

/** قيدٌ مرحّل عكسه الحذف · يُعاد بنسخته */
const reversedEntry = (db: DB, entryId: string | null) => entryId
  ? db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE id = ? AND status = 'مرحّل' AND reversed_by IS NOT NULL`, [entryId])?.id ?? null
  : null;

/**
 * الاستعادة من السلة (المراجعة ٤.٦) · قيد التسجيل وقيد السداد يُعاد كلٌّ بنسخة سطوره نفسها، فتبقى القابلية للخصم
 * وفرق التقريب وحركات البنك كما كانت. وما يمنع ذلك (بنك أو حساب محذوف) يرفض الاستعادة بسببه قبل أي تغيير.
 */
export function restorePurchase(db: DB, id: string): void {
  db.transaction(() => {
    const p = db.get<{ no: string; journal_entry_id: string | null; payment_journal_entry_id: string | null; paid: number }>(
      `SELECT no, journal_entry_id, payment_journal_entry_id, paid FROM purchases WHERE id = ?`, [id]);
    if (!p) return;
    const reg = reversedEntry(db, p.journal_entry_id);
    const pay = Number(p.paid) ? reversedEntry(db, p.payment_journal_entry_id) : null;
    const blockers = [...(reg ? repostBlockers(db, reg) : []), ...(pay ? repostBlockers(db, pay) : [])];
    if (blockers.length) throw new Error('لا تُستعاد الفاتورة ' + p.no + ': ' + blockers.join('، '));
    db.run(`UPDATE purchases SET deleted_at = NULL WHERE id = ?`, [id]);
    if (reg) db.run(`UPDATE purchases SET journal_entry_id = ? WHERE id = ?`, [repostCopy(db, reg, 'استعادة من السلة')?.id ?? null, id]);
    if (pay) db.run(`UPDATE purchases SET payment_journal_entry_id = ? WHERE id = ?`, [repostCopy(db, pay, 'استعادة من السلة')?.id ?? null, id]);
    else if (Number(p.paid) && !p.payment_journal_entry_id) {
      // حُذفت بنسخة سابقة كانت تمحو السداد: تعود غير مسدَّدة كما كانت تلك النسخة
      db.run(`UPDATE purchases SET paid = 0, paid_date = NULL, payment_method = NULL, payment_bank_id = NULL WHERE id = ?`, [id]);
    }
    logAudit(db, 'فواتير الشراء', 'update', 'استعادة فاتورة شراء', p.no);
  });
}

/** الضريبة المقدَّمة في إقرار الفترة · تحديث حالة لا قيد */
export function markVatFiled(db: DB, purchaseId: string): void {
  const p = db.get<{ no: string; date: string; tax_status: string }>(
    `SELECT no, date, tax_status FROM purchases WHERE id = ?`, [purchaseId]);
  if (!p) throw new Error('تعذّر العثور على الفاتورة');
  if (p.tax_status !== TS_DEDUCTIBLE) throw new Error('الاسترداد لفواتير «' + TS_DEDUCTIBLE + '» وحدها · هذه ' + p.tax_status);
  db.transaction(() => {
    db.run(`UPDATE purchases SET refund_status = ? WHERE id = ?`,
      ['مُقدَّم في إقرار ' + taxPeriodOf(p.date), purchaseId]);
    logAudit(db, 'فواتير الشراء', 'update', 'حالة استرداد الضريبة', p.no);
  });
}

/** استرداد الضريبة نقداً: مدين 1100 / دائن 1270 · يُقفَل رصيد الفاتورة في 1270 */
export function markVatRefunded(db: DB, purchaseId: string, date: string): void {
  const p = db.get<{ no: string; supplier_name: string; tax_halalas: number; tax_status: string; refund_status: string }>(
    `SELECT no, supplier_name, tax_halalas, tax_status, refund_status FROM purchases WHERE id = ?`, [purchaseId]);
  if (!p) throw new Error('تعذّر العثور على الفاتورة');
  if (p.tax_status !== TS_DEDUCTIBLE) throw new Error('الاسترداد لفواتير «' + TS_DEDUCTIBLE + '» وحدها · هذه ' + p.tax_status);
  if (p.refund_status.startsWith('مسترَد')) throw new Error('ضريبة الفاتورة ' + p.no + ' مسترَدة من قبل');
  db.transaction(() => {
    postEntry(db, {
      date,
      memo: 'استرداد ضريبة مدخلات · فاتورة ' + p.no + ' · ' + p.supplier_name,
      srcType: 'vat_refund', srcId: purchaseId,
      lines: [
        { account: '1100', descr: 'استرداد ضريبة', debit: Number(p.tax_halalas), credit: 0 },
        { account: '1270', descr: 'إقفال ضريبة الفاتورة ' + p.no, debit: 0, credit: Number(p.tax_halalas) },
      ],
    });
    db.run(`UPDATE purchases SET refund_status = ?, refund_date = ? WHERE id = ?`,
      ['مسترَد بتاريخ ' + date, date, purchaseId]);
    logAudit(db, 'فواتير الشراء', 'update', 'استرداد ضريبة', p.no);
  });
}

/** رفض الاسترداد: الضريبة تصير جزءاً من التكلفة · مدين مصروف الفئة / دائن 1270 */
export function markVatRejected(db: DB, purchaseId: string, date: string): void {
  const p = db.get<{ no: string; supplier_name: string; category: string; tax_halalas: number; tax_status: string }>(
    `SELECT no, supplier_name, category, tax_halalas, tax_status FROM purchases WHERE id = ?`, [purchaseId]);
  if (!p) throw new Error('تعذّر العثور على الفاتورة');
  if (p.tax_status !== TS_DEDUCTIBLE) throw new Error('الاسترداد لفواتير «' + TS_DEDUCTIBLE + '» وحدها · هذه ' + p.tax_status);
  db.transaction(() => {
    postEntry(db, {
      date,
      memo: 'رفض استرداد ضريبة · فاتورة ' + p.no + ' · الضريبة جزء من التكلفة',
      srcType: 'vat_refund', srcId: purchaseId,
      lines: [
        { account: purchaseExpenseAccount(p.category), descr: 'ضريبة غير مستردة', debit: Number(p.tax_halalas), credit: 0 },
        { account: '1270', descr: 'إقفال ضريبة الفاتورة ' + p.no, debit: 0, credit: Number(p.tax_halalas) },
      ],
    });
    db.run(`UPDATE purchases SET refund_status = 'مرفوض' WHERE id = ?`, [purchaseId]);
    logAudit(db, 'فواتير الشراء', 'update', 'رفض استرداد ضريبة', p.no);
  });
}
