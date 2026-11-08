/**
 * صورة كشف البنك (المدقق الخارجي U١٢ · DESIGN §١٣.٢٢ · سجل القرارات ٥٦): قارئ النص في الجوال (ML Kit) لا يقرأ العربية، فتُقرأ من الصورة
 * أرقامها وتواريخها وحدها · سطور القارئ بمواضعها ← صفوفٌ بموضعها العمودي (والصورة المائلة قليلاً صفٌّ واحد) ← في كل صفٍّ تاريخٌ ومبالغ
 * بكسرين ← الرصيد أبعد المبالغ عن التاريخ (العربي من اليمين والإنجليزي من اليسار سواء) والحركة ما يليه ← جدولٌ يقرؤه القارئ العام
 * (readStatementGrid) فتُحدَّد الإشارة من تسلسل الأرصدة ويُفحص الافتتاحي مع الحركات بالختامي كما في كل كشف · وأخطاء القراءة الشائعة
 * في الأرقام (O وl وS وفاصلةٌ مكان النقطة) تُصحَّح داخل ما هو رقمٌ أصلاً، وما بقي خطأً يكسر التسلسل فيُرفض أو يُحفظ «غير متحقَّق» بتأكيد.
 */
import { readStatementGrid, type ReadOpts, type StatementResult } from './read';
import { summaryOf } from './columns';
import { cellText, parseStatementDate } from './normalize';

/** سطرٌ من قارئ النص بإطاره (ML Kit: frame) */
export interface OcrLine { text: string; left: number; top: number; width: number; height: number }

// ما يقرؤه قارئ النص مكان الرقم في صورةٍ رديئة
const LOOKALIKE: Record<string, string> = { O: '0', o: '0', D: '0', Q: '0', l: '1', I: '1', i: '1', '|': '1', '!': '1', S: '5', s: '5', B: '8', Z: '2', z: '2' };
const NUMERIC_CHARS = /^[\d.,/\-()+OoDQlIi|!SsBZz]+$/;

const DATE_TOKEN = /^(\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}|\d{1,2}-[A-Za-z]{3,9}-\d{2,4})$/;
const FULL_DATE = /^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}$/;
const AMOUNT_SHAPE = /^[-(]?(\d{1,3}([.,]\d{3})*|\d+)[.,]\d{2}[)-]?$/;

/**
 * رمزٌ رقميّ الهيئة بأرقامه الصحيحة: فيه رقمان حقيقيان فأكثر ويصير بالتصحيح مبلغاً بكسرين أو تاريخاً أو عدداً أغلبه أرقام، وإلا كما هو
 */
export function fixDigits(token: string): string {
  if (!NUMERIC_CHARS.test(token)) return token;
  const digits = (token.match(/\d/g) ?? []).length;
  if (digits < 2) return token;
  const fixed = [...token].map((c) => LOOKALIKE[c] ?? c).join('');
  const looks = [...token].filter((c) => c in LOOKALIKE).length;
  return AMOUNT_SHAPE.test(fixed) || DATE_TOKEN.test(fixed) || (/^\d+$/.test(fixed) && looks <= digits) ? fixed : token;
}

/** مبلغٌ بكسرين كما تطبعه الكشوف (والفاصلة الأخيرة قبل رقمين كسرٌ قرأه القارئ فاصلة) · نصه للقارئ العام أو null */
export function amountToken(token: string): string | null {
  const m = /^([-(]?)([\d.,]+)([)-]?)$/.exec(fixDigits(token));
  if (!m) return null;
  const body = m[2];
  if (!/^\d{1,3}([.,]\d{3})*[.,]\d{2}$/.test(body) && !/^\d+[.,]\d{2}$/.test(body)) return null;
  const whole = body.slice(0, -3).replace(/[.,]/g, '');
  return m[1] + whole + '.' + body.slice(-2) + m[3];
}

interface Tok { text: string; x: number }
interface OcrRow { y: number; h: number; toks: Tok[] }

/** صفوف الصورة: سطور القارئ بموضعها العمودي، وكل سطرٍ كلماته بمواضعها التقريبية */
function rowsOf(lines: OcrLine[]): OcrRow[] {
  const sorted = lines.filter((l) => cellText(l.text)).map((l) => ({ ...l, cy: l.top + l.height / 2 })).sort((a, b) => a.cy - b.cy);
  const rows: Array<OcrRow & { n: number }> = [];
  for (const l of sorted) {
    // مقارنةً بمتوسط الصف لا بأول سطرٍ فيه: الصورة المائلة ينزل صفّها قليلاً من طرفٍ إلى طرف
    const r = rows.find((x) => Math.abs(x.y - l.cy) <= Math.max(x.h, l.height) * 0.6);
    const words = cellText(l.text).split(' ');
    const per = l.width / Math.max(1, cellText(l.text).length);
    let at = l.left;
    const toks = words.map((w) => { const t = { text: w, x: at + (w.length * per) / 2 }; at += (w.length + 1) * per; return t; });
    if (r) { r.y = (r.y * r.n + l.cy) / (r.n + 1); r.n += 1; r.h = Math.max(r.h, l.height); r.toks.push(...toks); } else rows.push({ y: l.cy, h: l.height, toks, n: 1 });
  }
  return rows.map((r) => ({ ...r, toks: [...r.toks].sort((a, b) => a.x - b.x) }));
}

/** القراءة: جدولٌ من الصفوف (عناوينه مصنوعة) للقارئ العام · والإشارة من تسلسل الأرصدة إن طُبع رصيدٌ لكل حركة */
export function readStatementPhoto(lines: OcrLine[], opts: ReadOpts = {}): StatementResult {
  const rows = rowsOf(lines);
  type Mv = { date: string; descr: string; amount: string; balance: string };
  const moves: Mv[] = [];
  const head: string[][] = [];
  const tail: string[][] = [];
  for (const r of rows) {
    // «CR» و«DR» بعد المبلغ كلمةٌ منفصلة في القارئ
    const toks: Tok[] = [];
    for (const t of r.toks) {
      if (/^(CR|DR|Cr|Dr)\.?$/.test(t.text) && toks.length && amountToken(toks[toks.length - 1].text)) toks[toks.length - 1].text += ' ' + t.text.slice(0, 2);
      else toks.push({ ...t });
    }
    // والهجري بجانب الميلادي ليس تاريخ الحركة: يُؤخذ ما يُقرأ ميلادياً إن وُجد (المدقق الخارجي D٢-٧)
    const anyDates = toks.filter((t) => DATE_TOKEN.test(fixDigits(t.text)));
    const gregorian = anyDates.filter((t) => FULL_DATE.test(fixDigits(t.text)) && !!(parseStatementDate(fixDigits(t.text)) || parseStatementDate(fixDigits(t.text), { order: 'mdy' })));
    const hijriOnly = anyDates.filter((t) => FULL_DATE.test(fixDigits(t.text)) && !gregorian.includes(t));
    const dates = gregorian.length && hijriOnly.length ? gregorian : anyDates;
    const amounts = toks.map((t) => {
      const [num, mark] = t.text.split(' ');
      const a = amountToken(num);
      return a ? { x: t.x, text: a + (mark ? ' ' + mark : '') } : null;
    }).filter((a): a is { x: number; text: string } => !!a);
    const words = toks.filter((t) => !DATE_TOKEN.test(fixDigits(t.text)) && !amountToken(t.text.split(' ')[0])).map((t) => t.text).join(' ');
    // الملخص: كل كلمة ملخصٍ بالمبلغ الذي يليها في ترتيب القراءة (المدقق الخارجي V١٢: «الافتتاحي … الختامي …» في سطرٍ واحد) · والصف الذي
    // فيه تاريخٌ ومبلغٌ ورصيد حركةٌ ولو حمل بيانه كلمةً من القاموس كـ«FROM» (V٣)، والفترة وحدها لا تجعل صفاً ملخصاً
    const label = summaryOf(words);
    const summaryRow = label && label !== 'period' && amounts.length && (!dates.length || amounts.length === 1);
    if (summaryRow) {
      const rows: string[][] = [];
      let text: string[] = [];
      for (const t of toks) {
        const a = amountToken(t.text.split(' ')[0]);
        if (!a) { if (!DATE_TOKEN.test(fixDigits(t.text))) text.push(t.text); continue; }
        if (text.length && summaryOf(text.join(' '))) rows.push([text.join(' '), a + (t.text.includes(' ') ? ' ' + t.text.split(' ')[1] : '')]);
        text = [];
      }
      (moves.length ? tail : head).push(...(rows.length ? rows : [[words, amounts[amounts.length - 1].text]]));
      continue;
    }
    if (!dates.length || !amounts.length) {
      if (!moves.length && dates.length >= 2) head.push(toks.map((t) => fixDigits(t.text)));
      continue;
    }
    // التاريخ أول الصف في اتجاهه (الأيمن للعربي والأيسر للإنجليزي)، والرصيد أبعد المبالغ عنه
    const rtl = dates[dates.length - 1].x > amounts[amounts.length - 1].x;
    const date = rtl ? dates[dates.length - 1] : dates[0];
    const byDistance = [...amounts].sort((a, b) => Math.abs(b.x - date.x) - Math.abs(a.x - date.x));
    if (amounts.length === 1) {
      moves.push({ date: fixDigits(date.text), descr: words, amount: amounts[0].text, balance: '' });
      continue;
    }
    const balance = byDistance[0];
    // ومع عمودي مدينٍ ودائن مطبوعين «0.00» في أحدهما: الحركة غير الصفر الأقرب إلى الرصيد
    const rest = byDistance.slice(1).filter((a) => !/^[-(]?0+\.00/.test(a.text));
    const amount = rest[0] ?? byDistance[1];
    moves.push({ date: fixDigits(date.text), descr: words, amount: amount.text, balance: balance.text });
  }
  if (!moves.length) return { ok: false, error: 'empty' };
  // ورصيدٌ لكل حركة: الإشارة من التسلسل وحده (علامةٌ ضاعت في الصورة لا تقلب حركة)
  const chain = moves.every((m) => m.balance);
  const strip = (a: string) => a.replace(/^[-(]|[)-]$|\s(CR|DR|Cr|Dr)$/g, '');
  const grid: string[][] = [
    ...head,
    ['Date', 'Description', 'Amount', 'Balance'],
    ...moves.map((m) => [m.date, m.descr, chain ? strip(m.amount) : m.amount, m.balance]),
    ...tail,
  ];
  const r = readStatementGrid(grid, { ...opts, mapping: undefined });
  if (r.ok) return { ...r, warnings: [...r.warnings, 'photo'] };
  return r;
}
