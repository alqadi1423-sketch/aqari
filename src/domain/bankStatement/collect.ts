/**
 * كشف البنك · مطابقة الإيداع بالتحصيل (قرار المالك 2026-10-09 «أولاً» ج.١ وج.٢ وج.٥ وج.٧ · DESIGN §١٣.٢٢): لكل إيداعٍ مفتوح لا حركة له
 * في الدفاتر (لا يقترح له matchSuggestions شيئاً) اقتراحٌ مقابل قسطٍ مستحق، أو أقساطٍ متتالية لعقدٍ واحد بتحويلٍ واحد، أو مطالبةٍ مفتوحة،
 * أو فاتورةٍ مستحقة، بدرجة ثقةٍ وسبب · والاعتماد بموافقة المستخدم يسجّل التحصيل بمساره المعتاد (recordRentPayment وrecordBulkRentPayment
 * وcollectClaim وpayInvoice) في بنك الكشف بتاريخ السطر، ثم يطابق السطر بحركة التحصيل، وكل اعتمادٍ سطرٌ في سجل العمليات · والمجمَّع من
 * منصة إيجار لعدة مستأجرين ينتظر طريقة «عبر إيجار» وحساب «قيد التحويل» (القسم ٥ · ٤) فلا يُقترح هنا.
 */
import type { DB } from '../../db/adapter';
import { t } from '../../i18n';
import { logAudit } from '../audit';
import { periodLabel } from '../dates';
import { RuleViolation, recordRentPayment, recordBulkRentPayment } from '../contracts/service';
import { INSTALLMENT_DISCOUNT_SQL, installmentRemaining, COLLECTIBLE_INSTALLMENT_SQL } from '../contracts/installments';
import { collectClaim } from '../claims';
import { payInvoice, invoiceRemaining, isCreditNote } from '../invoices';
import { foldText } from './normalize';
import { approveMatch, matchSuggestions, type LineView } from './store';

export type CollectTarget =
  | { kind: 'installments'; contractId: string; installmentIds: string[] }
  | { kind: 'claim'; claimId: string }
  | { kind: 'invoice'; invoiceId: string };

export interface CollectSuggestion {
  line: LineView;
  target: CollectTarget;
  /** من يُحصَّل منه وما يُحصَّل (اسم المستأجر ورقم العقد والفترة، أو سبب المطالبة، أو رقم الفاتورة وعميلها) */
  label: string;
  score: number;
  level: 'ready' | 'review';
  reasons: string[];
}

const dayNo = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;
const days = (a: string, b: string) => Math.abs(dayNo(a) - dayNo(b));
/** كلمات الاسم (ثلاثة أحرفٍ فأكثر، بلا «المصطنع» وأمثاله من الأوصاف الشائعة) مطبَّعة */
const nameWords = (s: string) => foldText(s).split(' ').filter((w) => w.length >= 3);
const sharesName = (descr: string, name: string) => {
  const d = new Set(foldText(descr).split(' '));
  return nameWords(name).some((w) => d.has(w) || d.has('ال' + w) || (w.startsWith('ال') && d.has(w.slice(2)))); // i18n-exempt: «ال» التعريف للمقارنة
};
const sharesNumber = (descr: string, ...refs: string[]) => {
  const d = new Set(descr.match(/\d{4,}/g) ?? []);
  return refs.some((r) => (r.match(/\d{4,}/g) ?? []).some((x) => d.has(x)));
};
/** قرب التاريخ من الاستحقاق (أو تاريخ المطالبة والفاتورة) */
const dateScore = (n: number) => (n <= 3 ? 20 : n <= 7 ? 15 : n <= 15 ? 10 : n <= 31 ? 5 : 0);
const MAX_RUN = 12;

interface Cand { lineId: string; target: CollectTarget; key: string; label: string; score: number; reasons: string[] }

export function collectionSuggestions(db: DB, bankId: string): CollectSuggestion[] {
  // الإيداع المفتوح الذي ليس له حركةٌ مرشَّحة في الدفاتر (تلك تُطابَق بحركتها لا بتحصيلٍ جديد)
  const withTx = new Set(matchSuggestions(db, bankId).map((s) => s.line.id));
  const lines = db.all<{ id: string; date: string; descr: string; ref: string | null; amount: number }>(
    `SELECT id, date, descr, ref, amount_halalas AS amount FROM bank_statement_lines
     WHERE bank_id = ? AND status = 'open' AND deleted_at IS NULL AND amount_halalas > 0 ORDER BY date, rowid`, [bankId])
    .filter((l) => !withTx.has(l.id));
  if (!lines.length) return [];

  // الأقساط القائمة بمتبقّيها، لكل عقدٍ بترتيب استحقاقها
  const insts = db.all<{ id: string; contract_id: string; due: string; sort: number; amount: number; paid: number; discount: number; tenant: string; no: string; ejar: string }>(
    `SELECT i.id, i.contract_id, i.due_date AS due, i.sort, i.amount_halalas AS amount, i.paid_halalas AS paid, ${INSTALLMENT_DISCOUNT_SQL} AS discount,
       c.tenant_name AS tenant, COALESCE(c.contract_no, '') AS no, COALESCE(c.ejar_no, '') AS ejar
     FROM contract_installments i JOIN contracts c ON c.id = i.contract_id
     WHERE ${COLLECTIBLE_INSTALLMENT_SQL} ORDER BY i.contract_id, i.due_date, i.sort, i.id`)
    .map((i) => ({ ...i, left: installmentRemaining(i.amount, i.paid, i.discount) }))
    .filter((i) => i.left > 0);
  const byContract = new Map<string, typeof insts>();
  for (const i of insts) byContract.set(i.contract_id, [...(byContract.get(i.contract_id) ?? []), i]);
  const claims = db.all<{ id: string; amount: number; reason: string; date: string; tenant: string | null; no: string | null }>(
    // i18n-exempt: حالة المطالبة المخزّنة
    `SELECT cl.id, cl.amount_halalas AS amount, cl.reason, cl.date, c.tenant_name AS tenant, c.contract_no AS no
     FROM claims cl LEFT JOIN contracts c ON c.id = cl.contract_id WHERE cl.status = 'مفتوحة' AND cl.deleted_at IS NULL`);
  const invoices = db.all<{ id: string; no: string; customer: string; total: number; due: string | null; issue: string }>(
    // i18n-exempt: حالة الفاتورة المخزّنة
    `SELECT id, COALESCE(no, '') AS no, customer_name AS customer, total_halalas AS total, due, issue FROM invoices
     WHERE deleted_at IS NULL AND status IN ('مستحقة', 'متأخرة') AND journal_entry_id IS NOT NULL`)
    .filter((v) => !isCreditNote(db, v.id))
    .map((v) => ({ ...v, left: invoiceRemaining(db, v.id, Number(v.total)) }))
    .filter((v) => v.left > 0);

  const cands: Cand[] = [];
  for (const l of lines) {
    const amount = Number(l.amount);
    const text = l.descr + ' ' + (l.ref ?? '');
    for (const [contractId, list] of byContract) {
      // قسطٌ واحد بمتبقّيه، أو أقساطٌ متتالية من أقدم القائم بمجموع متبقّيها (ج.٢: تحويلٌ واحد لعدة أقساط)
      for (let s = 0; s < list.length; s++) {
        let sum = 0;
        for (let e = s; e < Math.min(list.length, s + MAX_RUN); e++) {
          sum += list[e].left;
          if (sum > amount) break;
          if (sum !== amount) continue;
          const run = list.slice(s, e + 1);
          const several = run.length > 1;
          // والمتتالية تبدأ بأقدم القائم: لا يُترك قسطٌ أقدم بلا سداد · والقسط الواحد أقدم القائم أو ما يستحق في أسبوع السطر
          const n = days(l.date, run[0].due);
          if ((several && s !== 0) || n > 45 || (!several && s !== 0 && n > 7)) break;
          const first = run[0];
          const reasons = ['amount', 'date'];
          let score = (several ? 45 : 50) + dateScore(n);
          if (several) reasons.push('several');
          if (sharesName(text, first.tenant)) { score += 20; reasons.push('name'); }
          if (sharesNumber(text, first.no, first.ejar)) { score += 15; reasons.push('ref'); }
          cands.push({
            lineId: l.id, target: { kind: 'installments', contractId, installmentIds: run.map((x) => x.id) }, key: 'i:' + run.map((x) => x.id).join(','),
            label: t('bankStatement.collect.installments', { tenant: first.tenant, no: first.no || '—', period: run.map((x) => periodLabel(x.due)).join(', ') }),
            score, reasons,
          });
          break;
        }
      }
    }
    for (const c of claims) {
      if (Number(c.amount) !== amount || dayNo(l.date) < dayNo(c.date) - 3) continue;
      const reasons = ['amount', 'date'];
      let score = 50 + (days(l.date, c.date) <= 60 ? 10 : 0);
      if (c.tenant && sharesName(text, c.tenant)) { score += 20; reasons.push('name'); }
      if (sharesNumber(text, c.no ?? '')) { score += 15; reasons.push('ref'); }
      cands.push({ lineId: l.id, target: { kind: 'claim', claimId: c.id }, key: 'c:' + c.id,
        label: t('bankStatement.collect.claim', { reason: c.reason || '—', tenant: c.tenant ?? '—' }), score, reasons });
    }
    for (const v of invoices) {
      if (v.left !== amount || dayNo(l.date) < dayNo(v.issue) - 3) continue;
      const reasons = ['amount', 'date'];
      let score = 50 + (days(l.date, v.due || v.issue) <= 31 ? 10 : 0);
      if (sharesName(text, v.customer)) { score += 20; reasons.push('name'); }
      if (sharesNumber(text, v.no)) { score += 15; reasons.push('ref'); }
      cands.push({ lineId: l.id, target: { kind: 'invoice', invoiceId: v.id }, key: 'v:' + v.id,
        label: t('bankStatement.collect.invoice', { no: v.no || '—', customer: v.customer }), score, reasons });
    }
  }

  // التوزيع بالأعلى أولاً كمطابقة الحركات (U٢٢): السطر لهدفٍ واحد، والهدف لسطرٍ واحد، والمتنازَع «تحتاج مراجعة»
  // (وأقساطٌ مشتركة بين اقتراحين لهدفين مختلفين لا تُعطى مرتين)
  const perLine = new Map<string, number>();
  const perKey = new Map<string, number>();
  for (const c of cands) { perLine.set(c.lineId, (perLine.get(c.lineId) ?? 0) + 1); perKey.set(c.key, (perKey.get(c.key) ?? 0) + 1); }
  cands.sort((a, b) => b.score - a.score);
  const usedLine = new Set<string>();
  const usedInst = new Set<string>();
  const usedKey = new Set<string>();
  const view = new Map(lines.map((l) => [l.id, { id: l.id, date: l.date, descr: l.descr, amount: Number(l.amount) }]));
  const out: CollectSuggestion[] = [];
  for (const c of cands) {
    const ids = c.target.kind === 'installments' ? c.target.installmentIds : [];
    if (usedLine.has(c.lineId) || usedKey.has(c.key) || ids.some((i) => usedInst.has(i))) continue;
    usedLine.add(c.lineId); usedKey.add(c.key); ids.forEach((i) => usedInst.add(i));
    let score = c.score;
    const reasons = [...c.reasons];
    const rival = cands.some((q) => q !== c && ((q.lineId === c.lineId && !usedKey.has(q.key)) || (q.key === c.key && !usedLine.has(q.lineId))) && q.score >= c.score - 5);
    if (rival) { score -= 15; reasons.push('ambiguous'); } else if (perLine.get(c.lineId) === 1 && perKey.get(c.key) === 1) { score += 5; reasons.push('unique'); }
    score = Math.min(100, score);
    if (score < 50) continue;
    out.push({ line: view.get(c.lineId)!, target: c.target, label: c.label, score, level: score >= 85 ? 'ready' : 'review', reasons });
  }
  return out.sort((a, b) => (a.line.date < b.line.date ? -1 : a.line.date > b.line.date ? 1 : 0));
}

/** اعتماد اقتراح التحصيل بموافقة المستخدم: التحصيل بمساره في بنك الكشف بتاريخ السطر ومبلغه، ثم المطابقة · كله أو لا شيء */
export function approveCollection(db: DB, lineId: string, target: CollectTarget): { txId: string } {
  const l = db.get<{ bank_id: string; status: string; amount: number; date: string; descr: string }>(
    `SELECT bank_id, status, amount_halalas AS amount, date, descr FROM bank_statement_lines WHERE id = ? AND deleted_at IS NULL`, [lineId]);
  if (!l || l.status !== 'open') throw new RuleViolation(t('bankStatement.lineNotOpen'));
  const amount = Number(l.amount);
  if (amount <= 0) throw new RuleViolation(t('bankStatement.collect.notDeposit'));
  const bankId = l.bank_id;
  const notes = t('bankStatement.collect.note', { descr: l.descr || '—', lng: 'ar' });
  return db.transaction(() => {
    let entryNo: string | null = null;
    let txId: string | null = null;
    if (target.kind === 'installments') {
      const rows = db.all<{ id: string; due: string; amount: number; paid: number; discount: number }>(
        `SELECT i.id, i.due_date AS due, i.amount_halalas AS amount, i.paid_halalas AS paid, ${INSTALLMENT_DISCOUNT_SQL} AS discount
         FROM contract_installments i WHERE i.contract_id = ? AND i.id IN (SELECT value FROM json_each(?))`,
        [target.contractId, JSON.stringify(target.installmentIds)]);
      const left = rows.reduce((s, r) => s + installmentRemaining(r.amount, r.paid, r.discount), 0);
      if (rows.length !== target.installmentIds.length || left !== amount) throw new RuleViolation(t('bankStatement.collect.amountDiffers'));
      const lines = [{ method: 'bank' as const, bankId, amountHalalas: amount }];
      const paymentId = rows.length === 1
        ? recordRentPayment(db, target.contractId, { installmentId: rows[0].id, period: periodLabel(rows[0].due), date: l.date, lines, discountHalalas: 0, notes })
        : recordBulkRentPayment(db, target.contractId, { installmentIds: target.installmentIds, date: l.date, lines, notes });
      entryNo = db.get<{ no: string }>(
        `SELECT e.no FROM journal_entries e WHERE e.id = (SELECT journal_entry_id FROM contract_payments WHERE id = ?)
         OR e.id = ? LIMIT 1`, [paymentId, paymentId])?.no ?? null;
    } else if (target.kind === 'claim') {
      const c = db.get<{ amount: number }>(`SELECT amount_halalas AS amount FROM claims WHERE id = ? AND status = 'مفتوحة' AND deleted_at IS NULL`, [target.claimId]); // i18n-exempt: حالة مخزّنة
      if (!c || Number(c.amount) !== amount) throw new RuleViolation(t('bankStatement.collect.amountDiffers'));
      txId = collectClaim(db, target.claimId, l.date, bankId);
    } else {
      if (invoiceRemaining(db, target.invoiceId) !== amount) throw new RuleViolation(t('bankStatement.collect.amountDiffers'));
      payInvoice(db, target.invoiceId, { method: 'bank', bankId, date: l.date });
      entryNo = db.get<{ no: string }>(
        `SELECT e.no FROM journal_entries e JOIN invoices v ON v.payment_journal_entry_id = e.id WHERE v.id = ?`, [target.invoiceId])?.no ?? null;
    }
    // حركة التحصيل في بنك الكشف بمبلغ السطر
    txId = txId ?? db.get<{ id: string }>(
      `SELECT id FROM bank_tx WHERE bank_id = ? AND journal_no = ? AND amount_halalas = ? AND deleted_at IS NULL ORDER BY rowid DESC LIMIT 1`,
      [bankId, entryNo ?? '', amount])?.id ?? null;
    if (!txId) throw new RuleViolation(t('bankStatement.txMissing'));
    approveMatch(db, lineId, txId);
    logAudit(db, t('bankStatement.auditModule', { lng: 'ar' }), 'create', t('bankStatement.collect.auditEntity', { lng: 'ar' }),
      t('bankStatement.collect.auditName', { kind: target.kind, descr: l.descr || lineId, lng: 'ar' }), undefined, { amount_halalas: amount, date: l.date });
    return { txId };
  });
}
