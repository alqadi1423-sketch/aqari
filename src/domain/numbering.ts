import { t } from '../i18n';
/**
 * ترقيم المستندات بين الأجهزة (قرار المالك ٢٠٢٦-١٠-٠٥):
 *  - القيود والعقود والمشتريات: كتل أرقام يحجزها كل جهاز من عدّاد السحابة (meta/counters)، بلا لاحقة،
 *    والفجوات فيها مقبولة. يُعاد ملء الكتلة في المزامنة حين يبقى منها أقل من نصفها، فيعمل الجهاز بلا اتصال.
 *  - الفواتير الضريبية: بلا فجوات، رقمها من العدّاد لحظة إصدارها (invoices.ts و services/cloud.ts).
 *  - الأرقام الصادرة سابقاً بحرف جهاز تبقى كما هي، ولا يرى المستخدم حروف الأجهزة.
 * والكتل تخصّ التثبيت لا البيانات: تبقى مع المسح، ولا تأتي مع نسخة مستعادة (restore.ts).
 * وما لا كتلة له (جهاز بلا مزامنة، أو نفدت كتلته بلا اتصال) يُرقِّم كما كان: بحرفه القديم إن كان له حرف،
 * وإلا بعد أعلى رقم بلا لاحقة.
 */
import type { DB } from '../db/adapter';

/* ═══════════ الكتل ═══════════ */

export type Series = 'JE' | 'EJ' | 'PUR';
export const SERIES: Series[] = ['JE', 'EJ', 'PUR'];
/** حجم الكتلة · نصفها يكفي أياماً بلا اتصال (كل دفعة قيدٌ أو اثنان)، والفجوة عند إعادة التثبيت مقبولة */
export const BLOCK_SIZE: Record<Series, number> = { JE: 500, EJ: 50, PUR: 100 };
/** أول إنشاءٍ للعدّاد يبدأ بعد أعلى رقمٍ معروف بهذه الفجوة · فلا يصطدم بما كتبه جهازٌ بالترقيم القديم ولم يُرفع بعد */
export const FIRST_GAP: Record<Series, number> = { JE: 1000, EJ: 100, PUR: 100 };

const BLOCKS_KEY = 'number_blocks';
export interface Block { lo: number; hi: number; next: number }
export type Blocks = Partial<Record<Series, Block[]>>;

export function readBlocks(db: DB): Blocks {
  const v = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [BLOCKS_KEY])?.value;
  if (!v) return {};
  try { return JSON.parse(v) as Blocks; } catch { return {}; }
}

export function writeBlocks(db: DB, b: Blocks): void {
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [BLOCKS_KEY, JSON.stringify(b)]);
}

/** ما بقي في كتل السلسلة */
export function blockRemaining(db: DB, s: Series): number {
  return (readBlocks(db)[s] ?? []).reduce((n, b) => n + Math.max(0, b.hi - b.next + 1), 0);
}

/** الكتلة تحتاج ملئاً: بقي أقل من نصفها */
export function wantsBlock(db: DB, s: Series): boolean {
  return blockRemaining(db, s) < BLOCK_SIZE[s] / 2;
}

/** الرقم التالي من الكتل دون استهلاكه · للعرض قبل الحفظ */
export function peekNumber(db: DB, s: Series): number | null {
  const b = (readBlocks(db)[s] ?? []).find((x) => x.next <= x.hi);
  return b ? b.next : null;
}

/** يأخذ الرقم التالي من الكتل ويستهلكه · null إن لم تبق كتلة */
export function takeNumber(db: DB, s: Series): number | null {
  const all = readBlocks(db);
  const list = (all[s] ?? []).filter((x) => x.next <= x.hi);
  if (!list.length) return null;
  const n = list[0].next;
  list[0] = { ...list[0], next: n + 1 };
  all[s] = list.filter((x) => x.next <= x.hi);
  writeBlocks(db, all);
  return n;
}

export function addBlock(db: DB, s: Series, lo: number, hi: number): void {
  if (!(Number.isInteger(lo) && Number.isInteger(hi) && lo <= hi)) throw new Error('كتلة أرقام غير صالحة');
  const all = readBlocks(db);
  all[s] = [...(all[s] ?? []), { lo, hi, next: lo }].sort((a, b) => a.lo - b.lo);
  writeBlocks(db, all);
}

/** كتل جهازٍ واحد من قاعدتين (الحية وما بعد الاستعادة) · الأبعد استهلاكاً يغلب، فلا يُعاد رقمٌ أُخذ */
export function mergeBlocks(a: Blocks, b: Blocks): Blocks {
  const out: Blocks = {};
  for (const s of SERIES) {
    const byLo = new Map<number, Block>();
    for (const x of [...(a[s] ?? []), ...(b[s] ?? [])]) {
      const cur = byLo.get(x.lo);
      byLo.set(x.lo, cur ? { ...x, next: Math.max(cur.next, x.next) } : x);
    }
    const list = [...byLo.values()].filter((x) => x.next <= x.hi).sort((p, q) => p.lo - q.lo);
    if (list.length) out[s] = list;
  }
  return out;
}

/** أعلى رقمٍ بلا لاحقة في السلسلة على هذا الجهاز · يبدأ منه العدّاد أول مرة */
export function localMaxNumber(db: DB, s: Series | 'INV'): number {
  const q = (sql: string) => Number(db.get<{ mx: number }>(sql)?.mx ?? 0);
  const plain = (col: string) => `NOT (${col} GLOB '*-[A-Z]' OR ${col} GLOB '*-[A-Z][A-Z]')`;
  switch (s) {
    case 'JE': return q(`SELECT COALESCE(MAX(CAST(substr(no, 4) AS INTEGER)), 0) AS mx FROM journal_entries WHERE no GLOB 'JE-[0-9]*' AND ${plain('no')}`);
    case 'PUR': return q(`SELECT COALESCE(MAX(CAST(substr(no, 5) AS INTEGER)), 0) AS mx FROM purchases WHERE no GLOB 'PUR-[0-9]*' AND ${plain('no')}`);
    case 'EJ': return q(`SELECT COALESCE(MAX(CAST(substr(contract_no, 9) AS INTEGER)), 0) AS mx FROM contracts WHERE contract_no GLOB 'EJ-[0-9][0-9][0-9][0-9]-[0-9]*' AND ${plain('contract_no')}`);
    // الفاتورة: كل رقمٍ صدر بحرفٍ أو بدونه · فالتسلسل الجديد يكمل فوقها كلها بلا فجوة
    case 'INV': return q(`SELECT COALESCE(MAX(CAST(substr(no, 10) AS INTEGER)), 0) AS mx FROM invoices WHERE no GLOB 'INV-[0-9][0-9][0-9][0-9]-[0-9]*'`);
  }
}

export interface BlockRequest { series: Series; size: number; floor: number; gap: number }
export interface ReservedBlock { series: Series; lo: number; hi: number }

/**
 * حساب الحجز على العدّاد (آخر رقمٍ محجوز لكل سلسلة) · بعد أعلى ما فيه وما يعرفه الجهاز،
 * وأول إنشاءٍ للسلسلة بعد أرضيته بفجوة · يعيد العدّاد الجديد والكتل.
 */
export function planBlocks(
  cur: Record<string, number>, req: BlockRequest[], capped = false,
): { next: Record<string, number>; out: ReservedBlock[]; pending: BlockRequest[] } {
  const next: Record<string, number> = {};
  const out: ReservedBlock[] = [];
  const pending: BlockRequest[] = [];
  for (const r of req) {
    const have = Number.isInteger(cur[r.series]) ? cur[r.series] : null;
    const base = have === null ? r.floor + r.gap : Math.max(have, r.floor);
    // العضو لا يقفز فوق سقف القواعد (memberJump): أرضيته فوق العدّاد بأكثر من كتلة يتقدم العدّادُ خطوةً بالسقف بلا كتلة، ولا تُعطى
    // كتلةٌ قبل أن تتخطى أرضيته فلا يتكرر رقم (المتحقق المستقل: كانت القفزة تُرفض بلا نهاية)
    const cap = memberJumpCap(r.series, have === null);
    if (capped && base + r.size - (have ?? 0) > cap) {
      next[r.series] = (have ?? 0) + cap;
      pending.push(r);
      continue;
    }
    next[r.series] = base + r.size;
    out.push({ series: r.series, lo: base + 1, hi: base + r.size });
  }
  return { next, out, pending };
}

/** سقف قفزة العضو في العدّاد كما في القواعد (memberJump): حجم كتلة السلسلة، وأول إنشائها فجوتها وكتلتها */
export function memberJumpCap(s: Series, first: boolean): number {
  return first ? FIRST_GAP[s] + BLOCK_SIZE[s] : BLOCK_SIZE[s];
}
/** أقصى خطوات العضو حتى تتخطى كتلتُه أرضيتَه · وبعدها يزامن جهاز المالك أولاً */
export const MAX_COUNTER_STEPS = 40;
export class CounterBehindError extends Error {
  constructor() { super(t('numbering.counterBehind')); this.name = 'CounterBehindError'; }
}

/**
 * أول فاتورة ضريبية بعد التفعيل يصدرها المالك (قرار المالك 2026-10-09 على #55): العضو لا يُنشئ أول رقمٍ في العدّاد ·
 * ويُعرض له السبب صريحاً، وفاتورته تبقى مسودة
 */
export class FirstIssueByOwnerError extends Error {
  constructor() { super(t('invoice.firstIssueOwner')); this.name = 'FirstIssueByOwnerError'; }
}

/** رقم الفاتورة التالي على العدّاد · بعد أعلى ما فيه وما يعرفه الجهاز، بلا فجوة */
export function planInvoiceSeq(cur: Record<string, number>, floor: number): { next: Record<string, number>; out: number } {
  const have = Number.isInteger(cur.INV) ? cur.INV : 0;
  const n = Math.max(have, floor) + 1;
  return { next: { INV: n }, out: n };
}

/** حاجة هذا الجهاز من الكتل في المزامنة · السلسلة وحجمها وأرضيتها: أعلى رقمٍ يعرفه أو في كتله */
export function blockRequests(db: DB): BlockRequest[] {
  const blocks = readBlocks(db);
  return SERIES.filter((s) => wantsBlock(db, s))
    .map((s) => ({
      series: s, size: BLOCK_SIZE[s], gap: FIRST_GAP[s],
      floor: Math.max(localMaxNumber(db, s), ...(blocks[s] ?? []).map((b) => b.hi)),
    }));
}

/* ═══════════ الترقيم القديم بحرف الجهاز · لما لا كتلة له ═══════════ */

const LETTER_KEY = 'device_letter';
/** «'» = بلا حرف بعد التسجيل · والغياب = لم يُسجَّل الجهاز (لا حرف) */
const NONE = "'";

export function deviceLetter(db: DB): string {
  const v = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [LETTER_KEY])?.value;
  return !v || v === NONE ? '' : v;
}

export function deviceLetterAssigned(db: DB): boolean {
  return !!db.get(`SELECT 1 FROM meta WHERE key = ?`, [LETTER_KEY]);
}

export function setDeviceLetter(db: DB, letter: string): void {
  if (letter && !/^[A-Z]{1,2}$/.test(letter)) throw new Error('حرف جهاز غير صالح');
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [LETTER_KEY, letter || NONE]);
}

/**
 * شرط SQL لأرقام هذا الجهاز بالترقيم القديم · `glob` نمط الرقم بلا لاحقة (مثل 'JE-[0-9]*').
 * بلا حرف: ما لا لاحقة له · وبحرف: ما ينتهي بـ «-حرف».
 */
export function ownNumbersSql(column: string, glob: string, letter: string): { sql: string; params: string[] } {
  if (!letter) return { sql: `${column} GLOB ? AND NOT (${column} GLOB '*-[A-Z]' OR ${column} GLOB '*-[A-Z][A-Z]')`, params: [glob] };
  return { sql: `${column} GLOB ?`, params: [glob + '-' + letter] };
}

/** الرقم بحرف الجهاز إن كان له حرف */
export function withLetter(no: string, letter: string): string {
  return letter ? no + '-' + letter : no;
}
