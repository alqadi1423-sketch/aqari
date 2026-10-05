/**
 * مراجعة الأقساط من الدفتر · الدفتر هو المرجع، ولأي قاعدة لأي مستخدم:
 *  - خصم كل قسط من سطور حساب الخصم 4900 (INSTALLMENT_DISCOUNT_SQL).
 *  - نقد كل عقد من قيود دفعاته: دائن الإيراد في قيد الدفعة ناقص سطر الخصم فيه.
 * يُقترح مسدَّد القسط حين يحسمه الدفتر وحده، وما لا يحسمه يُترك كما هو ويُذكر سببه للمستخدم.
 * ولا يمسّ قيداً ولا دفعة ولا توزيعاً · ولا يُطبَّق شيء إلا بأمر المستخدم (applyLedgerRepair).
 *
 * ومعه الخصومات التي لا سطر لها في الدفتر (سُجّلت قبل أن يكون للخصم سطر): تُعرض، ولا يُنشأ لها شيء
 * حتى يحدد المستخدم نوع كل واحد (bookDiscount) · فيكون قيداً جديداً أو تنزيلاً من القسط، لا تعديلاً لقائم.
 *
 * والفائض عن الأقساط (نقد في الدفتر لم يُنسب لقسط): يبقى ظاهراً حتى يُردّ للمستأجر أو يُحوَّل رصيداً
 * دائناً له (settleSurplus) · بقيد جديد بتاريخ التنفيذ وطريقته، وفي سجل العمليات.
 */
import type { DB } from '../db/adapter';
import { uid } from './ids';
import { logAudit } from './audit';
import { fmt } from './money';
import { postBookedDiscount, postEntry, type PostedEntry } from './accounting/post';
import { walletCashBalance } from './accounting/ledger';
import { DERIVED_PAID_SQL, recomputeInstallments } from './contracts/paid';
import {
  INSTALLMENT_DISCOUNT_SQL, installmentStoredStatus, DISCOUNT_ACCOUNT, DISCOUNT_ENTRY_SRC,
  DISCOUNT_AFTER_DUE, DISCOUNT_REDUCES_INSTALLMENT, type DiscountKind,
} from './contracts/installments';

export interface LedgerRepairChange {
  installmentId: string;
  contractId: string;
  contractNo: string;
  tenant: string;
  due: string;
  amount: number;
  fromPaid: number;
  toPaid: number;
  fromStatus: string;
  toStatus: string;
  /** خصم القسط في الدفتر */
  ledgerDiscount: number;
  /** الخصم المنسوب إلى القسط في صفوف الدفعات (للمقارنة) */
  rowsDiscount: number;
  /** أرقام القيود التي تسند خصمه */
  discountEntries: string[];
  /** قيود الدفعات التي منها نقد العقد */
  cashEntries: number;
}

export interface LedgerRepairIssue {
  contractId: string;
  contractNo: string;
  tenant: string;
  reason: string;
}

export interface LedgerRepairPlan {
  changes: LedgerRepairChange[];
  issues: LedgerRepairIssue[];
}

interface InstRow { id: string; due_date: string; amount: number; paid: number; derived: number; status: string; disc: number; rows_disc: number }

const label = (c: { contract_no: string | null; tenant_name: string | null }) => ({
  contractNo: c.contract_no || 'بلا رقم عقد',
  tenant: c.tenant_name || 'بلا مستأجر',
});

/**
 * عقود فيها قسط تتجاوز دفعاتُه مع خصمه في الدفتر مبلغَه · وحدها ما يُنظر فيه.
 * والدفعات تُحسب بلا حدّ (المسدَّد المخزَّن محدودٌ بالمبلغ منذ الهجرة ٢١ فلا يُظهر التجاوز)،
 * والمخزَّن نفسه إن كُتب فوق مبلغه أو سالباً.
 */
function contractsInBreach(db: DB): string[] {
  return db.all<{ id: string }>(
    `SELECT DISTINCT i.contract_id AS id FROM contract_installments i
     WHERE i.status != 'ملغية' AND (i.paid_halalas < 0 OR i.paid_halalas + ${INSTALLMENT_DISCOUNT_SQL} > i.amount_halalas
       OR ${DERIVED_PAID_SQL} + ${INSTALLMENT_DISCOUNT_SQL} > i.amount_halalas)`
  ).map((r) => r.id);
}

/** الاقتراح كاملاً · قراءة محضة */
export function planLedgerRepair(db: DB): LedgerRepairPlan {
  const plan: LedgerRepairPlan = { changes: [], issues: [] };
  for (const cid of contractsInBreach(db)) {
    const c = db.get<{ contract_no: string | null; tenant_name: string | null }>(
      `SELECT contract_no, tenant_name FROM contracts WHERE id = ?`, [cid]);
    const who = label(c ?? { contract_no: null, tenant_name: null });
    const issue = (reason: string) => plan.issues.push({ contractId: cid, ...who, reason });

    // نقد العقد من الدفتر · كل دفعة لها قيد مرحّل قائم، وإلا فلا يُحسب النقد من الدفتر
    const orphan = db.get<{ date: string; net: number }>(
      `SELECT p.date, p.net_halalas AS net FROM contract_payments p
       LEFT JOIN journal_entries e ON e.id = p.journal_entry_id
       WHERE p.contract_id = ? AND p.net_halalas > 0 AND p.cancelled_at IS NULL
         AND (e.id IS NULL OR e.status != 'مرحّل' OR e.reversed_by IS NOT NULL)
       ORDER BY p.date LIMIT 1`, [cid]);
    if (orphan) {
      issue(`دفعة ${orphan.date} (${fmt(Number(orphan.net))}) بلا قيد مرحّل قائم في الدفتر · فلا يُعرف نقد العقد من الدفتر`);
      continue;
    }
    const cash = db.get<{ c: number; n: number }>(
      `SELECT COALESCE(SUM(CASE
                WHEN l.account_code = '4200' THEN l.credit_halalas - l.debit_halalas
                WHEN l.account_code = '${DISCOUNT_ACCOUNT}' THEN l.credit_halalas - l.debit_halalas
                ELSE 0 END), 0) AS c,
              COUNT(DISTINCT p.journal_entry_id) AS n
       FROM contract_payments p JOIN journal_lines l ON l.entry_id = p.journal_entry_id
       WHERE p.contract_id = ? AND p.cancelled_at IS NULL`, [cid])!;

    const insts = db.all<InstRow>(
      `SELECT i.id, i.due_date, i.amount_halalas AS amount, i.paid_halalas AS paid, i.status,
              ${INSTALLMENT_DISCOUNT_SQL} AS disc, ${DERIVED_PAID_SQL} AS derived,
              COALESCE((SELECT SUM(p.discount_halalas) FROM contract_payments p WHERE p.installment_id = i.id AND p.cancelled_at IS NULL), 0) AS rows_disc
       FROM contract_installments i WHERE i.contract_id = ? ORDER BY i.due_date, i.sort, i.id`, [cid]
    ).map((r) => ({ ...r, amount: Number(r.amount), paid: Number(r.paid), derived: Number(r.derived), disc: Number(r.disc), rows_disc: Number(r.rows_disc) }));
    const live = insts.filter((i) => i.status !== 'ملغية');
    const cancelledPaid = insts.filter((i) => i.status === 'ملغية').reduce((s, i) => s + i.paid, 0);
    const cashLive = Number(cash.c) - cancelledPaid;

    const tooBig = live.find((i) => i.disc > i.amount);
    if (tooBig) {
      issue(`خصم قسط ${tooBig.due_date} في الدفتر (${fmt(tooBig.disc)}) أكبر من مبلغه (${fmt(tooBig.amount)})`);
      continue;
    }
    // ما دفعته دفعات العقد على أقساطه بلا حدّ · يساوي نقد الدفتر متى كان لكل دفعة قيدها
    const paidSum = live.reduce((s, i) => s + i.derived, 0);
    if (paidSum !== cashLive) {
      issue(`مسدَّد الأقساط (${fmt(paidSum)}) لا يطابق نقد الدفعات في الدفتر (${fmt(cashLive)}) · فلا يُعرف أي الأقساط يُصحَّح`);
      continue;
    }
    const capacity = live.reduce((s, i) => s + (i.amount - i.disc), 0);
    if (cashLive < capacity) {
      issue(`على العقد بعد خصومه في الدفتر متبقٍ ${fmt(capacity - cashLive)} ولا يحدد الدفتر أي أقساطه لم تُسدَّد`);
      continue;
    }
    // الدفتر يحسمه: كل قسط حيّ مسدَّد بمبلغه ناقص خصمه
    for (const i of live) {
      const toPaid = i.amount - i.disc;
      if (toPaid === i.paid) continue;
      const discountEntries = db.all<{ no: string }>(
        `SELECT DISTINCT e.no FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '${DISCOUNT_ACCOUNT}'
         /* تشمل الملغاة: قيودها معكوسة فيستبعدها reversed_by */
         WHERE e.status = 'مرحّل' AND e.reversed_by IS NULL AND (
           (e.src_type = '${DISCOUNT_ENTRY_SRC}' AND e.src_id = ?)
           OR e.id IN (SELECT journal_entry_id FROM contract_payments WHERE installment_id = ?)
           OR (e.src_type = '${DISCOUNT_ENTRY_SRC}' AND e.src_id IN (SELECT id FROM contract_payments WHERE installment_id = ?)))
         ORDER BY e.no`, [i.id, i.id, i.id]).map((r) => r.no);
      plan.changes.push({
        installmentId: i.id, contractId: cid, ...who, due: i.due_date, amount: i.amount,
        fromPaid: i.paid, toPaid, fromStatus: i.status,
        toStatus: toPaid + i.disc > 0 ? installmentStoredStatus(i.amount, toPaid, i.disc) : 'مستحقة',
        ledgerDiscount: i.disc, rowsDiscount: i.rows_disc, discountEntries, cashEntries: Number(cash.n),
      });
    }
    if (cashLive > capacity) {
      issue(`نقد زائد ${fmt(cashLive - capacity)} عن أقساط العقد بعد خصومها في الدفتر · لم يُنسب لقسط ويبقى قرارُه لك`);
    }
  }
  return plan;
}

/**
 * تطبيق الاقتراح بأمر المستخدم · بشرط أن يكون كل قسط كما عُرض، وكل تغيير في سجل العمليات بقيمه قبل وبعد.
 * والمسدَّد يُحسب من الدفعات وتوزيعها (الهجرة ٢١) فلا يُكتب رقماً: يُعاد توزيع دفعات العقد على أقساطه
 * بترتيب الاستحقاق حتى يبلغ كلٌّ مبلغه ناقصاً خصمه في الدفتر، وما زاد يبقى فائضاً بلا توزيع ·
 * فيخرج المسدَّد المحسوب كما في الاقتراح على كل جهاز تصله الدفعات وتوزيعها. لا يمسّ قيداً.
 */
export function applyLedgerRepair(db: DB, plan: LedgerRepairPlan): number {
  return db.transaction(() => {
    for (const ch of plan.changes) {
      const cur = db.get<{ paid: number; status: string }>(
        `SELECT paid_halalas AS paid, status FROM contract_installments WHERE id = ?`, [ch.installmentId]);
      if (!cur || Number(cur.paid) !== ch.fromPaid || cur.status !== ch.fromStatus)
        throw new Error(`تغيّر قسط ${ch.tenant} · ${ch.due} منذ عرض التصحيح · أعد العرض`);
      logAudit(db, 'البيانات', 'update', 'تصحيح من الدفتر',
        `${ch.tenant} · ${ch.contractNo} · ${ch.due}: المسدَّد ${fmt(ch.fromPaid)} ← ${fmt(ch.toPaid)} · خصمه في الدفتر ${fmt(ch.ledgerDiscount)}`
          + (ch.discountEntries.length ? ' (' + ch.discountEntries.join('، ') + ')' : ''),
        { paid_halalas: ch.fromPaid, status: ch.fromStatus }, { paid_halalas: ch.toPaid, status: ch.toStatus });
    }
    const touched = new Set(plan.changes.map((c) => c.contractId));
    for (const cid of touched) reallocateContract(db, cid);
    const after = new Map(recomputeInstallments(db, plan.changes.map((c) => c.installmentId)).map((x) => [x.installmentId, x.toPaid]));
    for (const ch of plan.changes) {
      const got = after.get(ch.installmentId) ?? ch.fromPaid;
      if (got !== ch.toPaid) throw new Error(`لم يبلغ قسط ${ch.tenant} · ${ch.due} مسدَّده المقترح بعد التوزيع · أُلغي التصحيح`);
    }
    // ما لم يحسمه الدفتر في عقد صُحّح (كالنقد الزائد) يخرج من المراجعة بعد التصحيح · فيُسجَّل لئلا يضيع
    for (const x of plan.issues.filter((i) => touched.has(i.contractId))) {
      logAudit(db, 'البيانات', 'update', 'ما لم يحسمه الدفتر', `${x.tenant} · ${x.contractNo}: ${x.reason}`);
    }
    return plan.changes.length;
  });
}

/**
 * توزيع دفعات العقد غير الملغاة على أقساطه الحيّة بترتيب الاستحقاق · كلٌّ حتى مبلغه ناقصاً خصمه.
 * يستبدل توزيع هذه الدفعات كله، والدفعة الفردية تصير موزَّعة (فتُحسب بتوزيعها وحده).
 */
function reallocateContract(db: DB, contractId: string): void {
  const insts = db.all<{ id: string; amount: number; disc: number }>(
    `SELECT i.id, i.amount_halalas AS amount, ${INSTALLMENT_DISCOUNT_SQL} AS disc FROM contract_installments i
     WHERE i.contract_id = ? AND i.status != 'ملغية' ORDER BY i.due_date, i.sort, i.id`, [contractId])
    .map((i) => ({ id: i.id, room: Math.max(0, Number(i.amount) - Number(i.disc)) }));
  const pays = db.all<{ id: string; net: number }>(
    `SELECT id, net_halalas AS net FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL AND net_halalas > 0
     ORDER BY date, created_at, id`, [contractId]);
  for (const p of pays) db.run(`DELETE FROM payment_allocations WHERE payment_id = ?`, [p.id]);
  let k = 0;
  for (const p of pays) {
    let left = Number(p.net);
    while (left > 0 && k < insts.length) {
      const take = Math.min(left, insts[k].room);
      if (take > 0) {
        db.run(`INSERT INTO payment_allocations (id, payment_id, installment_id, amount_halalas) VALUES (?,?,?,?)`,
          [uid(), p.id, insts[k].id, take]);
        insts[k].room -= take;
        left -= take;
      }
      if (insts[k].room <= 0) k++;
    }
    // ما بقي من الدفعة بلا توزيع فائضٌ يظهر في «رد الفائض» · والدفعة التي لم يبقَ لها مكان
    // تبقى على قسطها المباشر، والقسط ممتلئ فيحدّه السقف ويُحسب الزائد فائضاً
  }
}

/* ═══════════ الخصومات بلا سطر في الدفتر ═══════════ */

export interface UnbookedDiscount {
  paymentId: string;
  contractId: string;
  contractNo: string;
  tenant: string;
  date: string;
  installmentId: string | null;
  due: string | null;
  received: number;
  discount: number;
  entryNo: string | null;
}

export interface UnbookedReport {
  /** خصومات لا سطر لها في الدفتر يقيناً */
  items: UnbookedDiscount[];
  /** عقود في دفترها خصم أقل من خصوم صفوفها، ولا يحدد الدفتر أي الدفعات بلا سطر */
  ambiguous: { contractId: string; contractNo: string; tenant: string; gap: number; candidates: UnbookedDiscount[] }[];
}

/** دفعة بلا نوع خصم، وفيها خصم، ولا سطر 4900 في قيدها ولا قيد خصم مربوط بها */
const CANDIDATES = `
  SELECT p.id AS paymentId, p.contract_id AS contractId, c.contract_no, c.tenant_name, p.date,
         p.installment_id AS installmentId, i.due_date AS due, p.net_halalas AS received, p.discount_halalas AS discount, e.no AS entryNo
  FROM contract_payments p
  LEFT JOIN contracts c ON c.id = p.contract_id
  LEFT JOIN contract_installments i ON i.id = p.installment_id
  LEFT JOIN journal_entries e ON e.id = p.journal_entry_id
  WHERE p.discount_kind IS NULL AND p.discount_halalas > 0 AND p.cancelled_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = p.journal_entry_id AND l.account_code = '${DISCOUNT_ACCOUNT}')
    AND NOT EXISTS (SELECT 1 FROM journal_entries d WHERE d.src_type = '${DISCOUNT_ENTRY_SRC}' AND d.src_id = p.id)
  ORDER BY c.tenant_name, p.date, p.created_at`;

export function unbookedDiscounts(db: DB): UnbookedReport {
  const rows = db.all<{
    paymentId: string; contractId: string; contract_no: string | null; tenant_name: string | null; date: string;
    installmentId: string | null; due: string | null; received: number; discount: number; entryNo: string | null;
  }>(CANDIDATES);
  const byContract = new Map<string, UnbookedDiscount[]>();
  for (const r of rows) {
    const item: UnbookedDiscount = {
      paymentId: r.paymentId, contractId: r.contractId, ...label(r), date: r.date,
      installmentId: r.installmentId, due: r.due, received: Number(r.received), discount: Number(r.discount), entryNo: r.entryNo,
    };
    const list = byContract.get(r.contractId) ?? [];
    list.push(item);
    byContract.set(r.contractId, list);
  }
  const report: UnbookedReport = { items: [], ambiguous: [] };
  for (const [cid, list] of byContract) {
    // خصم العقد في قيود الخصم المربوطة بأقساطه (قيود ما قبل التطبيق)
    const linked = Number(db.get<{ s: number }>(
      `SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas), 0) AS s
       FROM contract_installments i
       JOIN journal_entries e ON e.src_type = '${DISCOUNT_ENTRY_SRC}' AND e.src_id = i.id AND e.status = 'مرحّل' AND e.reversed_by IS NULL
       JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '${DISCOUNT_ACCOUNT}'
       WHERE i.contract_id = ?`, [cid])!.s);
    const total = list.reduce((s, x) => s + x.discount, 0);
    if (linked === 0) report.items.push(...list);
    else if (linked < total) report.ambiguous.push({ contractId: cid, contractNo: list[0].contractNo, tenant: list[0].tenant, gap: total - linked, candidates: list });
    // وما غطّته قيود الخصم المربوطة بالأقساط كاملاً فليس بلا سطر
  }
  return report;
}

/**
 * تحديد نوع خصمٍ بلا سطر في الدفتر · بأمر المستخدم لكل دفعة:
 *  «بعد الاستحقاق»: قيد جديد بتاريخ الدفعة مربوط بها (مدين 4900 · دائن الإيراد) ثم يُحفظ النوع مع الدفعة.
 *  «تنزيل من القسط»: يُحفظ النوع ثم يُخفَّض القسط بالخصم · ولا قيد، فالإيراد سُجّل بالمقبوض أصلاً.
 * لا يُعدَّل قيد قائم، وكل واحد في سجل العمليات · ويُرفض إن تجاوز سقف القسط.
 */
export function bookDiscount(db: DB, paymentId: string, kind: DiscountKind): void {
  const p = db.get<{
    id: string; contract_id: string; installment_id: string | null; date: string; discount: number;
    contract_no: string | null; tenant_name: string | null;
  }>(
    `SELECT p.id, p.contract_id, p.installment_id, p.date, p.discount_halalas AS discount, c.contract_no, c.tenant_name
     FROM (${CANDIDATES}) x JOIN contract_payments p ON p.id = x.paymentId
     LEFT JOIN contracts c ON c.id = p.contract_id
     WHERE p.id = ?`, [paymentId]);
  if (!p) throw new Error('الدفعة ليست خصماً بلا سطر في الدفتر · ربما حُدّد نوعه من قبل');
  const who = label(p);
  const amount = Number(p.discount);
  db.transaction(() => {
    if (kind === DISCOUNT_AFTER_DUE) {
      const entry = postBookedDiscount(db, {
        paymentId: p.id, tenant: who.tenant, contractNo: who.contractNo, amount, date: p.date, paymentDate: p.date,
      });
      db.run(`UPDATE contract_payments SET discount_kind = ? WHERE id = ?`, [DISCOUNT_AFTER_DUE, p.id]);
      logAudit(db, 'التحصيل', 'update', 'خصم بعد الاستحقاق بأثر رجعي',
        `${who.tenant} · ${who.contractNo} · دفعة ${p.date}: ${fmt(amount)} · قيد ${entry?.no ?? ''}`,
        { discount_kind: null }, { discount_kind: DISCOUNT_AFTER_DUE, journal_no: entry?.no ?? null });
    } else if (kind === DISCOUNT_REDUCES_INSTALLMENT) {
      if (!p.installment_id) throw new Error('التنزيل من قيمة القسط يحتاج دفعة على قسط محدد');
      const before = Number(db.get<{ a: number }>(`SELECT amount_halalas AS a FROM contract_installments WHERE id = ?`, [p.installment_id])!.a);
      // النوع أولاً: فيخرج الخصم من عدّه المؤقت قبل أن ينزل من مبلغ القسط · فلا يُعدّ مرتين
      db.run(`UPDATE contract_payments SET discount_kind = ? WHERE id = ?`, [DISCOUNT_REDUCES_INSTALLMENT, p.id]);
      db.run(`UPDATE contract_installments SET amount_halalas = ? WHERE id = ?`, [before - amount, p.installment_id]);
      logAudit(db, 'التحصيل', 'update', 'تنزيل من قيمة القسط بأثر رجعي',
        `${who.tenant} · ${who.contractNo} · دفعة ${p.date}: ${fmt(amount)} · يخالف قيمة العقد الموثّقة في منصة إيجار`,
        { amount_halalas: before, discount_kind: null }, { amount_halalas: before - amount, discount_kind: DISCOUNT_REDUCES_INSTALLMENT });
    } else {
      throw new Error('نوع خصم غير معروف');
    }
    // السقف بعد التحديد · خصم لم يكن يُعدّ (في عقد له قيود خصم أخرى) قد يتجاوزه فيُرفض كله
    if (p.installment_id) {
      const over = db.get<{ o: number }>(
        `SELECT i.paid_halalas + ${INSTALLMENT_DISCOUNT_SQL} - i.amount_halalas AS o FROM contract_installments i WHERE i.id = ?`,
        [p.installment_id]);
      if (over && Number(over.o) > 0) throw new Error(`الخصم يتجاوز المتبقي على القسط بـ${fmt(Number(over.o))} · لم يُسجَّل`);
    }
  });
}

/* ═══════════ الفائض عن الأقساط ═══════════ */

/** مصدر قيدَي تسوية الفائض · مربوطان بالعقد */
export const SURPLUS_REFUND_SRC = 'surplus_refund';
export const SURPLUS_CREDIT_SRC = 'surplus_credit';

export interface ContractSurplus {
  contractId: string;
  contractNo: string;
  tenant: string;
  tenantId: string | null;
  /** النقد المنسوب للأقساط الحيّة في الدفتر */
  cash: number;
  /** مجموع مسدَّد الأقساط الحيّة */
  paid: number;
  /** ما سُوّي منه قبلُ بردّ أو رصيد */
  settled: number;
  /** الفائض الباقي = النقد ناقص المسدَّد ناقص ما سُوّي */
  amount: number;
}

/**
 * عقود في دفترها نقد من دفعاتها أكثر مما سُدّد على أقساطها الحيّة، بعد ما سُوّي منه ·
 * والعقد الذي يتجاوز سقف قسطه يُعرض في التصحيح أولاً (وفائضه فيه) لا هنا.
 */
export function contractSurpluses(db: DB): ContractSurplus[] {
  // ما يصحّحه الدفتر يُعرض في التصحيح أولاً · وما لا يحسمه (دفعةٌ تجاوزت قسطها والعقد لم يُغطَّ كله) فائضٌ هنا
  const breach = new Set(planLedgerRepair(db).changes.map((c) => c.contractId));
  const rows = db.all<{
    id: string; contract_no: string | null; tenant_name: string | null; tenant_id: string | null;
    cash: number; live_paid: number; dead_paid: number; settled: number;
  }>(
    `SELECT c.id, c.contract_no, c.tenant_name, c.tenant_id,
            /* تشمل الملغاة: قيودها معكوسة فيستبعدها reversed_by */
            COALESCE((SELECT SUM(CASE WHEN l.account_code IN ('4200', '${DISCOUNT_ACCOUNT}') THEN l.credit_halalas - l.debit_halalas ELSE 0 END)
                      FROM contract_payments p
                      JOIN journal_entries e ON e.id = p.journal_entry_id AND e.status = 'مرحّل' AND e.reversed_by IS NULL
                      JOIN journal_lines l ON l.entry_id = e.id
                      WHERE p.contract_id = c.id), 0) AS cash,
            COALESCE((SELECT SUM(paid_halalas) FROM contract_installments WHERE contract_id = c.id AND status != 'ملغية'), 0) AS live_paid,
            COALESCE((SELECT SUM(paid_halalas) FROM contract_installments WHERE contract_id = c.id AND status = 'ملغية'), 0) AS dead_paid,
            COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                      FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4200'
                      WHERE e.src_type IN ('${SURPLUS_REFUND_SRC}', '${SURPLUS_CREDIT_SRC}') AND e.src_id = c.id
                        AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0) AS settled
     FROM contracts c
     WHERE c.deleted_at IS NULL AND EXISTS (SELECT 1 FROM contract_payments p WHERE p.contract_id = c.id)
     ORDER BY c.tenant_name, c.contract_no`);
  const out: ContractSurplus[] = [];
  for (const r of rows) {
    if (breach.has(r.id)) continue;
    const cash = Number(r.cash) - Number(r.dead_paid);
    const paid = Number(r.live_paid);
    const settled = Number(r.settled);
    const amount = cash - paid - settled;
    if (amount > 0) {
      out.push({ contractId: r.id, ...label(r), tenantId: r.tenant_id, cash, paid, settled, amount });
    }
  }
  return out;
}

export interface SettleSurplusInput {
  /** ردّ للمستأجر، أو تحويله رصيداً دائناً له */
  action: 'refund' | 'credit';
  amountHalalas: number;
  date: string;
  /** طريقة الردّ · نقداً من المحفظة أو تحويلاً من حساب بنكي */
  method?: 'cash' | 'bank';
  bankId?: string;
  notes?: string;
}

/**
 * تسوية الفائض بأمر المستخدم · قيد جديد بتاريخ التنفيذ مربوط بالعقد:
 *  ردّ:   مدين الإيراد 4200 (ما قُبض فوق الأقساط سُجّل إيراداً يوم قبضه ولا قسط يقابله، فيُنقَص منه ما رُدّ)
 *         دائن النقدية والبنوك 1100 (النقد الخارج للمستأجر) · وحركة بنكية سالبة إن كان تحويلاً.
 *  رصيد:  مدين الإيراد 4200 · دائن أرصدة مستأجرين دائنة 2410 (التزام للمستأجر حتى يُستعمل أو يُردّ)،
 *         ويزيد رصيد المستأجر الدائن بالمبلغ نفسه.
 */
export function settleSurplus(db: DB, contractId: string, input: SettleSurplusInput): PostedEntry {
  const s = contractSurpluses(db).find((x) => x.contractId === contractId);
  if (!s) throw new Error('لا فائض على هذا العقد');
  const amount = Math.round(Number(input.amountHalalas) || 0);
  if (amount <= 0) throw new Error('أدخل مبلغاً أكبر من صفر');
  if (amount > s.amount) throw new Error(`المبلغ (${fmt(amount)}) أكبر من الفائض (${fmt(s.amount)})`);
  if (!input.date) throw new Error('حدّد تاريخ التنفيذ');
  const refund = input.action === 'refund';
  if (refund && input.method !== 'cash' && input.method !== 'bank') throw new Error('حدّد طريقة الردّ: نقداً أو تحويلاً بنكياً');
  if (refund && input.method === 'bank' && !input.bankId) throw new Error('اختر الحساب البنكي الذي خرج منه التحويل');
  if (refund && input.method === 'cash') {
    const w = walletCashBalance(db);
    if (amount > w) throw new Error('رصيد المحفظة النقدية ' + fmt(w) + ' لا يكفي لردّ ' + fmt(amount));
  }
  const bank = refund && input.method === 'bank'
    ? db.get<{ name: string }>(`SELECT name FROM banks WHERE id = ? AND deleted_at IS NULL`, [input.bankId!])
    : null;
  if (refund && input.method === 'bank' && !bank) throw new Error('الحساب البنكي غير موجود');
  const who = s.tenant + ' (عقد ' + s.contractNo + ')';
  return db.transaction(() => {
    const entry = postEntry(db, {
      date: input.date,
      memo: (refund ? 'ردّ فائض للمستأجر · ' : 'تحويل فائض رصيداً دائناً · ') + who
        + (refund ? ' · ' + (input.method === 'bank' ? 'تحويل من ' + bank!.name : 'نقداً') : '')
        + (input.notes?.trim() ? ' · ' + input.notes.trim() : ''),
      lines: refund
        ? [
            { account: '4200', descr: 'ردّ ما قُبض فوق الأقساط', debit: amount, credit: 0 },
            { account: '1100', descr: input.method === 'bank' ? 'تحويل للمستأجر' : 'نقد للمستأجر', debit: 0, credit: amount },
          ]
        : [
            { account: '4200', descr: 'ما قُبض فوق الأقساط', debit: amount, credit: 0 },
            { account: '2410', descr: 'رصيد دائن للمستأجر', debit: 0, credit: amount },
          ],
      srcType: refund ? SURPLUS_REFUND_SRC : SURPLUS_CREDIT_SRC,
      srcId: contractId,
    })!;
    if (refund && input.method === 'bank') {
      db.run(
        `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
         VALUES (?,?,?,?,?,1,?,?,?)`,
        [uid(), input.bankId!, input.date, 'ردّ فائض للمستأجر · ' + who, -amount, entry.no, 'ردّ فائض للمستأجر', new Date().toISOString()]);
    }
    if (!refund && s.tenantId) {
      db.run(`UPDATE tenants SET credit_halalas = credit_halalas + ? WHERE id = ?`, [amount, s.tenantId]);
    }
    logAudit(db, 'التحصيل', 'create', refund ? 'ردّ فائض للمستأجر' : 'تحويل فائض رصيداً دائناً',
      `${who}: ${fmt(amount)} · قيد ${entry.no}` + (refund ? ' · ' + (input.method === 'bank' ? 'تحويل' : 'نقداً') : ''),
      { surplus_halalas: s.amount }, { surplus_halalas: s.amount - amount, journal_no: entry.no });
    return entry;
  });
}
