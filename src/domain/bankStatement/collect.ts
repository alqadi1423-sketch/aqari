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
import { deterministicId, withDeterministicIds } from '../ids';
import { withStatementLine } from '../accounting/post';
import { periodLabel } from '../dates';
import { isFiledDate } from '../vatFilings';
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
// صدور الأسماء المركّبة تُضمّ إلى ما بعدها، والوصلات لا تعرّف أحداً (المدقق الخارجي W٥: «عبد» وحدها كانت اسماً مشتركاً)
const NAME_PREFIX = new Set(['عبد', 'ابو', 'ام']); // i18n-exempt: صدور الأسماء المركّبة للمقارنة
const NAME_LINK = new Set(['بن', 'بنت', 'ابن', 'ال']); // i18n-exempt: وصلات الأسماء للمقارنة
// والكلمات العامة في أسماء المنشآت وبيانات الحوالات لا تعرّف الدافع (المدقق الخارجي V٦: «شركة» كانت اسماً مشتركاً)
const GENERIC = new Set([
  'شركه', 'مؤسسه', 'مكتب', 'مجموعه', 'مصنع', 'متجر', 'محل', 'مركز', 'تجاره', 'مقاولات', 'عقارات', 'العقاريه', 'التجاريه', 'حواله', 'وارده', 'تحويل', 'ايداع', // i18n-exempt: كلماتٌ عامة للمقارنة
  'company', 'co', 'est', 'establishment', 'ltd', 'llc', 'trading', 'group', 'transfer', 'from', 'deposit', 'incoming',
]);
const stripAl = (w: string) => (w.startsWith('ال') && w.length > 4 ? w.slice(2) : w); // i18n-exempt: «ال» التعريف للمقارنة
/** كلمات الاسم المميِّزة مطبَّعة: الصدر المركّب مع ما بعده كلمةً واحدة، وبلا الوصلات، و«ال» التعريف لا تفرّق */
function nameTokens(s: string): string[] {
  const words = foldText(s).split(' ').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // والمركّب مفصولاً أو موصولاً اسمٌ واحد: «عبد العزيز» و«عبدالعزيز»، و«عبد الله» و«عبدالله» (المدقق الخارجي H٢-٢)
    if (NAME_PREFIX.has(w) && i + 1 < words.length) { const n = words[++i]; out.push(w + (n.startsWith('ال') && n.length > 3 ? n.slice(2) : n)); continue; } // i18n-exempt: «ال» التعريف للمقارنة
    const pre = [...NAME_PREFIX].find((p0) => w.startsWith(p0 + 'ال') && w.length > p0.length + 3); // i18n-exempt: «ال» التعريف للمقارنة
    if (pre) { out.push(pre + w.slice(pre.length + 2)); continue; }
    if (NAME_LINK.has(w) || w.length < 3 || GENERIC.has(w) || GENERIC.has(stripAl(w)) || w.startsWith('لل')) continue; // i18n-exempt: «لل» حرف الجر مع التعريف
    out.push(stripAl(w));
  }
  return out;
}
// الاسم في البيان: أول اسمٍ مميِّز للمستأجر (اسمه الأول)، أو اسمان منه · والعائلة وحدها لا تكفي (يشترك فيها كثيرون) · named أدناه
// المرجع في البيان: رقم العقد أو إيجار أو الفاتورة كاملاً بحروفه وأرقامه (المدقق الخارجي W٤: السنة وحدها في «EJ-2026-001» كانت مرجعاً) · reffed أدناه
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
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
    // وما في ربعٍ قُدِّم إقراره لا يُسجَّل فيه تحصيل، فلا يُقترح (المدقق الخارجي W٦: كان «جاهزاً» يُرفض اعتماده فيوقف «اعتماد الجاهزة»)
    .filter((l) => !withTx.has(l.id) && !isFiledDate(db, l.date));
  if (!lines.length) return [];

  // الأقساط القائمة بمتبقّيها، لكل عقدٍ بترتيب استحقاقها
  const insts = db.all<{ id: string; contract_id: string; due: string; sort: number; amount: number; paid: number; discount: number; tenant: string; no: string; ejar: string }>(
    `SELECT i.id, i.contract_id, i.due_date AS due, i.sort, i.amount_halalas AS amount, i.paid_halalas AS paid, ${INSTALLMENT_DISCOUNT_SQL} AS discount,
       c.tenant_name AS tenant, COALESCE(c.contract_no, '') AS no, COALESCE(c.ejar_no, '') AS ejar
     FROM contract_installments i JOIN contracts c ON c.id = i.contract_id
     WHERE ${COLLECTIBLE_INSTALLMENT_SQL} ORDER BY i.contract_id, i.due_date, i.sort, i.id`)
    .map((i) => ({ ...i, left: installmentRemaining(i.amount, i.paid, i.discount) }))
    .filter((i) => i.left > 0);
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

  // فهارس بالمبلغ مرتبةٌ باليوم، ويوم كل سطرٍ وقسطٍ ورموز كل اسمٍ ومرجع تُحسب مرةً واحدة، والتسمية للمعروض وحده (المدقق الخارجي V١٠: كان
  // تربيعياً يمرّ على كل قسطٍ لكل عقدٍ لكل إيداع)
  // والهدف ومفتاحه وتسميته تُبنى مرةً للقالب لا لكل مرشح (X٧)
  type Tpl = { day: number; last: number; s: number; several: boolean; contractId: string; run: typeof insts; tenant: string[]; refs: string[]; target: CollectTarget; key: string; label: () => string };
  // (والمجموعات تُبنى بالإضافة لا بنسخ المصفوفة · X٧)
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  const byContract = new Map<string, typeof insts>();
  for (const i of insts) push(byContract, i.contract_id, i);
  // أقدم القائم والمتتالية منه بنافذة ٤٥ يوماً، وما بعده بنافذة أسبوعٍ وحدها (المدقق الخارجي X٧: كانت النافذة الواسعة تمرّ على كل قسط)
  const oldestBy = new Map<number, Tpl[]>();
  const laterBy = new Map<number, Tpl[]>();
  // والمتتالية بمداها: من ٤٥ يوماً قبل أقدمها (سدادٌ مقدَّم) إلى ٤٥ بعد آخرها (سداد المتأخرات · المدقق الخارجي D٢-١١: كانت بنافذة أقدمها
  // وحده فلا يُقترح تحويلٌ واحد بأقساط أغسطس وسبتمبر وأكتوبر في أكتوبر)
  const runsBy = new Map<number, Tpl[]>();
  const addTpl = (amount: number, t0: Tpl) => push(t0.several ? runsBy : t0.s === 0 ? oldestBy : laterBy, amount, t0);
  for (const [contractId, list] of byContract) {
    const tenant = nameTokens(list[0].tenant);
    const refs = [list[0].no, list[0].ejar].map(compact).filter((c) => c.length >= 5 && /\d/.test(c));
    // قسطٌ واحد بمتبقّيه، أو أقساطٌ متتالية من أقدم القائم بمجموع متبقّيها (ج.٢: تحويلٌ واحد لعدة أقساط)
    const tpl = (run: typeof insts, s0: number): Tpl => ({
      day: dayNo(run[0].due), last: dayNo(run[run.length - 1].due), s: s0, several: run.length > 1, contractId, run, tenant, refs,
      target: { kind: 'installments', contractId, installmentIds: run.map((x) => x.id) }, key: 'i:' + run.map((x) => x.id).join(','),
      label: () => t('bankStatement.collect.installments', { tenant: run[0].tenant, no: run[0].no || '—', period: run.map((x) => periodLabel(x.due)).join(', ') }),
    });
    list.forEach((x, s0) => addTpl(x.left, tpl([x], s0)));
    let sum = list[0].left;
    for (let e = 1; e < Math.min(list.length, MAX_RUN); e++) {
      sum += list[e].left;
      addTpl(sum, tpl(list.slice(0, e + 1), 0));
    }
  }
  for (const m of [oldestBy, laterBy, runsBy]) for (const l of m.values()) l.sort((p, q) => p.day - q.day);
  // أطول مدى متتاليةٍ بأيامها مع نافذتها، أياً كانت دورة العقد (المدقق الخارجي F٢-٨: كان ٤٠٠ يومٍ ثابتة للشهري)
  let RUN_SPAN = 45;
  for (const l of runsBy.values()) for (const r of l) RUN_SPAN = Math.max(RUN_SPAN, r.last - r.day + 45);
  // والمتتالية تبدأ بأقدم القائم: لا يُترك قسطٌ أقدم بلا سداد · والقسط الواحد أقدم القائم أو ما يستحق في أسبوع السطر
  const WINDOWS: Array<[Map<number, Tpl[]>, number]> = [[oldestBy, 45], [laterBy, 7]];
  // أسباب المرشح بحسب أعلامه (عدة أقساط، والاسم، والمرجع) مصفوفاتٌ مشتركة تُنسخ للمعروض وحده
  const REASONS = Array.from({ length: 8 }, (_, b) => ['amount', 'date', ...(b & 1 ? ['several'] : []), ...(b & 2 ? ['name'] : []), ...(b & 4 ? ['ref'] : [])]);
  const claimsBy = new Map<number, Array<(typeof claims)[number] & { day: number; who: string[]; refs: string[] }>>();
  for (const c of claims) push(claimsBy, Number(c.amount), { ...c, day: dayNo(c.date), who: nameTokens(c.tenant ?? ''), refs: [compact(c.no ?? '')].filter((x) => x.length >= 5 && /\d/.test(x)) });
  const invBy = new Map<number, Array<(typeof invoices)[number] & { day: number; dueDay: number; who: string[]; refs: string[] }>>();
  for (const v of invoices) push(invBy, v.left, { ...v, day: dayNo(v.issue), dueDay: dayNo(v.due || v.issue), who: nameTokens(v.customer), refs: [compact(v.no)].filter((x) => x.length >= 5 && /\d/.test(x)) });
  // ومن حمل البيان اسمه كاملاً (اسمان منه فأكثر) هو الدافع: من وافق اسمُه الأول كلمةً منه وحدها لا يأخذ درجة الاسم (المدقق الخارجي D٢-٢:
  // «محمد فهد القحطاني» يحوّل، و«فهد» اسم مستأجرٍ آخر الأول)
  const parties = new Map<string, string[][]>();
  const addParty = (toks: string[]) => { if (toks.length >= 2) for (const w of new Set(toks)) push(parties, w, toks); };
  for (const list of byContract.values()) addParty(nameTokens(list[0].tenant));
  for (const c of claims) addParty(nameTokens(c.tenant ?? ''));
  for (const v of invoices) addParty(nameTokens(v.customer));
  // (بالكلمات المختلفة: الجدّ السميّ لا يُعدّ مرتين · المدقق الخارجي H٢-١)
  const hits = (d: Set<string>, n: string[]) => [...new Set(n)].filter((w) => d.has(w)).length;
  // وأقوى الأسماء الكاملة: ما فيه الاسم الأول بأكثر الكلمات، ثم ما بلا الاسم الأول بأكثرها (المدقق الخارجي F٢-٢: «سعد فهد القحطاني»
  // يوافق كلمتين من «محمد فهد القحطاني» بلا اسمه الأول، و«فهد سعد القحطاني» بكلمتين أقلّ من الدافع)
  const fullNames = (d: Set<string>): Set<string> => {
    const found = new Map<string, { first: boolean; n: number }>();
    for (const w of d) for (const toks of parties.get(w) ?? []) {
      const n = hits(d, toks);
      if (n >= 2) found.set(toks.join(' '), { first: d.has(toks[0]), n });
    }
    const pool = [...found.entries()].filter(([, v]) => v.first);
    const use = pool.length ? pool : [...found.entries()];
    const best = Math.max(0, ...use.map(([, v]) => v.n));
    return new Set(use.filter(([, v]) => v.n === best).map(([k]) => k));
  };
  const firstFrom = (list: Tpl[], day: number) => { let lo = 0; let hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].day < day) lo = m + 1; else hi = m; } return lo; };
  const named = (d: Set<string>, n: string[], full: Set<string>) => n.length > 0 && (full.size ? full.has(n.join(' ')) : d.has(n[0]));
  const reffed = (text: string, refs: string[]) => refs.some((r) => text.includes(r));

  type Cand2 = Omit<Cand, 'label'> & { label: () => string };
  const cands: Cand2[] = [];
  for (const l of lines) {
    const amount = Number(l.amount);
    const ld = dayNo(l.date);
    const words = new Set(nameTokens(l.descr + ' ' + (l.ref ?? '')));
    const text = compact(l.descr + ' ' + (l.ref ?? ''));
    const full = fullNames(words);
    const mine: Cand2[] = [];
    for (const [m, w] of WINDOWS) {
      const list = m.get(amount);
      if (!list) continue;
      for (let i = firstFrom(list, ld - w); i < list.length && list[i].day <= ld + w; i++) {
        const tp = list[i];
        const nm = tp.tenant.length > 0 && named(words, tp.tenant, full);
        const rf = tp.refs.length > 0 && reffed(text, tp.refs);
        const score = (tp.several ? 45 : 50) + dateScore(Math.abs(ld - tp.day)) + (nm ? 20 : 0) + (rf ? 15 : 0);
        mine.push({ lineId: l.id, target: tp.target, key: tp.key, label: tp.label, score, reasons: REASONS[(tp.several ? 1 : 0) | (nm ? 2 : 0) | (rf ? 4 : 0)] });
      }
    }
    const runs = runsBy.get(amount);
    for (let i = runs ? firstFrom(runs, ld - RUN_SPAN) : 0; runs && i < runs.length && runs[i].day <= ld + 45; i++) {
      const tp = runs[i];
      if (ld < tp.day - 45 || ld > tp.last + 45) continue;
      const nm = tp.tenant.length > 0 && named(words, tp.tenant, full);
      const rf = tp.refs.length > 0 && reffed(text, tp.refs);
      const gap = ld < tp.day ? tp.day - ld : ld > tp.last ? ld - tp.last : 0;
      const score = 45 + dateScore(gap) + (nm ? 20 : 0) + (rf ? 15 : 0);
      mine.push({ lineId: l.id, target: tp.target, key: tp.key, label: tp.label, score, reasons: REASONS[1 | (nm ? 2 : 0) | (rf ? 4 : 0)] });
    }
    for (const c of claimsBy.get(amount) ?? []) {
      if (ld < c.day - 3) continue;
      const reasons = ['amount', 'date'];
      let score = 50 + (Math.abs(ld - c.day) <= 60 ? 10 : 0);
      if (named(words, c.who, full)) { score += 20; reasons.push('name'); }
      if (reffed(text, c.refs)) { score += 15; reasons.push('ref'); }
      mine.push({ lineId: l.id, target: { kind: 'claim', claimId: c.id }, key: 'c:' + c.id,
        label: () => t('bankStatement.collect.claim', { reason: c.reason || '—', tenant: c.tenant ?? '—' }), score, reasons });
    }
    for (const v of invBy.get(amount) ?? []) {
      if (ld < v.day - 3) continue;
      const reasons = ['amount', 'date'];
      let score = 50 + (Math.abs(ld - v.dueDay) <= 31 ? 10 : 0);
      if (named(words, v.who, full)) { score += 20; reasons.push('name'); }
      if (reffed(text, v.refs)) { score += 15; reasons.push('ref'); }
      mine.push({ lineId: l.id, target: { kind: 'invoice', invoiceId: v.id }, key: 'v:' + v.id,
        label: () => t('bankStatement.collect.invoice', { no: v.no || '—', customer: v.customer }), score, reasons });
    }
    for (const c of mine) cands.push(c);
  }

  // التوزيع بالأعلى أولاً كمطابقة الحركات (U٢٢): السطر لهدفٍ واحد، والهدف لسطرٍ واحد، والمتنازَع «تحتاج مراجعة»
  // (وأقساطٌ مشتركة بين اقتراحين لهدفين مختلفين لا تُعطى مرتين)
  const perLine = new Map<string, Cand2[]>();
  const perKey = new Map<string, Cand2[]>();
  for (const c of cands) { push(perLine, c.lineId, c); push(perKey, c.key, c); }
  const desc = (a: Cand2, b: Cand2) => b.score - a.score;
  for (const g of perLine.values()) g.sort(desc);
  for (const g of perKey.values()) g.sort(desc);
  cands.sort(desc);
  const usedLine = new Set<string>();
  const usedInst = new Set<string>();
  const usedKey = new Set<string>();
  const rivalIn = (g: Cand2[], c: Cand2, free: (q: Cand2) => boolean) => {
    for (const q of g) { if (q.score < c.score - 5) return false; if (q !== c && free(q)) return true; }
    return false;
  };
  const view = new Map(lines.map((l) => [l.id, { id: l.id, date: l.date, descr: l.descr, amount: Number(l.amount) }]));
  const out: CollectSuggestion[] = [];
  for (const c of cands) {
    const ids = c.target.kind === 'installments' ? c.target.installmentIds : [];
    if (usedLine.has(c.lineId) || usedKey.has(c.key) || ids.some((i) => usedInst.has(i))) continue;
    usedLine.add(c.lineId); usedKey.add(c.key); ids.forEach((i) => usedInst.add(i));
    let score = c.score;
    const reasons = [...c.reasons];
    const rival = rivalIn(perLine.get(c.lineId)!, c, (q) => !usedKey.has(q.key)) || rivalIn(perKey.get(c.key)!, c, (q) => !usedLine.has(q.lineId));
    if (rival) { score -= 15; reasons.push('ambiguous'); } else if (perLine.get(c.lineId)!.length === 1 && perKey.get(c.key)!.length === 1) { score += 5; reasons.push('unique'); }
    score = Math.min(100, score);
    if (score < 50) continue;
    out.push({ line: view.get(c.lineId)!, target: c.target, label: c.label(), score, level: score >= 85 ? 'ready' : 'review', reasons });
  }
  return out.sort((a, b) => (a.line.date < b.line.date ? -1 : a.line.date > b.line.date ? 1 : 0));
}

/**
 * صلاحية تسجيل التحصيل لكل هدفٍ كما في شاشته وقاعدة السحابة (المدقق الخارجي W٢ · سجل القرارات ٥٩): القسط بـ«إدخال» في التحصيل،
 * والمطالبة والفاتورة بـ«كامل» في قسمهما (التحصيل يعدّل صفّهما) · ومعها البنوك ٣ للمطابقة
 */
export function collectPermission(x: CollectTarget): { section: 'collect' | 'claims' | 'invoices'; level: 2 | 3 } {
  return x.kind === 'installments' ? { section: 'collect', level: 2 } : { section: x.kind === 'claim' ? 'claims' : 'invoices', level: 3 };
}


const targetKey = (x: CollectTarget) => (x.kind === 'installments' ? 'i:' + x.contractId + ':' + x.installmentIds.join(',') : x.kind === 'claim' ? 'c:' + x.claimId : 'v:' + x.invoiceId);

/**
 * اعتماد اقتراح التحصيل بموافقة المستخدم: التحصيل بمساره في بنك الكشف بتاريخ السطر ومبلغه، ثم المطابقة · كله أو لا شيء · ومعرّفات ما
 * يكتبه (القيد وسطوره والدفعة وحركة البنك) حتميةٌ من السطر والهدف ورقم الاعتماد (المدقق الخارجي W١): جهازان يعتمدان الإيداع نفسه
 * للهدف نفسه بلا اتصال يكتبان الصفوف نفسها فتلتقي في المزامنة تحصيلاً واحداً · ورقم الاعتماد يزيد إن سبق للسطر تحصيلٌ أُلغي ثم أُعيد
 * فتحه، فلا يصطدم بقيد ذلك الإلغاء
 */
export function approveCollection(db: DB, lineId: string, target: CollectTarget): { txId: string } {
  // والقيد يحمل سطره (withStatementLine · الهجرة ٥٩): جهازان يعتمدان الإيداع نفسه لهدفين مختلفين يُقبل أولهما على جهاز المالك ويُرفض
  // الثاني، فلا يُسجَّل الإيداع الواحد تحصيلين في دفاتره (المدقق الخارجي Z٢-١)
  const base = 'stmt:' + lineId + ':' + targetKey(target);
  let attempt = 0;
  // والمعرّف محجوزٌ إن عرفه الجهاز قيداً أو وارداً ينتظر أو مرفوضاً (المدقق الخارجي Y٤: قيدٌ مزوَّر بمعرّف الاعتماد الأول كان يمنع رفع قيد المالك)
  const taken = (id: string) => !!db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [id])
    || !!db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ?`, [id])
    || !!db.get(`SELECT 1 FROM sync_rejects WHERE tbl = 'journal_entries' AND pk = ?`, [id]);
  while (taken(deterministicId(base + ':' + attempt, 1))) attempt++;
  return withDeterministicIds(base + ':' + attempt, () => withStatementLine(lineId, () => approveCollectionNow(db, lineId, target)));
}

function approveCollectionNow(db: DB, lineId: string, target: CollectTarget): { txId: string } {
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
      // والأقساط كلها قائمة الآن: الملغى بعد عرض الاقتراح لا يُتخطّى فيصير الباقي رصيداً دائناً للمستأجر (المدقق الخارجي W٣)
      const rows = db.all<{ id: string; due: string; amount: number; paid: number; discount: number }>(
        `SELECT i.id, i.due_date AS due, i.amount_halalas AS amount, i.paid_halalas AS paid, ${INSTALLMENT_DISCOUNT_SQL} AS discount
         FROM contract_installments i JOIN contracts c ON c.id = i.contract_id
         WHERE i.contract_id = ? AND i.id IN (SELECT value FROM json_each(?)) AND ${COLLECTIBLE_INSTALLMENT_SQL}`,
        [target.contractId, JSON.stringify(target.installmentIds)]);
      const left = rows.reduce((s, r) => s + installmentRemaining(r.amount, r.paid, r.discount), 0);
      if (rows.length !== new Set(target.installmentIds).size || rows.length !== target.installmentIds.length
        || rows.some((r) => installmentRemaining(r.amount, r.paid, r.discount) <= 0) || left !== amount) {
        throw new RuleViolation(t('bankStatement.collect.amountDiffers'));
      }
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
      // وفاتورةٌ حُصّلت (من جهازٍ آخر بعد عرض الاقتراح) لا يُعكس تحصيلها ليُعاد من الكشف (Z٢-٥)
      if (db.get(`SELECT 1 FROM invoices WHERE id = ? AND (payment_journal_entry_id IS NOT NULL OR status = 'مدفوعة')`, [target.invoiceId])) { // i18n-exempt: حالة الفاتورة المخزّنة
        throw new RuleViolation(t('bankStatement.collect.amountDiffers'));
      }
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
