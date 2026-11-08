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
  /** نصوص صف العناوين كما في الكشف: تعرضها الشاشة بأدوارها المخمَّنة ليؤكدها المستخدم أو يصححها (U٩) */
  labels?: string[];
}

export type StatementError = 'format' | 'encrypted' | 'columns' | 'empty' | 'balance' | 'needBalances' | 'image';

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
      /** openingPrinted: الافتتاحي المطبوع يناقض الأرصدة فقُدِّم الثابت بالتسلسل وشهدت المجاميع */
      warnings: string[];
      /** رقم الحساب أو الآيبان كما في الكشف (MT940 «:25:» أو الرأس) · يُقارن بآيبان البنك عند الحفظ (U٢١) */
      account?: string | null;
    }
  | { ok: false; error: StatementError; detail?: string; partial?: Partial<StatementOk> };

/** القراءة الناجحة · وجزءٌ منها مع رفض «needBalances» و«balance» لتعبئة الافتتاحي والختامي أو الحفظ بتأكيدٍ صريح (قرار المالك 2026-10-09) */
export type StatementOk = Extract<StatementResult, { ok: true }>;

/**
 * قراءةٌ لم يثبت فحصها (الافتتاحي مع الحركات لا يساوي الأرصدة أو الختامي) تُحفظ بتأكيد المستخدم الصريح «غير متحقَّقة» (قرار المالك
 * 2026-10-09 أ.٤) · والختامي مجموعها لا المطبوع · null إن لم يكن فيها ما يُحفظ (سطورٌ بإشاراتها وافتتاحي)
 */
export function unverifiedResult(p: Partial<StatementOk> | undefined): StatementOk | null {
  if (!p?.lines?.length || p.opening == null || !p.mapping) return null;
  const closing = p.opening + p.lines.reduce((s, l) => s + l.amount, 0);
  return {
    ok: true, lines: p.lines, opening: p.opening, closing, from: p.from ?? p.lines[0].date, to: p.to ?? p.lines[p.lines.length - 1].date,
    mapping: p.mapping, checks: { chain: false, closing: false, totals: null }, warnings: ['unverified'], account: p.account ?? null,
  };
}

export interface ReadOpts {
  mapping?: ColumnMapping;
  /** يكتبهما المستخدم من رأس الكشف إن لم يُطبعا في الجدول */
  opening?: number;
  closing?: number;
  excelSerial?: boolean;
}

const fail = (error: StatementError, detail?: string, partial?: Partial<StatementOk>): StatementResult => ({ ok: false, error, detail, partial });
const rowKey = (row: string[]): string => row.map(foldText).filter(Boolean).join('|');
const FULL_DATE = /\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}/g;
const FULL_DATE_ONLY = /^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}$/;
// («Page 1 of 2» و«Page 1/2» و«صفحة ١ / ٢» و«1 / 2» · foldText يجعل «/» مسافة · المدقق الخارجي F٢-٤)
const PAGE_MARK = /^(?:(?:page|pg|صفحه|الصفحه)\s*\d+(?:\s*(?:of|من)?\s*\d+)?|\d+\s+(?:of|من)\s+\d+)$/;
// (و«n / m» بمسافتين أو بكلمة الصفحة وحدها: «05/10» تاريخٌ بلا سنة)
const PAGE_SLASH = /^\s*(?:(?:page|pg|صفحة|صفحه|الصفحة|الصفحه)\s*\d+\s*\/\s*\d+|\d+\s+\/\s+\d+)\s*$/i;
// مبلغٌ داخل نصٍّ (الملخص في خليةٍ واحدة مع كلمته)
const AMOUNT_IN_TEXT = /[-(]?\d[\d,.٫٬ﺭ]*\)?(?:\s?(?:CR|DR|Cr|Dr))?/g;

interface Raw { date: string; valueDate: string | null; descr: string; ref: string | null; abs: number; sign: 1 | -1 | 0; balance: number | null }

export function readStatementGrid(input: unknown[][], opts: ReadOpts = {}): StatementResult {
  // ورقم الصفحة في التذييل («Page 1 of 2» · «صفحة ١ من ٢») خانةٌ فارغة: يقع تحت عمود مبلغٍ فيُرفض به كشفٌ صحيح (المدقق الخارجي D٢-٤)
  const grid = input.map((r) => (Array.isArray(r) ? r : []).map(cellText).map((c) => (PAGE_MARK.test(foldText(c)) || PAGE_SLASH.test(c) ? '' : c)))
    .filter((r) => r.some(Boolean));
  if (!grid.length) return fail('empty');

  // ١) صف العناوين: بصمة الربط المحفوظ أولاً، ثم أول صفٍّ فيه ثلاثة أدوارٍ منها التاريخ والمبلغ أو المدين أو الدائن
  let h = -1;
  let roles: Array<Role | null> = [];
  if (opts.mapping) {
    h = grid.findIndex((r) => rowKey(r) === opts.mapping!.headerKey);
    if (h >= 0) roles = opts.mapping.roles;
  }
  const savedRoles = h >= 0;
  if (h < 0) {
    // وصفُّ الملخص («الرصيد الافتتاحي · إجمالي المدين …») ليس صفَّ عناوين، وأكثر الصفوف أدواراً أولى (المدقق الخارجي U٣)
    let best = 0;
    grid.forEach((r, i) => {
      if (i >= 80 || r.some((c) => summaryOf(c))) return;
      const rr = headerRoles(r);
      if (!isHeader(rr)) return;
      const n = new Set(rr.filter(Boolean)).size;
      if (n > best) { best = n; h = i; }
    });
    if (h >= 0) roles = headerRoles(grid[h]);
  }
  // وأعمدةٌ لم تُعرف: صفّ العناوين المرجَّح (ما قبل أول صفٍّ بتاريخ) بأدواره المخمَّنة، ليحدّدها المستخدم (U٩ · قرار المالك أ.٣)
  const unknownColumns = (at: number): StatementResult => {
    let k = at;
    if (k < 0) {
      const firstDated = grid.findIndex((r) => r.some((c) => FULL_DATE_ONLY.test(c)));
      k = firstDated - 1;
      while (k >= 0 && grid[k].filter(Boolean).length < 3) k--;
    }
    if (k < 0) return fail('columns');
    const row = grid[k];
    return fail('columns', undefined, { mapping: { headerKey: rowKey(row), roles: headerRoles(row), dateOrder: 'dmy', signMode: 'chain', labels: row } });
  };
  if (h < 0) return unknownColumns(-1);
  // وعنوانٌ بصفّين: «المبلغ» مدموجاً فوق «مدين | دائن» في الصف التالي يكمّل أدوار صفّ العناوين (المدقق الخارجي D٢-١٠) · صفٌّ كل خاناته
  // أدوارٌ بلا تاريخٍ ولا مبلغ، وأدواره في خاناتٍ فارغةٍ أو «المبلغ» فوقها
  let labels = grid[h];
  const sub = grid[h + 1];
  if (!savedRoles && sub && !sub.some((c) => FULL_DATE_ONLY.test(c) || parseStatementAmount(c) != null)) {
    const subRoles = sub.map((c) => (c ? roleOf(c) : null));
    const fits = sub.every((c, i) => !c || (subRoles[i] && (!roles[i] || roles[i] === 'amount')));
    if (fits && subRoles.some(Boolean)) {
      roles = roles.map((r, i) => subRoles[i] ?? (r === 'amount' && subRoles.some((x, j) => x && roles[j] == null) ? null : r));
      labels = grid[h].map((c, i) => (sub[i] ? (c ? c + ' · ' + sub[i] : sub[i]) : c));
    }
  }
  const col = (r: Role) => roles.indexOf(r);
  const dateCol = col('date') >= 0 ? col('date') : col('valueDate');
  const valueCol = col('date') >= 0 ? col('valueDate') : -1;
  const [descrCol, debitCol, creditCol, amountCol, balanceCol, refCol, typeCol] =
    (['descr', 'debit', 'credit', 'amount', 'balance', 'ref', 'type'] as Role[]).map(col);
  if (dateCol < 0 || (amountCol < 0 && debitCol < 0 && creditCol < 0)) return unknownColumns(h);
  const headerKey = rowKey(grid[h]);
  const isRepeatHeader = (r: string[]) => rowKey(r) === headerKey || isHeader(headerRoles(r));

  // ٢) فترة الكشف من صفوف ما قبل العناوين (تاريخان كاملان)، وصيغة التاريخ بما يُقرأ منه كله وبالفترة
  let from: string | null = null;
  let to: string | null = null;
  // صفُّ «الفترة» أولاً، ثم صفٌّ فيه تاريخان (U١٠: «تاريخ فتح الحساب … تاريخ الطباعة» قبله لا يصير فترة)
  const head = grid.slice(0, h);
  for (const r of [...head.filter((x) => x.some((c) => summaryOf(c) === 'period')), ...head.filter((x) => !x.some((c) => summaryOf(c) === 'period'))]) {
    // (والهجري بجانب الميلادي في صفّ الفترة يُترك · المدقق الخارجي H٢-٤)
    const found = (r.join(' ').match(FULL_DATE) ?? []).filter((x) => parseStatementDate(x, { order: 'dmy' }) || parseStatementDate(x, { order: 'mdy' }));
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
  // وإن قُرئت الصيغتان كلتاهما: ما تتتابع به التواريخ مع الصفوف، ثم الأقصر مدىً (U٤: «MM/DD» بأيامٍ كلها ≤ ١٢ كانت تُقرأ «DD/MM» بصمت)
  const shape = (o: DateOrder) => {
    const ds = dateCells.map((c) => yearFor(o, c)).filter((x): x is string => !!x);
    const up = ds.every((d, i) => i === 0 || d >= ds[i - 1]);
    const down = ds.every((d, i) => i === 0 || d <= ds[i - 1]);
    const sorted = [...ds].sort();
    const span = ds.length ? (Date.parse(sorted[sorted.length - 1]) - Date.parse(sorted[0])) / 86400000 : 0;
    return { n: score(o), mono: up || down ? 1 : 0, span };
  };
  // وصيغة الربط المحفوظ أو المصحَّح تُقدَّم إن قُرئت بها التواريخ كلها (قرار المالك أ.٣ · المدقق الخارجي H٢-٧: كان التخمين الأقصر مدىً يغلبها)
  // (وتُقدَّم إن قرأت ما تقرؤه الأخرى: تذييلٌ في عمود التاريخ لا تقرؤه أيٌّ منهما · J٢-٣)
  const order = opts.mapping && score(opts.mapping.dateOrder) >= score(opts.mapping.dateOrder === 'dmy' ? 'mdy' : 'dmy') && score(opts.mapping.dateOrder) > 0 ? opts.mapping.dateOrder
    : orders.map((o) => ({ o, ...shape(o) }))
      .reduce((a, b) => (b.n > a.n || (b.n === a.n && (b.mono > a.mono || (b.mono === a.mono && b.span < a.span))) ? b : a)).o;

  // ٣) السطور، والبيان المكمِّل، والملخص
  const signedColumn = amountCol >= 0 && body.some((r) => amountHasSign(r[amountCol] ?? ''));
  // علامةٌ واحدة في العمود: «CR» وحدها تجعل ما بلا علامة مديناً، و«DR» وحدها دائناً (U١٣)
  const marks = amountCol >= 0 ? body.map((r) => markOf(r[amountCol] ?? '')) : [];
  const unmarked: 1 | -1 = marks.includes('cr') && !marks.includes('dr') && !marks.includes('minus') ? -1 : 1;
  const signMode: ColumnMapping['signMode'] = debitCol >= 0 && creditCol >= 0 ? 'split'
    : signedColumn ? 'signed' : typeCol >= 0 ? 'type' : 'chain';
  // والربط المخمَّن يرافق رفض «format» و«empty» فتعرضه الشاشة ليُصحَّح (قرار المالك أ.٣ · المدقق الخارجي D٢: عنوانٌ جديد يُخمَّن خطأً كان
  // يُرفض بلا ورقة الأعمدة)
  const mapping: ColumnMapping = { headerKey, roles, dateOrder: order, signMode, labels };
  const raws: Raw[] = [];
  const summary: Partial<Record<SummaryKey, number>> = {};
  // «الرصيد المرحَّل» وعدد الحركات قبله: ختاميٌّ إن لم تأتِ بعده حركة (صورة الصفحة الأولى · Z١-٢)، وإلا رصيدٌ بين صفحتين لا يغلب
  // ختامي الرأس (المدقق الخارجي D٢-٥)
  let carriedAt = -1;
  // والافتتاحي بموضعه من الحركات: قبلها أو بعدها كلها افتتاحيٌّ، وفي وسطها «رصيدٌ منقول» بين صفحتين لا افتتاحي الكشف (المدقق الخارجي
  // F٢-٩: «Balance Brought Forward» أعلى الصفحة الثانية كان افتتاحياً للكشف كله)
  const openings: Array<{ v: number; at: number; bf?: boolean; pg?: boolean }> = [];
  // (وصفّ الملخص بعد صفّ عناوين مكرر أول صفحةٍ جديدة · L٢-١)
  const pageStart = new Set<string[]>();
  // (وقبله مباشرةً: المنقول أعلى الصفحة فوق صفّ العناوين · N٢-٣)
  for (let i = h + 1; i < grid.length; i++) if (isRepeatHeader(grid[i])) { if (grid[i + 1]) pageStart.add(grid[i + 1]); pageStart.add(grid[i - 1]); }
  const moneyCols = [debitCol, creditCol, amountCol, balanceCol].filter((c) => c >= 0);
  const noteSummary = (r: string[]) => {
    r.forEach((cell, i) => {
      const k = summaryOf(cell);
      if (!k || k === 'period') return;
      const v = amountAfter(r, i);
      if (v == null) return;
      // الافتتاحي أولُ ما يُطبع (كل صفحةٍ قد تكرره) والختامي آخره
      if (k === 'opening' || k === 'broughtForward') { openings.push({ v, at: raws.length, bf: k === 'broughtForward', pg: pageStart.has(r) }); return; }
      if (k === 'carried') carriedAt = raws.length;
      summary[k] = v;
    });
  };
  // وملخصٌ بصفّين: كلماته في صفٍّ وقيمها تحتها في الصف التالي («Opening Balance | Total Debits …» ثم أرقامها · U٣)
  grid.slice(0, h).forEach((r, i, head) => {
    const keys = r.map((c) => summaryOf(c));
    const next = head[i + 1];
    if (keys.filter((k) => k && k !== 'period').length >= 2 && next && !next.some((c) => summaryOf(c))) {
      keys.forEach((k, c) => {
        if (!k || k === 'period' || summary[k] != null) return;
        const v = parseStatementAmount(next[c] ?? '');
        if (v != null && (k === 'opening' || k === 'broughtForward')) openings.push({ v, at: 0, bf: k === 'broughtForward' });
        else if (v != null) summary[k] = v;
      });
      return;
    }
    noteSummary(r);
  });
  // وملخصٌ بصفّين بعد الحركات (كلماته في صفٍّ وقيمها تحته · جدول ملخص الجزيرة في آخر الكشف · المدقق الخارجي P٢-١)
  const skipRow = new Set<string[]>();
  body.forEach((r, i) => {
    const keys = r.map((c) => summaryOf(c));
    const next = body[i + 1];
    if (keys.filter((k) => k && k !== 'period').length < 2 || !next || next.some((c) => summaryOf(c)) || r.some((c) => parseStatementAmount(c) != null)) return;
    if (!keys.some((k, c) => k && k !== 'period' && parseStatementAmount(next[c] ?? '') != null)) return;
    skipRow.add(next);
  });
  for (let i0 = 0; i0 < body.length; i0++) {
    const r = body[i0];
    if (skipRow.has(r)) continue;
    {
      const next = body[i0 + 1];
      if (next && skipRow.has(next)) {
        r.forEach((c, ci) => {
          const k = summaryOf(c);
          const v = k && k !== 'period' ? parseStatementAmount(next[ci] ?? '') : null;
          if (!k || v == null) return;
          if (k === 'opening' || k === 'broughtForward') openings.push({ v, at: raws.length, bf: k === 'broughtForward', pg: pageStart.has(r) });
          else { if (k === 'carried') carriedAt = raws.length; summary[k] = v; }
        });
        continue;
      }
    }
    const date = yearFor(order, r[dateCol] ?? '');
    // وصفُّ ملخصٍ بتاريخه (الافتتاحي أو الختامي) ليس حركة (U٧)
    // وصفٌّ مؤرَّخ بلا مبلغ حركة: ملخصٌ إن حمل كلمته، وإلا ليس حركة (ختم الطباعة في التذييل · المدقق الخارجي V١٣) · والصف الذي فيه مبلغ
    // مدينٍ أو دائن حركةٌ أياً كانت كلمات بيانه («ACCOUNT OPENING DEPOSIT» · V٢)
    // (والصفر «0.00» في خانةٍ فارغة ليس مبلغ حركة · X٦ · وما لا يُقرأ مبلغاً يبقى ليرفضه فحص U٥)
    // وختم الطباعة بوقته في التذييل ومعه رقم الصفحة وحده («07/11/2026 10:30 … 2») ليس حركة: بلا رصيدٍ، وبلا بيانٍ أو خارج فترة الكشف
    // (المدقق الخارجي F٢-٤)
    // (والصف الذي فيه مبلغٌ بكسرين حركةٌ ولو بلا بيان · J٢-٦ وV٢)
    if (date && /\d{1,2}:\d{2}/.test(r[dateCol] ?? '') && (balanceCol < 0 || !cellText(r[balanceCol] ?? ''))
      && ![debitCol, creditCol, amountCol].some((c) => c >= 0 && /\d[.,٫]\d{2}(?!\d)/.test(cellText(r[c] ?? '')))
      && (!cellText(descrCol >= 0 ? r[descrCol] ?? '' : '') || (from && to && (date < from || date > to)))) continue;
    const moved = [debitCol, creditCol, amountCol].some((c) => c >= 0 && cellText(r[c] ?? '') !== '' && parseStatementAmount(r[c] ?? '') !== 0);
    if (date && !moved) {
      const k = r.map((c) => summaryOf(c)).find((x) => x === 'opening' || x === 'broughtForward' || x === 'closing' || x === 'carried' || x === 'totalDebit' || x === 'totalCredit');
      // والافتتاحي والختامي المؤرَّخان قيمتهما في عمود الرصيد (والأصفار في المدين والدائن خاناتٌ فارغة · X٦)
      const bal = balanceCol >= 0 ? parseStatementAmount(r[balanceCol] ?? '') : null;
      if ((k === 'opening' || k === 'broughtForward' || k === 'closing' || k === 'carried') && bal != null) {
        if (k === 'opening' || k === 'broughtForward') openings.push({ v: bal, at: raws.length, bf: k === 'broughtForward', pg: pageStart.has(r) }); else summary[k] = bal;
        if (k === 'carried') carriedAt = raws.length;
      } else if (k) noteSummary(r);
      continue;
    }
    if (!date) {
      const filled = r.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
      const textOnly = filled.length > 0 && filled.every((i) => i === descrCol || i === refCol)
        && !moneyCols.some((c) => parseStatementAmount(r[c] ?? '') != null);
      // (وكلمة ملخصٍ بلا قيمةٍ بعدها، أو «من» بلا تاريخ، بيانٌ مكمِّل لا ملخص · المدقق الخارجي H٢-٩)
      const summaryRow = r.some((c, i) => {
        const k = summaryOf(c);
        if (!k) return false;
        return k === 'period' ? /\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}/.test(c) : amountAfter(r, i) != null;
      });
      if (textOnly && raws.length && !summaryRow) {
        const last = raws[raws.length - 1];
        last.descr = cellText(last.descr + ' ' + (descrCol >= 0 ? r[descrCol] ?? '' : '') + ' ' + (refCol >= 0 && descrCol < 0 ? r[refCol] ?? '' : ''));
      } else noteSummary(r);
      continue;
    }
    let abs = 0;
    let sign: Raw['sign'] = 0;
    // وخلية مبلغٍ فيها نصٌّ لا يُقرأ ترفض الكشف ولا تصير صفراً (U٥)
    const unreadable = (c: number) => c >= 0 && cellText(r[c] ?? '') !== '' && parseStatementAmount(r[c] ?? '') == null;
    if ([debitCol, creditCol, amountCol].some(unreadable)) return fail('format', 'amount', { mapping });
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
      if (signMode === 'signed') sign = amountHasSign(cell) ? (v < 0 ? -1 : 1) : unmarked;
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
  if (!raws.length) return fail('empty', undefined, { mapping });

  // ٤) الجدول المطبوع مرتين أو أكثر في الملف (الأهلي) مرةً واحدة، والأحدث أولاً يُقلب
  // (والطيّ إن تكرر صفّ العناوين وحده: حركاتٌ حقيقية متكررة صافيها صفر لا تُطوى · U٦)
  const headerRepeats = grid.slice(h + 1).some(isRepeatHeader);
  let lines = headerRepeats ? collapseRepeats(raws) : raws;
  const newestFirst = lines[0].date > lines[lines.length - 1].date;
  if (newestFirst) lines = [...lines].reverse();
  // (والأحدث أولاً: افتتاحيه بعد حركاته في الطباعة)
  const atStart = (o: { at: number }) => o.at === 0;
  const atEnd = (o: { at: number }) => o.at === raws.length;
  // («الرصيد المنقول» افتتاحيٌّ في أول الكشف زمنياً وحده، و«الافتتاحي» في أوله أو في ملخصٍ آخره · المدقق الخارجي H٢-٦)
  const first = newestFirst ? atEnd : atStart;
  const other = newestFirst ? atStart : atEnd;
  // (و«الافتتاحي/السابق» في الطرف الآخر ملخصٌ إلا أن يساوي رصيد آخر حركةٍ قبله في الطباعة: ذاك رصيدٌ منقول بين صفحتين · J٢-٤ مع H٢-٦)
  // (وبعد صفّ عناوين مكرر وحده: شهرٌ صافيه صفر ختاميه يساوي افتتاحيه · L٢-١)
  const carriedOver = (o: { v: number; at: number; pg?: boolean }) => !!o.pg && o.at > 0 && raws[o.at - 1]?.balance === o.v;
  summary.opening = ((newestFirst ? [...openings].reverse() : openings).find(first)
    ?? openings.find((o) => !o.bf && other(o) && !carriedOver(o)))?.v;

  // ٥) التسلسل: بالافتتاحي المطبوع، ثم بالمشتق من أول رصيدٍ مطبوع إن ناقضه المطبوع وثبتت المجاميع
  const printedOpening = summary.opening ?? opts.opening ?? null;
  const carriedClosing = summary.carried != null && carriedAt === raws.length ? summary.carried : null;
  const printedClosing = summary.closing ?? carriedClosing ?? opts.closing ?? null;
  let solved = solve(lines, printedOpening);
  // وعمود «نوع العملية» نصٌّ وصفي («Credit Card Payment» خارج، و«رسوم إيداع شيك» خارج): إن ناقضت إشاراته الأرصدة المطبوعة لكل سطر
  // فالأرصدة تحكم (المدقق الخارجي D٢-٦)
  // (والسطر بلا رصيد يبقى بإشارة نوعه، وبلا افتتاحيٍّ مطبوع يُشتق من أول سطرٍ برصيده بإشارة نوعه · F٢-٣)
  if (!solved.ok && signMode === 'type' && lines.some((l) => l.balance != null)) {
    const anchor = printedOpening == null ? lines.findIndex((l) => l.balance != null) : -1;
    const byChain = solve(lines.map((l, i) => (l.balance != null && i !== anchor ? { ...l, sign: 0 as const } : l)), printedOpening);
    if (byChain.ok) solved = byChain;
  }
  const warnings: string[] = [];
  const totalsPrinted = summary.totalDebit != null || summary.totalCredit != null;
  // والافتتاحي المطبوع المناقض لا يُستبدل إلا بمجاميع مطبوعة تشهد (U٢: الختامي وحده آخر رصيدٍ مطبوع فلا يشهد بشيء)
  if (!solved.ok && summary.opening != null && solved.reason === 'opening' && totalsPrinted) {
    const again = solve(lines, null);
    if (again.ok) { solved = again; warnings.push('openingPrinted'); }
  }
  // والفترة المطبوعة تحوي السطور ولا تزيد على مداها بأكثر من شهرين، وإلا أُخذ مدى السطور (U١٠) · في القراءة الناجحة والجزئية سواء (V١١)
  const periodOf = (ls: StatementLine[]): [string, string] => {
    const dates = ls.map((l) => l.date).sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;
    return from && to && !(first < from || last > to || days(from, to) > days(first, last) + 62) ? [from, to] : [first, last];
  };
  const partialOf = (ls: StatementLine[], o: number | null): Partial<StatementOk> => ({
    lines: ls, opening: o ?? undefined, closing: o == null ? undefined : o + ls.reduce((s, l) => s + l.amount, 0), mapping,
    from: periodOf(ls)[0], to: periodOf(ls)[1], account: accountOf(grid.slice(0, h)),
  });
  if (!solved.ok) {
    // وما عُرفت إشاراته كلها (عمودا مدين ودائن أو مبلغٌ موقَّع) جزءٌ يُحفظ «غير متحقَّق» بتأكيدٍ صريح (قرار المالك 2026-10-09 أ.٤:
    // «يُنبَّه ولا تبدأ المطابقة إلا بتأكيد») · وما جُهلت إشارته لا يُحفظ
    // (وإشارات عمود النوع التي ناقضتها الأرصدة المطبوعة لا تُعرض للحفظ · F٢-٣)
    const known = lines.every((l) => l.sign !== 0) && !(signMode === 'type' && lines.some((l) => l.balance != null));
    const asPrinted: StatementLine[] = lines.map((l) => ({
      date: l.date, valueDate: l.valueDate, descr: l.descr, ref: l.ref, amount: l.abs === 0 ? 0 : l.sign * l.abs, balance: l.balance,
    }));
    const o = printedOpening ?? (asPrinted[0].balance != null ? asPrinted[0].balance - asPrinted[0].amount : null);
    return fail(solved.reason === 'unknown' ? 'needBalances' : 'balance', solved.reason, known ? partialOf(asPrinted, o) : undefined);
  }
  const out = solved.lines;
  const total = out.reduce((s, l) => s + l.amount, 0);
  const partial = (o: number | null) => partialOf(out, o);
  if (solved.opening == null) return fail('needBalances', 'opening', partial(null));
  const closing = solved.opening + total;
  const hadBalances = out.some((l) => l.balance != null);
  if (printedClosing != null && printedClosing !== closing) return fail('balance', 'closing', partial(solved.opening));
  // وطرفا الكشف شاهدان: ما قبل أول رصيدٍ مطبوع يشهد له الافتتاحي (مطبوعاً أو مكتوباً)، وما بعد آخره الختامي (U١: سطرٌ أول بـ80,000 بدل
  // 8,000 كان يُقبل بافتتاحيٍّ مشتقٍّ سالب، وسطرٌ أخير بلا رصيدٍ ولا ختامي بأي مبلغ)
  if (printedOpening == null && !warnings.includes('openingPrinted')) {
    // وسطرٌ أول برصيده وحده يُشتق منه الافتتاحي (ويُنبَّه)، أما ما قبله بلا رصيد فلا يشهد له شيء
    if (out[0].balance == null) return fail('needBalances', 'opening', partial(solved.opening));
    warnings.push('openingDerived');
  }
  if (printedClosing == null && out[out.length - 1].balance == null) return fail('needBalances', 'closing', partial(solved.opening));
  if (!hadBalances && printedClosing == null) return fail('needBalances', 'closing', partial(solved.opening));
  let totals: boolean | null = null;
  if (summary.totalDebit != null || summary.totalCredit != null) {
    const dr = out.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0);
    const cr = out.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
    totals = (summary.totalDebit == null || Math.abs(summary.totalDebit) === dr) && (summary.totalCredit == null || Math.abs(summary.totalCredit) === cr);
    if (!totals) return fail('balance', 'totals', partial(solved.opening));
  }
  [from, to] = periodOf(out);
  return {
    ok: true, lines: out, opening: solved.opening, closing,
    from, to, mapping,
    checks: { chain: hadBalances ? true : null, closing: printedClosing != null ? true : null, totals },
    warnings, account: accountOf(grid.slice(0, h)),
  };
}

/** علامة إشارة المبلغ في خليته */
function markOf(raw: string): 'cr' | 'dr' | 'minus' | null {
  const t = cellText(raw);
  if (/(^|[^A-Za-z])[Cc][Rr]\b/.test(t)) return 'cr';
  if (/(^|[^A-Za-z])[Dd][Rr]\b/.test(t)) return 'dr';
  return /^[-\u2212(]|[-\u2212)]$/.test(t.replace(/\s+/g, '')) ? 'minus' : null;
}

/** الآيبان أو رقم الحساب في رأس الكشف (U٢١) */
function accountOf(head: string[][]): string | null {
  for (const r of head) {
    const joined = r.join(' ').replace(/\s+/g, '');
    const iban = /SA\d{2}[0-9A-Z]{20}/i.exec(joined);
    if (iban) return iban[0].toUpperCase();
  }
  // ورقم الحساب بكلمته («رقم الحساب» أو «Account No/Number» لا «Account» وحدها) في خليتها بعدها أو في الخلية التالية وحدها، والتاريخ
  // ليس رقماً (المدقق الخارجي V٧ وX٤: «Account Statement 01-10-2026 …» و«Account Opening Date» كانا يصنعان رقماً آخر)
  const KEY = /رقم الحساب|account\s*(no\.?|number|#)|a\/c\s*(no\.?|number)/i;
  const noDates = (t: string) => t.replace(FULL_DATE, ' ');
  for (const r of head) {
    const i = r.findIndex((c) => KEY.test(c));
    if (i < 0) continue;
    const own = (noDates(r[i].replace(new RegExp('.*(' + KEY.source + ')', 'i'), '')).match(/\d[\d\s-]{6,}\d/) ?? [''])[0].replace(/\D/g, '');
    if (own.length >= 8) return own;
    const next = noDates(r[i + 1] ?? '').replace(/[\s-]/g, '');
    if (/^\d{8,}$/.test(next)) return next;
  }
  return null;
}

function isHeader(roles: Array<Role | null>): boolean {
  const set = new Set(roles.filter(Boolean) as Role[]);
  return set.size >= 3 && (set.has('date') || set.has('valueDate')) && (set.has('amount') || set.has('debit') || set.has('credit'));
}

/** أول مبلغٍ بعد خلية الكلمة في الصف، أو في الخلية نفسها بعدها، أو قبلها (الكشف العربي يضع القيمة يسار الكلمة) */
// والتاريخ باسم الشهر («15-Mar-2015» و«Mar 15, 2015») ليس مبلغاً (المدقق الخارجي H٢-٥)
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const TEXT_DATE = new RegExp(`\\b\\d{1,2}[\\s\\-/]+${MONTH}[\\s\\-/,]+\\d{2,4}\\b|\\b${MONTH}\\s+\\d{1,2},?\\s+\\d{4}\\b`, 'gi');
const TEXT_DATE_ONE = new RegExp(TEXT_DATE.source, 'i');
const isDateCell = (c: string) => FULL_DATE_ONLY.test(c.replace(/\s.*$/, '')) || (TEXT_DATE_ONE.test(c) && cellText(c).replace(TEXT_DATE, '').trim() === '');
function amountAfter(r: string[], i: number): number | null {
  // والمبلغ قبل فحص الدور: «1,000.00 CR» قيمةٌ لا عنوانُ «دائن» (المدقق الخارجي F٢-٧) · والتاريخ ليس مبلغاً، في خليته أو بعدها
  // («Account Opening Date: 15/03/2015» كان افتتاحياً بـ2,015 · F٢-٦)
  for (let j = i + 1; j < r.length; j++) {
    if (isDateCell(r[j])) continue;
    const v = parseStatementAmount(r[j]);
    if (v != null) return v;
    if (summaryOf(r[j]) || roleOf(r[j])) break;
  }
  // (ومبلغ الخلية نفسها مبلغٌ لا رقم مرجعٍ أو بطاقة: لا يلتصق بحرف، وبلا كسرٍ ولا فاصل آلافٍ لا يُقبل وفي الخلية كلماتٌ غير الملخص · J٢-٥)
  const cell = r[i].replace(FULL_DATE, ' ').replace(TEXT_DATE, ' ');
  const inCell = [...cell.matchAll(AMOUNT_IN_TEXT)].filter((m) => {
    const before = cell.slice(0, m.index ?? 0);
    if (/[A-Za-z\u0600-\u06FF]$/.test(before)) return false;
    if (/[.,٫٬ﺭ]\d/.test(m[0])) return true;
    const rest = foldText(cell.replace(m[0], ' '));
    return !!summaryOf(rest) && rest.split(' ').filter(Boolean).length <= 4;
  }).map((m) => parseStatementAmount(m[0])).filter((v): v is number => v != null);
  if (inCell.length) return inCell[inCell.length - 1];
  for (let j = i - 1; j >= 0; j--) {
    if (summaryOf(r[j])) break;
    if (isDateCell(r[j])) continue;
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
    // اليوم كما طُبع أو مقلوباً أولاً بمرورٍ واحد، والبحث في ترتيب القيد لما سواهما (المدقق الخارجي U٢٦: كان تربيعياً في اليوم الواحد)
    const fast = [group, [...group].reverse()].map((seq) => walkDay(seq, prev, pending, derived)).find(Boolean);
    if (fast) {
      out.push(...fast.lines);
      ({ prev, pending, derived } = fast);
      if (fast.sawBalance) firstBalanceSeen = true;
      i = j;
      continue;
    }
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

/** مرورٌ على سطور يومٍ بترتيبها: ما تتسلسل به الأرصدة أو null */
function walkDay(seq: Raw[], prev0: number | null, pending0: number, derived0: number | null):
  { lines: StatementLine[]; prev: number | null; pending: number; derived: number | null; sawBalance: boolean } | null {
  let prev = prev0;
  let pending = pending0;
  let derived = derived0;
  let sawBalance = false;
  const lines: StatementLine[] = [];
  for (const g of seq) {
    let sign = g.sign;
    if (g.balance == null) {
      if (sign === 0) return null;
    } else if (prev == null) {
      if (sign === 0) return null;
      derived = g.balance - pending - sign * g.abs;
    } else {
      const diff = g.balance - (prev + pending);
      if (sign !== 0 ? diff !== sign * g.abs : Math.abs(diff) !== g.abs) return null;
      if (sign === 0) sign = diff < 0 ? -1 : 1;
    }
    const amount = g.abs === 0 ? 0 : sign * g.abs;
    if (g.balance != null) { prev = g.balance; pending = 0; sawBalance = true; } else pending += amount;
    lines.push({ date: g.date, valueDate: g.valueDate, descr: g.descr, ref: g.ref, amount, balance: g.balance });
  }
  return { lines, prev, pending, derived, sawBalance };
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
    checks: { chain: null, closing: true, totals: null }, warnings: [], account: m.account,
  };
}

/** صورةٌ (JPEG أو PNG بتوقيعهما، أو بامتداد صورة) تُقرأ بقارئ النص لا بالقارئ العام */
export function isStatementImage(f: { name: string; bytes: Uint8Array }): boolean {
  const b = f.bytes;
  return (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    || /\.(jpe?g|png|heic|webp)$/.test(f.name.toLowerCase());
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
  // والصورة تُقرأ بقارئ النص على الجهاز (services/bankStatement.ts) ثم readStatementPhoto (U١٢)
  if (isStatementImage(f)) return fail('image');
  if (/\.(csv|tsv|txt|sta|mt940|940)$/.test(name)) {
    const text = decodeText(b);
    if (/^:6[01][FM]?:/m.test(text)) return fromMt940(parseMt940(text), opts);
    try { return readStatementGrid(parseCsv(text), opts); } catch { return fail('format'); }
  }
  return fail('format');
}
