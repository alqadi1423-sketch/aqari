/**
 * «إلغاء الدفعة» · عملية واحدة ذرّية (قرار المالك ٢٠٢٦-١٠-٠٣):
 *  ١) قيد الدفعة يُعكس بقيد مرآة بتاريخ الإلغاء، ومعه قيد خصمها المربوط بها إن وُجد.
 *  ٢) المسدَّد على القسط أو الأقساط وتوزيع التحصيل الجماعي يرجع بإعادة حسابه من الدفعات (paid.ts) ·
 *     فالدفعة الملغاة خارج المسدَّد والخصم.
 *  ٣) خصم «تنزيل من القسط» يُرجع مبلغ القسط كما كان.
 *  ٤) حركات البنك تُعكس بحركة سالبة · وفائض التحصيل الجماعي يُطرح من رصيد المستأجر الدائن.
 *  ٥) الدفعة لا تُحذف: تُوسم ملغاة بتاريخها وسببها وقيدها العاكس · ويُسجَّل الإلغاء في سجل العمليات.
 * ويُرفض بسبب يُذكر: دفعة ملغاة من قبل · رصيد دائن استُعمل بعدها · فائضٌ للعقد رُدّ أو حُوّل (يُلغى الرد أولاً).
 * والمعاينة planCancelPayment تُعرض قبل التنفيذ: القيود ومبالغها، وكل قسط بمسدَّده قبل وبعد، والبنك والرصيد.
 */
import type { DB } from '../../db/adapter';
import { uid } from '../ids';
import { today } from '../dates';
import { logAudit } from '../audit';
import { reverseEntryById } from '../accounting/post';
import { RuleViolation } from './service';
import { DISCOUNT_ENTRY_SRC, DISCOUNT_REDUCES_INSTALLMENT } from './installments';
import { recomputeInstallments, installmentsOfPayment, DERIVED_PAID_SQL } from './paid';

export interface CancelPaymentPlan {
  paymentId: string;
  contractId: string;
  tenant: string;
  date: string;
  net: number;
  /** القيود التي ستُعكس · رقمها ومبلغها */
  entries: { id: string; no: string; amount: number }[];
  /** كل قسط تمسّه الدفعة · مسدَّده الآن وبعد الإلغاء */
  installments: { id: string; due: string; fromPaid: number; toPaid: number }[];
  /** حركات البنك التي تُعكس */
  bank: { bankId: string; bankName: string; amount: number }[];
  /** ما يُطرح من رصيد المستأجر الدائن (فائض تحصيل جماعي) */
  creditReversal: number;
  /** خصم «تنزيل من القسط» يرجع إلى مبلغ القسط */
  restoreAmount: { installmentId: string; by: number } | null;
  /** أسباب المنع · فارغة إن جاز الإلغاء */
  blockers: string[];
}

const SURPLUS_SOURCES = ['surplus_refund', 'surplus_credit'];

interface PaymentRow {
  id: string; contract_id: string; installment_id: string | null; date: string; net_halalas: number;
  discount_halalas: number; discount_kind: string | null; journal_entry_id: string | null; cancelled_at: string | null;
}

function paymentRow(db: DB, paymentId: string): PaymentRow {
  const p = db.get<PaymentRow>(
    `SELECT id, contract_id, installment_id, date, net_halalas, discount_halalas, discount_kind, journal_entry_id, cancelled_at
     FROM contract_payments WHERE id = ?`, [paymentId]);
  if (!p) throw new RuleViolation('الدفعة غير موجودة');
  return p;
}

/** قيود الدفعة القائمة: قيدها وقيد خصمها المربوط بها، غير المعكوسة */
function liveEntries(db: DB, p: PaymentRow): { id: string; no: string; amount: number }[] {
  return db.all<{ id: string; no: string; amount: number }>(
    `SELECT e.id, e.no, COALESCE((SELECT SUM(l.debit_halalas) FROM journal_lines l WHERE l.entry_id = e.id), 0) AS amount
     FROM journal_entries e
     WHERE e.status = 'مرحّل' AND e.reversed_by IS NULL
       AND (e.id = ? OR (e.src_type = ? AND e.src_id = ?))
     ORDER BY e.no`, [p.journal_entry_id ?? '', DISCOUNT_ENTRY_SRC, p.id]).map((e) => ({ ...e, amount: Number(e.amount) }));
}

/** فائض التحصيل الجماعي في قيد الدفعة · دائن 2410 */
function excessCredit(db: DB, p: PaymentRow): number {
  if (!p.journal_entry_id) return 0;
  return Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(credit_halalas - debit_halalas), 0) AS s FROM journal_lines WHERE entry_id = ? AND account_code = '2410'`,
    [p.journal_entry_id])!.s);
}

export function planCancelPayment(db: DB, paymentId: string, date: string = today()): CancelPaymentPlan {
  const p = paymentRow(db, paymentId);
  const c = db.get<{ tenant_name: string; tenant_id: string | null }>(`SELECT tenant_name, tenant_id FROM contracts WHERE id = ?`, [p.contract_id]);
  const blockers: string[] = [];
  if (p.cancelled_at) blockers.push('الدفعة ملغاة من قبل');

  const credit = excessCredit(db, p);
  if (credit > 0) {
    const have = c?.tenant_id
      ? Number(db.get<{ v: number }>(`SELECT credit_halalas AS v FROM tenants WHERE id = ?`, [c.tenant_id])?.v ?? 0) : 0;
    if (have < credit) blockers.push('فائض هذه الدفعة صار رصيداً دائناً للمستأجر واستُعمل منه بعدها · فلا يُطرح كاملاً');
  }
  const settled = db.get(
    `SELECT 1 FROM journal_entries WHERE src_type IN (${SURPLUS_SOURCES.map(() => '?').join(',')}) AND src_id = ?
       AND status = 'مرحّل' AND reversed_by IS NULL LIMIT 1`, [...SURPLUS_SOURCES, p.contract_id]);
  if (settled) blockers.push('للعقد فائضٌ رُدّ أو حُوّل رصيداً · يُلغى الرد أولاً من أداة رد الفائض');

  const instIds = installmentsOfPayment(db, p.id);
  const restoreAmount = p.discount_kind === DISCOUNT_REDUCES_INSTALLMENT && p.installment_id
    ? { installmentId: p.installment_id, by: Number(p.discount_halalas) } : null;
  // المسدَّد بعد الإلغاء: المحسوب من الدفعات بلا هذه الدفعة · محدوداً بالمبلغ بعد رجوع التنزيل
  const installments = instIds.length ? db.all<{ id: string; due: string; paid: number; amount: number; mine: number; derived: number }>(
    `SELECT i.id, i.due_date AS due, i.paid_halalas AS paid, i.amount_halalas AS amount,
            ${DERIVED_PAID_SQL} AS derived,
            COALESCE((SELECT SUM(a.amount_halalas) FROM payment_allocations a WHERE a.payment_id = ? AND a.installment_id = i.id), 0)
            + (CASE WHEN ? = i.id AND NOT EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id = ?) THEN ? ELSE 0 END) AS mine
     FROM contract_installments i WHERE i.id IN (${instIds.map(() => '?').join(',')}) ORDER BY i.due_date`,
    [p.id, p.installment_id ?? '', p.id, Number(p.net_halalas), ...instIds]).map((r) => {
      const amount = Number(r.amount) + (restoreAmount && restoreAmount.installmentId === r.id ? restoreAmount.by : 0);
      return { id: r.id, due: r.due, fromPaid: Number(r.paid), toPaid: Math.min(Math.max(0, Number(r.derived) - Number(r.mine)), amount) };
    }) : [];

  const bank = db.all<{ bank_id: string; name: string; amount: number }>(
    `SELECT pl.bank_id, COALESCE(b.name, '') AS name, pl.amount_halalas AS amount
     FROM payment_lines pl LEFT JOIN banks b ON b.id = pl.bank_id
     WHERE pl.payment_id = ? AND pl.method != 'cash' AND pl.bank_id IS NOT NULL`, [p.id])
    .map((x) => ({ bankId: x.bank_id, bankName: x.name, amount: Number(x.amount) }));

  return {
    paymentId: p.id, contractId: p.contract_id, tenant: c?.tenant_name ?? '', date, net: Number(p.net_halalas),
    entries: liveEntries(db, p), installments, bank, creditReversal: credit, restoreAmount, blockers,
  };
}

/** التنفيذ · ذرّي كله أو لا شيء · يعيد معاينة ما جرى */
export function cancelPayment(db: DB, paymentId: string, input: { date?: string; reason: string }): CancelPaymentPlan {
  const date = input.date || today();
  const reason = input.reason.trim();
  if (!reason) throw new RuleViolation('اكتب سبب إلغاء الدفعة');
  const plan = planCancelPayment(db, paymentId, date);
  if (plan.blockers.length) throw new RuleViolation(plan.blockers.join(' · '));
  const p = paymentRow(db, paymentId);

  db.transaction(() => {
    // ١) القيود بمرآتها بتاريخ الإلغاء · قيد الدفعة أولاً ثم خصمها
    let cancelEntry: string | null = null;
    let cancelNo = '';
    for (const e of plan.entries) {
      const rev = reverseEntryById(db, e.id, 'إلغاء دفعة · ' + plan.tenant + ' · ' + reason, date);
      if (e.id === p.journal_entry_id && rev) { cancelEntry = rev.id; cancelNo = rev.no; }
    }
    // ٣) التنزيل من القسط يرجع إلى مبلغه
    if (plan.restoreAmount) {
      db.run(`UPDATE contract_installments SET amount_halalas = amount_halalas + ? WHERE id = ?`,
        [plan.restoreAmount.by, plan.restoreAmount.installmentId]);
    }
    // ٤) البنك بحركة سالبة مربوطة بالقيد العكسي · والرصيد الدائن
    for (const b of plan.bank) {
      db.run(
        `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
         VALUES (?,?,?,?,?,1,?,?,?)`,
        [uid(), b.bankId, date, 'إلغاء دفعة إيجار · ' + plan.tenant, -b.amount, cancelNo, 'إلغاء دفعة إيجار', new Date().toISOString()]);
    }
    if (plan.creditReversal > 0) {
      db.run(`UPDATE tenants SET credit_halalas = credit_halalas - ?
              WHERE id = (SELECT tenant_id FROM contracts WHERE id = ?)`, [plan.creditReversal, plan.contractId]);
    }
    // ٥) الوسم ثم ٢) المسدَّد من الدفعات
    db.run(`UPDATE contract_payments SET cancelled_at = ?, cancel_reason = ?, cancel_entry_id = ? WHERE id = ?`,
      [date, reason, cancelEntry, paymentId]);
    recomputeInstallments(db, plan.installments.map((i) => i.id));
    logAudit(db, 'التحصيل', 'update', 'إلغاء دفعة',
      plan.tenant + ' · ' + reason + ' · قيود معكوسة: ' + plan.entries.map((e) => e.no).join('، '));
  });
  return plan;
}
