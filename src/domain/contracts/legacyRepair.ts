/**
 * إصلاح بيانات الأقساط القديمة · يجريه migrate() مرة عند العبور إلى الإصدار ١٩، في الترقية والاستعادة.
 *
 * النموذج القديم (قبل إقفال القسم ٣): نقد الدفعات يُوزَّع على الأقساط بترتيب الاستحقاق عبر
 * payment_allocations، والخصم يبقى على صف الدفعة وحده ولا يُطرح من القسط. فيلتقي قسطٌ مملوء نقداً
 * وخصمٌ منسوب إليه، ويرفضه فحص الاستعادة وتأبى المزامنة دفعاته.
 *
 * قرارات المالك (٢٠٢٦-١٠-٠٣) وتُطبَّق على ما يرفضه الفحص وحده، وما سواه لا يُمسّ:
 *  ١) خصم على دفعة غطّت قسطها نقداً كاملاً خطأ إدخال: يُحذف من صف الدفعة ويصير إجماليها صافيها.
 *  ٢) دفعة بلا خصم تتجاوز قسطها لأنها دفعت أكثر من قسط: تُحمل كالتحصيل الجماعي، بلا قسط واحد،
 *     وتوزيعها في payment_allocations كما هو.
 *  ٣) الخصم يُطرح من القسط: نقد العقد المخصَّص لأقساطه (مجموع المسدَّد) يُعاد توزيعه بترتيب
 *     الاستحقاق على سعة كل قسط = مبلغه ناقص خصمه، ويُعاد بناء توزيع الدفعات عليه.
 * لا يمسّ قيداً ولا سطراً ولا نقداً ولا رصيد مستأجر · وكل تغيير يُسجَّل في سجل العمليات بقيمه قبل وبعد.
 * عقدٌ لا يستقيم بهذه القواعد (خصم وحده أكبر من قسطه مثلاً) يبقى كما هو، وفحص الاستعادة يسمّيه.
 */
import type { DB } from '../../db/adapter';
import { INSTALLMENT_CAP_TRIGGERS, INSTALLMENT_CAP_TRIGGER_NAMES } from '../../db/schema';
import { logAudit } from '../audit';
import { uid } from '../ids';
import { INSTALLMENT_DISCOUNT_SQL, installmentStoredStatus } from './installments';

export const LEGACY_REPAIR_VERSION = 19;

export interface LegacyRepairReport {
  discountsVoided: number;
  paymentsDetached: number;
  contractsRespread: number;
  installmentsChanged: number;
  skipped: string[];
}

const MODULE = 'البيانات';
const KIND = 'إصلاح بيانات قديمة';
const sar = (h: number) => (h / 100).toFixed(2);

interface Inst { id: string; due_date: string; amount: number; paid: number; disc: number; status: string }

export function repairLegacyInstallments(db: DB): LegacyRepairReport {
  const report: LegacyRepairReport = { discountsVoided: 0, paymentsDetached: 0, contractsRespread: 0, installmentsChanged: 0, skipped: [] };
  // المحفّزات تحرس كل كتابة بمفردها، والإصلاح يمرّ بحالات وسيطة بين صحيحين · فتُرفع داخل
  // معاملة الهجرة وتُعاد بنصها نفسه، وإن فشل شيء رجعت المعاملة كلها ومعها المحفّزات
  for (const t of INSTALLMENT_CAP_TRIGGER_NAMES) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  try {
    voidCoveredDiscounts(db, report);
    detachSpanningPayments(db, report);
    respreadContracts(db, report);
  } finally {
    db.exec(INSTALLMENT_CAP_TRIGGERS);
  }
  return report;
}

/** ١) خصم على قسط غطّاه صافي الدفعة نفسها كاملاً */
function voidCoveredDiscounts(db: DB, report: LegacyRepairReport): void {
  const rows = db.all<{ id: string; gross: number; disc: number; net: number; amount: number; tenant: string | null; no: string | null; date: string }>(
    `SELECT p.id, p.gross_halalas gross, p.discount_halalas disc, p.net_halalas net, i.amount_halalas amount,
            c.tenant_name tenant, c.contract_no no, p.date
     FROM contract_payments p
     JOIN contract_installments i ON i.id = p.installment_id
     LEFT JOIN contracts c ON c.id = p.contract_id
     WHERE p.discount_halalas > 0 AND p.net_halalas >= i.amount_halalas`);
  for (const r of rows) {
    db.run(`UPDATE contract_payments SET discount_halalas = 0, gross_halalas = net_halalas WHERE id = ?`, [r.id]);
    logAudit(db, MODULE, 'update', KIND,
      `${r.tenant || 'بلا مستأجر'} · ${r.no || 'بلا رقم عقد'} · دفعة ${r.date}: حُذف خصم ${sar(r.disc)} (خطأ إدخال · الدفعة غطّت القسط نقداً)`,
      { gross_halalas: r.gross, discount_halalas: r.disc }, { gross_halalas: r.net, discount_halalas: 0 });
    report.discountsVoided++;
  }
}

/** ٢) دفعة بلا خصم أكبر من قسطها · دفعت أكثر من قسط، وتوزيعها محفوظ كاملاً */
function detachSpanningPayments(db: DB, report: LegacyRepairReport): void {
  const rows = db.all<{ id: string; inst: string; net: number; amount: number; alloc: number; tenant: string | null; no: string | null; date: string }>(
    `SELECT p.id, p.installment_id inst, p.net_halalas net, i.amount_halalas amount,
            COALESCE((SELECT SUM(a.amount_halalas) FROM payment_allocations a WHERE a.payment_id = p.id), 0) alloc,
            c.tenant_name tenant, c.contract_no no, p.date
     FROM contract_payments p
     JOIN contract_installments i ON i.id = p.installment_id
     LEFT JOIN contracts c ON c.id = p.contract_id
     WHERE p.discount_halalas = 0 AND p.net_halalas > i.amount_halalas`);
  for (const r of rows) {
    const label = `${r.tenant || 'بلا مستأجر'} · ${r.no || 'بلا رقم عقد'} · دفعة ${r.date}`;
    if (Number(r.alloc) !== Number(r.net)) { // بلا توزيع كامل يضيع ربطها بأقساطها
      report.skipped.push(`${label}: توزيعها على الأقساط ناقص`);
      continue;
    }
    db.run(`UPDATE contract_payments SET installment_id = NULL WHERE id = ?`, [r.id]);
    logAudit(db, MODULE, 'update', KIND,
      `${label}: ${sar(r.net)} عن أكثر من قسط · تُحمل كالتحصيل الجماعي وتوزيعها كما هو`,
      { installment_id: r.inst }, { installment_id: null });
    report.paymentsDetached++;
  }
}

/** ٣) عقود فيها قسط يتجاوزه مسدَّده مع خصمه · نقدها يُعاد توزيعه بعد طرح الخصوم */
function respreadContracts(db: DB, report: LegacyRepairReport): void {
  const contracts = db.all<{ id: string; tenant: string | null; no: string | null }>(
    `SELECT DISTINCT c.id, c.tenant_name tenant, c.contract_no no
     FROM contract_installments i JOIN contracts c ON c.id = i.contract_id
     WHERE i.status != 'ملغية' AND i.paid_halalas + ${INSTALLMENT_DISCOUNT_SQL} > i.amount_halalas`);
  for (const c of contracts) {
    const label = `${c.tenant || 'بلا مستأجر'} · ${c.no || 'بلا رقم عقد'}`;
    const insts = db.all<Inst>(
      `SELECT i.id, i.due_date, i.amount_halalas amount, i.paid_halalas paid, ${INSTALLMENT_DISCOUNT_SQL} disc, i.status
       FROM contract_installments i WHERE i.contract_id = ? AND i.status != 'ملغية' ORDER BY i.due_date, i.sort, i.id`, [c.id]);
    const tooBig = insts.find((i) => i.disc > i.amount);
    if (tooBig) { report.skipped.push(`${label} · ${tooBig.due_date}: الخصم وحده أكبر من القسط`); continue; }

    const cash = insts.reduce((s, i) => s + Number(i.paid), 0);
    let left = cash;
    const target = insts.map((i) => {
      const take = Math.min(Math.max(0, i.amount - i.disc), left);
      left -= take;
      return take;
    });
    if (left > 0) { report.skipped.push(`${label}: نقده (${sar(cash)}) يزيد على أقساطه بعد خصومها بـ${sar(left)}`); continue; }

    const changed: string[] = [];
    insts.forEach((i, k) => {
      const paid = target[k];
      if (paid === Number(i.paid)) return;
      const status = paid + Number(i.disc) > 0 ? installmentStoredStatus(i.amount, paid, i.disc)
        : (i.status === 'مدفوعة' || i.status === 'مدفوعة جزئياً' ? 'مستحقة' : i.status);
      db.run(`UPDATE contract_installments SET paid_halalas = ?, status = ? WHERE id = ?`, [paid, status, i.id]);
      changed.push(`${i.due_date}: ${sar(Number(i.paid))} ← ${sar(paid)}${i.disc ? ` (خصم ${sar(i.disc)})` : ''}`);
      report.installmentsChanged++;
    });
    rebuildAllocations(db, c.id, insts.map((i, k) => ({ id: i.id, paid: target[k] })), label, report);
    logAudit(db, MODULE, 'update', KIND,
      `${label}: نقد العقد ${sar(cash)} أُعيد توزيعه على أقساطه بعد طرح خصومها · ${changed.join(' · ')}`.slice(0, 1000));
    report.contractsRespread++;
  }
}

/**
 * توزيع الدفعات يتبع المسدَّد الجديد: صافي كل دفعة بترتيب تاريخها على الأقساط بترتيب استحقاقها ·
 * إن لم يطابق مجموعُ الصافي النقدَ المخصَّص يبقى التوزيع القديم ويُذكر، فلا يُخترع توزيع.
 */
function rebuildAllocations(db: DB, contractId: string, targets: { id: string; paid: number }[], label: string, report: LegacyRepairReport): void {
  const pays = db.all<{ id: string; net: number }>(
    `SELECT id, net_halalas net FROM contract_payments WHERE contract_id = ? ORDER BY date, created_at, id`, [contractId]);
  const total = pays.reduce((s, p) => s + Number(p.net), 0);
  const cash = targets.reduce((s, t) => s + t.paid, 0);
  if (total !== cash) { report.skipped.push(`${label}: توزيع الدفعات بقي كما هو (الصافي ${sar(total)} والمخصَّص ${sar(cash)})`); return; }
  db.run(`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM contract_payments WHERE contract_id = ?)`, [contractId]);
  let k = 0;
  let room = targets[0]?.paid ?? 0;
  for (const p of pays) {
    let left = Number(p.net);
    while (left > 0 && k < targets.length) {
      if (room === 0) { k++; room = targets[k]?.paid ?? 0; continue; }
      const take = Math.min(left, room);
      db.run(`INSERT INTO payment_allocations (id, payment_id, installment_id, amount_halalas) VALUES (?,?,?,?)`,
        [uid(), p.id, targets[k].id, take]);
      left -= take; room -= take;
    }
  }
}
