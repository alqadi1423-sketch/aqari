/**
 * إعادة اشتقاق سطور قيد العضو من مستنده · بقية المراحل بعد التحصيل (التوجيه الثالث · ١ · قرار المالك 2026-10-15 «١»: «(ب) على مراحل،
 * الدفعات والتحصيل أولاً، ثم بقية المصادر بترتيب كثرة استعمالها»، و2026-11-07: «وتُطبق المطابقة في كل مرحلة قادمة من إعادة
 * الاشتقاق») · حين يصل جهازَ المالك قيدٌ مرحّل كتبه عضو بمصدرٍ هنا، تُحسب سطوره من مستنده (الصف هنا أو الوارد المنتظر) بدوال بناء
 * السطور نفسها التي رحّل بها الجهاز الكاتب (post.ts)، وتُقارن حساباً بحساب ومبلغاً بمبلغ وبُعداً ببُعد (أبعاد المصدر كما يشتقها
 * dimsFromSource) · ويُرفض القيد كله إن خالف، ويُنتظر إن لم يصل مستنده.
 *
 *  - القيد الذي وصل معكوساً (reversed_by) أثره صفر متى طابقه عاكسه: يُفحص عاكسه مرآةً لسطوره بالحساب والمبلغ والبُعد، وحساباته من
 *    أطراف مصدره، ولا يُطابق بمستنده الحالي (تعديل التسوية أو المطالبة يعكس القديم ويرحّل الجديد، فالمستند يحمل القيم الجديدة).
 *  - وقيدٌ ثانٍ حيّ من المصدر نفسه لا يدخل حتى يُطبَّق عاكس الأول (مرحَّلٌ مرتين بالمبلغ الصحيح يضاعف أثره): يُنتظر، فإن لم يصل
 *    عاكسٌ رُفض لطول انتظاره ولم يدخل الدفتر.
 */
import type { DB } from '../../db/adapter';
import { t } from '../../i18n';
import { isFiledDate } from '../vatFilings';
import { unitPastProperties } from '../unitMove';
import { contractDepositLines, type EntryLine } from './post';

/** سطرٌ وارد كما في مستنده (journal_lines) */
export interface SrcLine {
  account_code?: unknown; debit_halalas?: unknown; credit_halalas?: unknown;
  contract_id?: unknown; unit_id?: unknown; property_id?: unknown;
}
/** قيدٌ مرحّل لمصدرٍ هنا أو في الوارد */
export interface SrcEntry { id: string; src_type: string | null; src_id: string | null; lines: SrcLine[] }

/** قارئ المستندات على جهاز المالك (sync/engine.ts): أحدث نسخةٍ للصف (الوارد المنتظر ثم القائم)، والقيود المرحّلة بمصدرها */
export interface SourceReader {
  row<T>(table: string, key: string): T | null;
  /**
   * القيود المرحّلة بمصدرها هنا وحده: ما في الوارد لم يُفحص بعد (عاكسٌ مزوّر فيه كان يُحتسب) · وما يُنتظر منه يُنتظر به، فيُعاد
   * القيد في المرور التالي بعد تطبيقه
   */
  entries(srcType: string, srcId: string): SrcEntry[];
  /** قيدٌ مرحّل بمعرّفه هنا أو في الوارد */
  entry(id: string): SrcEntry | null;
}

/** المصادر التي يُعاد اشتقاقها هنا · وأطراف حساباتها (لما وصل معكوساً) */
export const DERIVED_SOURCES: Record<string, string[]> = {
  contract_deposit: ['1100', '1260', '2400'],
};

/** أبعاد سطرٍ متوقعة: العقد والوحدة، والعقار أحد عقاراتٍ (الحالي أو ما نُقلت منه الوحدة) */
interface DimSpec { contract: string | null; unit: string | null; props: Array<string | null> }
interface Want { account: string; debit: number; credit: number; dims: DimSpec[] }
interface Derived { lines: Want[]; date: string; correctable: boolean }

const str = (v: unknown) => (v == null || v === '' ? null : String(v));
const num = (v: unknown) => Number(v) || 0;
const nonZero = <T extends SrcLine>(ls: T[]) => ls.filter((l) => num(l.debit_halalas) || num(l.credit_halalas));
const total = (e: SrcEntry) => e.lines.reduce((s, l) => s + num(l.credit_halalas), 0);

const AWAIT = 'await';
type Outcome = Derived | typeof AWAIT | string;

/** أبعاد عقدٍ ووحدته وعقارها كما يشتقها dimsFromSource على الجهاز الكاتب · null إن لم يصل العقد */
function contractDims(db: DB, r: SourceReader, contractId: string, ownContract?: string): DimSpec | null {
  const c = r.row<{ unit_id: string | null }>('contracts', contractId);
  if (!c) return null;
  return { ...unitDims(db, r, c.unit_id ?? null), contract: ownContract ?? contractId };
}
function unitDims(db: DB, r: SourceReader, unitId: string | null): DimSpec {
  if (!unitId) return { contract: null, unit: null, props: [null] };
  const now = r.row<{ property_id: string | null }>('units', unitId)?.property_id ?? null;
  return { contract: null, unit: unitId, props: [now, ...unitPastProperties(db, unitId)] };
}
const want = (lines: EntryLine[] | null, dims: (l: EntryLine, i: number) => DimSpec[]): Want[] | null =>
  lines ? lines.map((l, i) => ({ account: l.account, debit: l.debit || 0, credit: l.credit || 0, dims: dims(l, i) })) : null;

const no = (key: string, opts: Record<string, unknown> = {}) => t('deriveSrc.' + key, { ...opts, lng: 'ar' });

/** المصدر الحيّ الذي لم يُعكس: قيوده المرحّلة هنا ناقصاً عواكسها · بمجموع مبالغها أو عددها */
function live(r: SourceReader, src: string, srcId: string, exceptId: string, by: (e: SrcEntry) => number): number {
  return r.entries(src, srcId).filter((e) => e.id !== exceptId).reduce((s, e) => s + by(e), 0)
    - r.entries(src + '_rev', srcId).reduce((s, e) => s + by(e), 0);
}

/** سطور القيد المتوقعة من مستنده · 'await' لمستندٍ لم يصل · أو سبب الرفض */
function derive(db: DB, r: SourceReader, e: { id: string; src: string; srcId: string; total: number }): Outcome {
  switch (e.src) {
    case 'contract_deposit': {
      // التأمين المقبوض: تأمين العقد ناقصاً ما رُحِّل إليه من عقده السابق (التجديد: تأمينه المرحَّل وزيادته)
      const c = r.row<{ deposit_halalas: number; deposit_holder: string | null; start: string | null; status: string; renewed_from: string | null }>('contracts', e.srcId);
      if (!c) return AWAIT;
      if (c.status === 'مسودة') return AWAIT; // i18n-exempt: حالة العقد المخزّنة · توثيقه لم يصل بعد
      const carried = live(r, 'deposit_carry', e.srcId, e.id, total);
      const amount = num(c.deposit_halalas) - carried;
      if (e.total !== amount && !carried && c.renewed_from) {
        // ترحيلٌ لم يصل بعد: القيد بقدر الزيادة على تأمين العقد السابق ينتظره
        const prev = r.row<{ deposit_halalas: number }>('contracts', c.renewed_from);
        if (prev && e.total === num(c.deposit_halalas) - num(prev.deposit_halalas)) return AWAIT;
      }
      const dims = contractDims(db, r, e.srcId);
      if (!dims) return AWAIT;
      const lines = want(contractDepositLines(amount, c.deposit_holder), () => [dims]);
      return lines ? { lines, date: c.start ?? '', correctable: true } : no('noEntry');
    }
  }
  return '';
}

/** المطابقة: كل سطرٍ وارد يقابله سطرٌ مشتق واحد بحسابه ومدينه ودائنه وأبعاده · '' إن طابقت */
function matchIssue(got: SrcLine[], want: Want[]): string {
  const g = nonZero(got);
  const w = want.filter((l) => l.debit || l.credit);
  const used = new Set<number>();
  for (const l of g) {
    const acc = String(l.account_code ?? '');
    const same = (x: Want) => x.account === acc && x.debit === num(l.debit_halalas) && x.credit === num(l.credit_halalas);
    const i = w.findIndex((x, j) => !used.has(j) && same(x) && x.dims.some((d) =>
      d.contract === str(l.contract_id) && d.unit === str(l.unit_id) && d.props.includes(str(l.property_id))));
    if (i < 0) return w.some((x, j) => !used.has(j) && same(x)) ? no('dims', { account: acc }) : no('account', { account: acc });
    used.add(i);
  }
  const left = w.find((_, j) => !used.has(j));
  return left ? no('account', { account: left.account }) : '';
}

/** تاريخ القيد تاريخ مستنده · أو بعده إن قُدِّم إقرار ربعه (قيد تصحيحٍ بتاريخ اليوم: correctionDate) */
function dateIssue(db: DB, got: string, d: Derived): string {
  const g = got.slice(0, 10);
  const want = d.date.slice(0, 10);
  if (g === want) return '';
  return d.correctable && g > want && isFiledDate(db, want) ? '' : no('date');
}

/** عاكس القيد الوارد معكوساً: مرحّلٌ بمصدره، وسطوره مرآةٌ لسطوره بالحساب والمبلغ والبُعد · '' أو 'await' أو السبب */
function reversedIssue(r: SourceReader, e: { id: string; src: string; srcId: string; lines: SrcLine[] }, revId: string): string {
  const rev = r.entry(revId);
  if (!rev) return AWAIT;
  if (rev.src_type !== e.src + '_rev' || (rev.src_id ?? '') !== e.srcId) return no('mirror');
  const orig = nonZero(e.lines);
  const back = nonZero(rev.lines);
  if (orig.length !== back.length) return no('mirror');
  const used = new Set<number>();
  for (const l of back) {
    const i = orig.findIndex((x, j) => !used.has(j) && String(x.account_code) === String(l.account_code)
      && num(x.debit_halalas) === num(l.credit_halalas) && num(x.credit_halalas) === num(l.debit_halalas)
      && str(x.contract_id) === str(l.contract_id) && str(x.unit_id) === str(l.unit_id) && str(x.property_id) === str(l.property_id));
    if (i < 0) return no('mirror');
    used.add(i);
  }
  // وما يُشتق منه بلا مستنده: حساباته من أطراف مصدره
  const allowed = DERIVED_SOURCES[e.src];
  const bad = orig.find((l) => !allowed.includes(String(l.account_code)));
  return bad ? no('account', { account: String(bad.account_code) }) : '';
}

/**
 * سبب رفض قيد عضوٍ مرحّل بمصدرٍ من المصادر المشتقة · '' إن طابق مستنده أو لم يكن مصدره منها · 'await' إن لم يصل مستنده بعد
 * (أو عاكسه، أو عاكس قيدٍ حيٍّ قبله من المصدر نفسه)
 */
export function memberSourceIssue(db: DB, r: SourceReader,
  e: { id: string; src_type: string | null; src_id: string | null; date: string; reversed_by: string | null; lines: SrcLine[] }): string {
  const src = e.src_type ?? '';
  if (!DERIVED_SOURCES[src]) return '';
  const srcId = e.src_id ?? '';
  if (e.reversed_by) return reversedIssue(r, { id: e.id, src, srcId, lines: e.lines }, e.reversed_by);
  if (live(r, src, srcId, e.id, () => 1) > 0) return AWAIT;
  const d = derive(db, r, { id: e.id, src, srcId, total: nonZero(e.lines).reduce((s, l) => s + num(l.credit_halalas), 0) });
  if (typeof d === 'string') return d;
  return dateIssue(db, e.date, d) || matchIssue(e.lines, d.lines);
}
