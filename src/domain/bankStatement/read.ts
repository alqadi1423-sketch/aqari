/**
 * قارئ كشف البنك العام (التوجيه الرابع ٦ · ٢ · «قارئ عام لا مبني على بنك أو شكل»): جدولٌ من الخلايا (من PDF بمواضعه أو Excel أو CSV) ←
 * صف العناوين بقاموس الأدوار ← صيغة التاريخ بما يُقرأ منه وبفترة الكشف ← سطورٌ تبدأ بتاريخ، والبيان المكمِّل في السطر التالي ← الجدول
 * المكرّر في الملف مرةً ← الأحدث أولاً يُقلب ← الإشارة من عمودي المدين والدائن أو من المبلغ الموقَّع أو من تسلسل الأرصدة، وفي اليوم
 * الواحد بترتيب القيد الذي تتسلسل به الأرصدة ← الافتتاحي مع الحركات يساوي كل رصيدٍ مطبوع والختامي والمجاميع، وإلا لا يُقبل شيء.
 */
import { cellText, foldText, parseStatementAmount, parseStatementDate, amountHasSign, type DateOrder } from './normalize';
import { headerRoles, summaryOf, roleOf, type Role, type SummaryKey } from './columns';
import { parseCsv, decodeText } from './csv';
import { parseMt940, type Mt940 } from './mt940';
import { gridFromPdfItems } from './pdfTable';
import { xlsxGrid } from './xlsx';
import { extractPdfPages, PdfEncrypted } from '../pdf/miniPdfText';

export interface StatementLine {
  date: string;
  valueDate: string | null;
  descr: string;
  ref: string | null;
  /** موقَّع بالهللة: الدائن (الوارد) موجب والمدين سالب */
  amount: number;
  /** الرصيد المطبوع بعد السطر، أو null */
  balance: number | null;
}

export interface ColumnMapping {
  /** بصمة صف العناوين (نصوصه مطبَّعة) */
  headerKey: string;
  roles: Array<Role | null>;
  dateOrder: DateOrder;
  /** split: عمودا مدين ودائن · signed: مبلغٌ موقَّع · type: نوعٌ في عمود · chain: من تسلسل الأرصدة */
  signMode: 'split' | 'signed' | 'type' | 'chain';
}

export type StatementError = 'format' | 'encrypted' | 'columns' | 'empty' | 'balance' | 'needBalances';

export type StatementResult =
  | {
      ok: true;
      lines: StatementLine[];
      opening: number;
      closing: number;
      from: string | null;
      to: string | null;
      mapping: ColumnMapping;
      /** null: لم يُطبع ما يُفحص به */
      checks: { chain: boolean | null; closing: boolean | null; totals: boolean | null };
      /** openingPrinted: الافتتاحي المطبوع يناقض الأرصدة والمجاميع فقُدِّم الثابت بالتسلسل */
      warnings: string[];
    }
  | { ok: false; error: StatementError; detail?: string };

export interface ReadOpts {
  mapping?: ColumnMapping;
  /** يكتبهما المستخدم من رأس الكشف إن لم يُطبعا في الجدول */
  opening?: number;
  closing?: number;
  excelSerial?: boolean;
}

const fail = (error: StatementError, detail?: string): StatementResult => ({ ok: false, error, detail });
const rowKey = (row: string[]): string => row.map(foldText).filter(Boolean).join('|');
const FULL_DATE = /\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}/g;
// مبلغٌ داخل نصٍّ (الملخص في خليةٍ واحدة مع كلمته)
const AMOUNT_IN_TEXT = /[-(]?\d[\d,.٫٬ﺭ]*\)?(?:\s?(?:CR|DR|Cr|Dr))?/g;

interface Raw { date: string; valueDate: string | null; descr: string; ref: string | null; abs: number; sign: 1 | -1 | 0; balance: number | null }

export function readStatementGrid(input: unknown[][], opts: ReadOpts = {}): StatementResult {
  const grid = input.map((r) => (Array.isArray(r) ? r : []).map(cellText)).filter((r) => r.some(Boolean));
  if (!grid.length) return fail('empty');

  // ١) صف العناوين: بصمة الربط المحفوظ أولاً، ثم أول صفٍّ فيه ثلاثة أدوارٍ منها التاريخ والمبلغ أو المدين أو الدائن
  let h = -1;
  let roles: Array<Role | null> = [];
  if (opts.mapping) {
    h = grid.findIndex((r) => rowKey(r) === opts.mapping!.headerKey);
    if (h >= 0) roles = opts.mapping.roles;
  }
  if (h < 0) {
    h = grid.findIndex((r, i) => i < 80 && isHeader(headerRoles(r)));
    if (h >= 0) roles = headerRoles(grid[h]);
  }
  if (h < 0) return fail('columns');
  const col = (r: Role) => roles.indexOf(r);
  const dateCol = col('date') >= 0 ? col('date') : col('valueDate');
  const valueCol = col('date') >= 0 ? col('valueDate') : -1;
  const [descrCol, debitCol, creditCol, amountCol, balanceCol, refCol, typeCol] =
    (['descr', 'debit', 'credit', 'amount', 'balance', 'ref', 'type'] as Role[]).map(col);
  if (dateCol < 0 || (amountCol < 0 && debitCol < 0 && creditCol < 0)) return fail('columns');
  const headerKey = rowKey(grid[h]);
  const isRepeatHeader = (r: string[]) => rowKey(r) === headerKey || isHeader(headerRoles(r));

  // ٢) فترة الكشف من صفوف ما قبل العناوين (تاريخان كاملان)، وصيغة التاريخ بما يُقرأ منه كله وبالفترة
  let from: string | null = null;
  let to: string | null = null;
  for (const r of grid.slice(0, h)) {
    const found = (r.join(' ').match(FULL_DATE) ?? []);
    if (found.length < 2) continue;
    for (const order of ['dmy', 'mdy'] as DateOrder[]) {
      const ds = found.map((x) => parseStatementDate(x, { order }));
      if (ds.every(Boolean)) { [from, to] = [ds[0]!, ds[ds.length - 1]!].sort(); break; }
    }
    if (from) break;
  }
  const body = grid.slice(h + 1).filter((r) => !isRepeatHeader(r));
  const yearFor = (order: DateOrder, cell: string): string | null => {
    const full = parseStatementDate(cell, { order, excelSerial: opts.excelSerial });
    if (full || !from || !to) return full;
    for (const y of new Set([Number(from.slice(0, 4)), Number(to.slice(0, 4))])) {
      const d = parseStatementDate(cell, { order, year: y });
      if (d && d >= from && d <= to) return d;
    }
    return null;
  };
  const orders: DateOrder[] = opts.mapping ? [opts.mapping.dateOrder, opts.mapping.dateOrder === 'dmy' ? 'mdy' : 'dmy'] : ['dmy', 'mdy'];
  const dateCells = body.map((r) => r[dateCol] ?? '').filter((c) => /\d/.test(c));
  const score = (o: DateOrder) => dateCells.filter((c) => {
    const d = yearFor(o, c);
    return d && (!from || !to || (d >= from && d <= to));
  }).length;
  const order = orders.reduce((a, b) => (score(b) > score(a) ? b : a));

  // ٣) السطور، والبيان المكمِّل، والملخص
  const signedColumn = amountCol >= 0 && body.some((r) => amountHasSign(r[amountCol] ?? ''));
  const signMode: ColumnMapping['signMode'] = debitCol >= 0 && creditCol >= 0 ? 'split'
    : signedColumn ? 'signed' : typeCol >= 0 ? 'type' : 'chain';
  const raws: Raw[] = [];
  const summary: Partial<Record<SummaryKey, number>> = {};
  const moneyCols = [debitCol, creditCol, amountCol, balanceCol].filter((c) => c >= 0);
  const noteSummary = (r: string[]) => {
    r.forEach((cell, i) => {
      const k = summaryOf(cell);
      if (!k || k === 'period') return;
      const v = amountAfter(r, i);
      if (v == null) return;
      // الافتتاحي أولُ ما يُطبع (كل صفحةٍ قد تكرره) والختامي آخره
      if (k === 'opening' && summary.opening != null) return;
      summary[k] = v;
    });
  };
  for (const r of grid.slice(0, h)) noteSummary(r);
  for (const r of body) {
    const date = yearFor(order, r[dateCol] ?? '');
    if (!date) {
      const filled = r.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
      const textOnly = filled.length > 0 && filled.every((i) => i === descrCol || i === refCol)
        && !moneyCols.some((c) => parseStatementAmount(r[c] ?? '') != null);
      if (textOnly && raws.length && !r.some((c) => summaryOf(c))) {
        const last = raws[raws.length - 1];
        last.descr = cellText(last.descr + ' ' + (descrCol >= 0 ? r[descrCol] ?? '' : '') + ' ' + (refCol >= 0 && descrCol < 0 ? r[refCol] ?? '' : ''));
      } else noteSummary(r);
      continue;
    }
    let abs = 0;
    let sign: Raw['sign'] = 0;
    if (signMode === 'split') {
      const d = Math.abs(parseStatementAmount(r[debitCol] ?? '') ?? 0);
      const c = Math.abs(parseStatementAmount(r[creditCol] ?? '') ?? 0);
      const v = c - d;
      abs = Math.abs(v);
      sign = v < 0 ? -1 : 1;
    } else {
      const cell = r[amountCol] ?? '';
      const v = parseStatementAmount(cell);
      if (v == null) continue;
      abs = Math.abs(v);
      if (signMode === 'signed') sign = v < 0 ? -1 : 1;
      else if (signMode === 'type') {
        const tt = foldText(r[typeCol] ?? '');
        sign = /مدين|سحب|debit|\bdr\b|withdraw/.test(tt) ? -1 : /دائن|ايداع|credit|\bcr\b|deposit/.test(tt) ? 1 : 0;
      } else sign = amountHasSign(cell) ? (v < 0 ? -1 : 1) : 0;
    }
    raws.push({
      date, valueDate: valueCol >= 0 ? yearFor(order, r[valueCol] ?? '') : null,
      descr: descrCol >= 0 ? r[descrCol] ?? '' : '', ref: refCol >= 0 ? r[refCol] || null : null,
      abs, sign, balance: balanceCol >= 0 ? parseStatementAmount(r[balanceCol] ?? '') : null,
    });
  }
  if (!raws.length) return fail('empty');

  // ٤) الجدول المطبوع مرتين أو أكثر في الملف (الأهلي) مرةً واحدة، والأحدث أولاً يُقلب
  let lines = collapseRepeats(raws);
  if (lines[0].date > lines[lines.length - 1].date) lines = [...lines].reverse();

  // ٥) التسلسل: بالافتتاحي المطبوع، ثم بالمشتق من أول رصيدٍ مطبوع إن ناقضه المطبوع وثبتت المجاميع
  const printedOpening = summary.opening ?? opts.opening ?? null;
  const printedClosing = summary.closing ?? opts.closing ?? null;
  let solved = solve(lines, printedOpening);
  const warnings: string[] = [];
  if (!solved.ok && summary.opening != null && solved.reason === 'opening') {
    const again = solve(lines, null);
    if (again.ok) { solved = again; warnings.push('openingPrinted'); }
  }
  if (!solved.ok) return fail(solved.reason === 'unknown' ? 'needBalances' : 'balance', solved.reason);
  const out = solved.lines;
  const total = out.reduce((s, l) => s + l.amount, 0);
  if (solved.opening == null) return fail('needBalances');
  const closing = solved.opening + total;
  const hadBalances = out.some((l) => l.balance != null);
  if (printedClosing != null && printedClosing !== closing) return fail('balance', 'closing');
  if (!hadBalances && printedClosing == null) return fail('needBalances');
  let totals: boolean | null = null;
  if (summary.totalDebit != null || summary.totalCredit != null) {
    const dr = out.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0);
    const cr = out.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
    totals = (summary.totalDebit == null || Math.abs(summary.totalDebit) === dr) && (summary.totalCredit == null || Math.abs(summary.totalCredit) === cr);
    if (!totals) return fail('balance', 'totals');
  }
  if (warnings.includes('openingPrinted') && totals == null && printedClosing == null) return fail('balance', 'opening');
  return {
    ok: true, lines: out, opening: solved.opening, closing,
    from: from ?? out[0].date, to: to ?? out[out.length - 1].date,
    mapping: { headerKey, roles, dateOrder: order, signMode },
    checks: { chain: hadBalances ? true : null, closing: printedClosing != null ? true : null, totals },
    warnings,
  };
}

function isHeader(roles: Array<Role | null>): boolean {
  const set = new Set(roles.filter(Boolean) as Role[]);
  return set.size >= 3 && (set.has('date') || set.has('valueDate')) && (set.has('amount') || set.has('debit') || set.has('credit'));
}

/** أول مبلغٍ بعد خلية الكلمة في الصف، أو في الخلية نفسها بعدها، أو قبلها (الكشف العربي يضع القيمة يسار الكلمة) */
function amountAfter(r: string[], i: number): number | null {
  for (let j = i + 1; j < r.length; j++) {
    if (summaryOf(r[j]) || roleOf(r[j])) break;
    const v = parseStatementAmount(r[j]);
    if (v != null) return v;
  }
  const inCell = (r[i].match(AMOUNT_IN_TEXT) ?? []).map(parseStatementAmount).filter((v): v is number => v != null);
  if (inCell.length) return inCell[inCell.length - 1];
  for (let j = i - 1; j >= 0; j--) {
    if (summaryOf(r[j])) break;
    const v = parseStatementAmount(r[j]);
    if (v != null) return v;
  }
  return null;
}

/** أصغر كتلةٍ يتكرر بها الجدول كله (مرتين فأكثر) */
function collapseRepeats(rs: Raw[]): Raw[] {
  const same = (a: Raw, b: Raw) => a.date === b.date && a.abs === b.abs && a.sign === b.sign && a.balance === b.balance && foldText(a.descr) === foldText(b.descr);
  for (let p = 1; p <= rs.length / 2; p++) {
    if (rs.length % p) continue;
    if (rs.every((r, i) => same(r, rs[i % p]))) return rs.slice(0, p);
  }
  return rs;
}

type Solved = { ok: true; lines: StatementLine[]; opening: number | null } | { ok: false; reason: 'chain' | 'opening' | 'unknown' };

/**
 * التسلسل: كل رصيدٍ مطبوع = ما قبله + ما بينهما · وفي اليوم الواحد يُختار ترتيب القيد الذي يثبت به (الرياض) · والإشارة المجهولة من
 * فرق الرصيدين · والافتتاحي إن لم يُعطَ فمن أول رصيدٍ مطبوع (ولا يُشتق إن جُهلت إشارة ما قبله)
 */
function solve(rs: Raw[], opening: number | null): Solved {
  const out: StatementLine[] = [];
  let prev: number | null = opening;
  let pending = 0;
  let pendingUnknown = false;
  let derived = opening;
  let firstBalanceSeen = false;
  let i = 0;
  while (i < rs.length) {
    let j = i;
    while (j < rs.length && rs[j].date === rs[i].date) j++;
    const group = rs.slice(i, j);
    while (group.length) {
      let pick = -1;
      let pickSign: 1 | -1 = 1;
      for (let k = 0; k < group.length && pick < 0; k++) {
        const g = group[k];
        if (g.balance == null) {
          if (g.sign !== 0) { pick = k; pickSign = g.sign; }
          continue;
        }
        if (prev == null) {
          if (g.sign === 0 || pendingUnknown) continue;
          pick = k; pickSign = g.sign;
          continue;
        }
        const diff = g.balance - (prev + pending);
        if (g.sign !== 0 ? diff === g.sign * g.abs : Math.abs(diff) === g.abs) { pick = k; pickSign = g.sign !== 0 ? g.sign : (diff < 0 ? -1 : 1); }
      }
      if (pick < 0) {
        const g = group[0];
        if (g.balance == null && g.sign === 0) return { ok: false, reason: prev == null ? 'unknown' : 'chain' };
        if (prev == null) return { ok: false, reason: 'unknown' };
        return { ok: false, reason: !firstBalanceSeen && opening != null ? 'opening' : 'chain' };
      }
      const g = group.splice(pick, 1)[0];
      const amount = g.abs === 0 ? 0 : pickSign * g.abs;
      if (g.balance != null) {
        if (prev == null) derived = g.balance - pending - amount;
        firstBalanceSeen = true;
        prev = g.balance;
        pending = 0;
        pendingUnknown = false;
      } else pending += amount;
      out.push({ date: g.date, valueDate: g.valueDate, descr: g.descr, ref: g.ref, amount, balance: g.balance });
    }
    i = j;
  }
  return { ok: true, lines: out, opening: derived };
}

/** كشف MT940 بنتيجة القارئ: الافتتاحي مع الحركات يساوي الختامي */
function fromMt940(m: Mt940, opts: ReadOpts): StatementResult {
  if (!m.lines.length) return fail('empty');
  const opening = m.opening ?? opts.opening ?? null;
  const closingPrinted = m.closing ?? opts.closing ?? null;
  if (opening == null || closingPrinted == null) return fail('needBalances');
  const total = m.lines.reduce((s, l) => s + l.amount, 0);
  if (opening + total !== closingPrinted) return fail('balance', 'closing');
  const lines: StatementLine[] = m.lines.map((l) => ({ date: l.date, valueDate: l.valueDate, descr: l.descr, ref: l.ref, amount: l.amount, balance: null }));
  return {
    ok: true, lines, opening, closing: closingPrinted, from: lines[0].date, to: lines[lines.length - 1].date,
    mapping: { headerKey: 'mt940', roles: [], dateOrder: 'dmy', signMode: 'signed' },
    checks: { chain: null, closing: true, totals: null }, warnings: [],
  };
}

/** ملف الكشف بصيغته: PDF بطبقة نص، أو Excel، أو CSV ونصٌّ مفصول، أو MT940 */
export function readStatementFile(f: { name: string; bytes: Uint8Array }, opts: ReadOpts = {}): StatementResult {
  const b = f.bytes;
  const name = f.name.toLowerCase();
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    try { return readStatementGrid(gridFromPdfItems(extractPdfPages(b)), opts); } catch (e) {
      return fail(e instanceof PdfEncrypted ? 'encrypted' : 'format');
    }
  }
  if (b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b) {
    const grid = xlsxGrid(b);
    return grid ? readStatementGrid(grid, { ...opts, excelSerial: true }) : fail('format');
  }
  if (/\.(csv|tsv|txt|sta|mt940|940)$/.test(name)) {
    const text = decodeText(b);
    if (/^:6[01][FM]?:/m.test(text)) return fromMt940(parseMt940(text), opts);
    return readStatementGrid(parseCsv(text), opts);
  }
  return fail('format');
}
