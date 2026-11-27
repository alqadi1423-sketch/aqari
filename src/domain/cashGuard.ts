/**
 * كفاية النقد (قرار المالك ٢٠٢٦-١٠-٠٥): كل صرفٍ نقدي يتحقق من رصيد المحفظة، ولا يصير النقد سالباً أبداً.
 * المحفظة = حساب النقدية 1100 ناقص ما استقر في البنوك (walletCashBalance) · فالصرف البنكي لا يمسّها.
 * وأثر القيد على المحفظة = مدينه على 1100 ناقص حركات البنك المربوطة برقمه · وعكسه يُخرج مثله.
 * الواجهة: عند عدم الكفاية لا يظهر زر الصرف، ومكانه السبب ورابط «إيداع المالك» بالناقص (CashGate).
 */
import type { DB } from '../db/adapter';
import { walletCashBalance, bankBalance } from './accounting/ledger';
import { t } from '../i18n';
import { fmt } from './money';
import { dfmt } from './dates';

export class CashShortfallError extends Error {
  /** at: يومٌ مضى كان أدنى رصيدٍ للمحفظة من تاريخ العملية فما بعده (A2.8) · فالرسالة تذكره، والإيداع بتاريخٍ لا يتأخر عن العملية */
  constructor(public needed: number, public available: number, what: string, public at?: string) {
    super(at
      ? t('bankTx.walletShortOn', { at: dfmt(at), available: fmt(Math.max(0, available)), what, amount: fmt(needed), short: fmt(needed - Math.max(0, available)) })
      : 'النقد في المحفظة ' + fmt(Math.max(0, available)) + ' لا يكفي: ' + what + ' بمبلغ ' + fmt(needed)
        + ' · ينقصه ' + fmt(needed - Math.max(0, available)) + '، سجّله «إيداع المالك» أولاً');
    this.name = 'CashShortfallError';
  }
  get shortfall(): number { return this.needed - Math.max(0, this.available); }
}

/**
 * يومٌ بصيغته (YYYY-MM-DD) · ما كتبه الحقل القديم بغيرها («2026-3-15») لا يومَ له يُرتَّب به: يُقارن حرفاً فيعلو كل يومٍ صحيح في سنته،
 * فكان يُعدّ بعد تاريخ العملية ويُخرج من رصيدها · فيُحسب فيما مضى كما هو في الرصيد الآن (المراجعة الشاملة 2026-11-13 · D2-R11-2)
 */
const ISO_DAY = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";

/** أدنى رصيدٍ جارٍ ويومه */
export interface LowPoint { low: number; at: string | null }

/**
 * أدنى رصيدٍ في نهاية كل يومٍ من date فما بعده لسلسلة حركاتٍ مؤرخة، والرصيد كله (الآن) معروف · الرصيد في نهاية يوم d = الكل ناقص حركات
 * ما بعده، ولا يتغيّر إلا في أيام الحركات · فيُقرأ في نهاية date ثم في نهاية كل يوم حركةٍ بعده · والتعادل لأقدم يوم
 */
function lowFrom(total: number, date: string, byDate: Array<{ d: string; n: number }>): LowPoint {
  const after = byDate.filter((r) => r.d > date).sort((a, b) => (a.d < b.d ? -1 : 1));
  let run = total - after.reduce((x, r) => x + r.n, 0);
  let best: LowPoint = { low: run, at: date };
  for (const r of after) {
    run += r.n;
    if (run < best.low) best = { low: run, at: r.d };
  }
  return best;
}

/**
 * أدنى رصيدٍ للمحفظة من يوم date فما بعده (قرار المالك س١٩ في المراجعة الشاملة 2026-11-13 · A2.8: «لا يصير النقد سالباً أبداً» في أي
 * يومٍ مضى أيضاً) · المحفظة يومياً = سطور 1100 حتى اليوم ناقص حركات البنوك حتى اليوم (الافتتاحيات ثابتة) · وبلا تاريخ: الرصيد الآن
 */
export function walletLowFrom(db: DB, date?: string | null): LowPoint {
  const total = walletCashBalance(db);
  if (!date) return { low: total, at: null };
  const d = date.slice(0, 10);
  const rows = db.all<{ d: string; n: number }>(
    // i18n-exempt: حالة القيد المخزّنة
    `SELECT d, SUM(n) AS n FROM (
       SELECT substr(e.date, 1, 10) AS d, l.debit_halalas - l.credit_halalas AS n
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_code = '1100' AND e.status = 'مرحّل' AND e.deleted_at IS NULL AND substr(e.date, 1, 10) > ? AND substr(e.date, 1, 10) GLOB ${ISO_DAY}
       UNION ALL
       SELECT substr(COALESCE(date, ''), 1, 10) AS d, -amount_halalas AS n FROM bank_tx
       WHERE deleted_at IS NULL AND substr(COALESCE(date, ''), 1, 10) > ? AND substr(COALESCE(date, ''), 1, 10) GLOB ${ISO_DAY}
     ) GROUP BY d`, [d, d]).map((r) => ({ d: r.d, n: Number(r.n) }));
  return lowFrom(total, d, rows);
}

/** أدنى رصيدٍ للبنك من يوم date فما بعده: افتتاحيه ثابت وحركاته بتواريخها (A2.8) · وبلا تاريخ: الرصيد الآن */
export function bankLowFrom(db: DB, bankId: string, date?: string | null): LowPoint {
  const total = bankBalance(db, bankId);
  if (!date) return { low: total, at: null };
  const d = date.slice(0, 10);
  const rows = db.all<{ d: string; n: number }>(
    `SELECT substr(COALESCE(date, ''), 1, 10) AS d, SUM(amount_halalas) AS n FROM bank_tx
     WHERE bank_id = ? AND deleted_at IS NULL AND substr(COALESCE(date, ''), 1, 10) > ? AND substr(COALESCE(date, ''), 1, 10) GLOB ${ISO_DAY} GROUP BY 1`, [bankId, d])
    .map((r) => ({ d: r.d, n: Number(r.n) }));
  return lowFrom(total, d, rows);
}

/** الناقص عن صرف نقدي بمبلغ · صفر إن كفى · وبتاريخ العملية: بأدنى رصيدٍ للمحفظة منه فما بعده (A2.8) */
export function cashShortfall(db: DB, amountHalalas: number, date?: string | null): number {
  if (!(amountHalalas > 0)) return 0;
  return Math.max(0, amountHalalas - Math.max(0, walletLowFrom(db, date).low));
}

/**
 * رسالة نقص المحفظة عن صرفٍ بمبلغ بتاريخه، كما يرميها requireCash · فارغةٌ إن كفى · للمانع الذي يُعرض قبل التنفيذ (تحت تاريخ الإلغاء
 * أو في حوار العكس) بالعبارة نفسها التي يرفض بها التنفيذ (المراجعة الشاملة 2026-11-13 · A2.8: العكس والإلغاء)
 */
export function cashShortMessage(db: DB, amountHalalas: number, what: string, date?: string | null): string {
  if (!(amountHalalas > 0)) return '';
  const { low, at } = walletLowFrom(db, date);
  return amountHalalas > low
    ? new CashShortfallError(amountHalalas, low, what, at && low < walletCashBalance(db) ? at : undefined).message : '';
}

/**
 * يرفض الصرف النقدي إن لم يكفِ النقد · قبل أي كتابة · وبتاريخ العملية: بأدنى رصيدٍ للمحفظة منه فما بعده، فلا تصير سالبةً في يومٍ مضى،
 * والرسالة تذكر ذلك اليوم إن كان رصيده دون الرصيد الآن (A2.8) · والعكس والإلغاء بتاريخ عاكسهما النافذ كذلك
 */
export function requireCash(db: DB, amountHalalas: number, what: string, date?: string | null): void {
  if (!(amountHalalas > 0)) return;
  const { low, at } = walletLowFrom(db, date);
  if (amountHalalas > low) throw new CashShortfallError(amountHalalas, low, what, at && low < walletCashBalance(db) ? at : undefined);
}

/**
 * رسالة نقص البنك عن مبلغٍ يخرج منه بتاريخه · فارغةٌ إن كفى: بأدنى رصيده من التاريخ فما بعده، والرسالة تذكر ذلك اليوم إن كان رصيده دون
 * الرصيد الآن (A2.8) · وإلا رسالة المسار نفسه (short) أو الرسالة العامة
 */
export function bankShortMessage(db: DB, bankId: string, amountHalalas: number, date?: string | null,
  short?: (bank: string, balance: number) => string): string {
  if (!(amountHalalas > 0)) return '';
  const { low, at } = bankLowFrom(db, bankId, date);
  if (amountHalalas <= low) return '';
  const bank = db.get<{ name: string }>(`SELECT name FROM banks WHERE id = ?`, [bankId])?.name ?? '';
  return at && low < bankBalance(db, bankId)
    ? t('bankTx.bankShortOn', { bank, at: dfmt(at), balance: fmt(low), amount: fmt(amountHalalas) })
    : short ? short(bank, low) : t('bankTx.bankShort', { bank, balance: fmt(low), amount: fmt(amountHalalas) });
}

/**
 * يرفض صرفاً من بنك لا يكفيه رصيده (قرار المالك ٥٥) · وبتاريخ العملية: بأدنى رصيدٍ للبنك منه فما بعده، فلا ينزل تحت الصفر في يومٍ مضى،
 * والرسالة تذكر ذلك اليوم إن كان رصيده دون الرصيد الآن (A2.8) · وإلا رسالة المسار نفسه (short) أو الرسالة العامة
 */
export function requireBankFunds(db: DB, bankId: string, amountHalalas: number, date?: string | null,
  short?: (bank: string, balance: number) => string): void {
  const why = bankShortMessage(db, bankId, amountHalalas, date, short);
  if (why) throw new BankShortfallError(why);
}

/** أثر القيد على المحفظة: موجب أدخل نقداً، وسالب أخرجه */
export function entryCashEffect(db: DB, entryId: string): number {
  const e = db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ?`, [entryId]);
  if (!e) return 0;
  const cash = Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(debit_halalas - credit_halalas), 0) AS s FROM journal_lines WHERE entry_id = ? AND account_code = '1100'`,
    [entryId])!.s);
  const bank = Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(amount_halalas), 0) AS s FROM bank_tx WHERE journal_no = ? AND deleted_at IS NULL`, [e.no])!.s);
  return cash - bank;
}

/** ما يُخرجه عكس قيدٍ من المحفظة · صفر إن لم يكن أدخل نقداً */
export const reversalCashOut = (db: DB, entryId: string): number => Math.max(0, entryCashEffect(db, entryId));

/** بنكٌ لا يكفي لما يُخرجه منه عكسٌ أو إعادة · رسالته كاملة باسم البنك ورصيده والمبلغ */
export class BankShortfallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BankShortfallError';
  }
}

/**
 * ما يُخرجه من كل بنك عكسُ حركات القيد رقم entryNo (reverse: الوارد يصير صادراً) أو إعادةُ نسخها (repost: الصادر يتكرر)،
 * وما لا يكفيه رصيده · قرار المالك (أ · ٥٥): «السداد من حسابٍ بنكي لا يُنزل رصيده تحت الصفر في كل المسارات»، وحارس المحفظة
 * لا يرى البنك (المراجعة الشاملة 2026-11-13 · A2.2) · وبتاريخ العاكس أو النسخة (date): بأدنى رصيد البنك منه فما بعده، فلا يُنزله
 * عكسٌ بتاريخٍ سابق تحت الصفر في يومٍ مضى (قرار المالك س١٩ · A2.8: العكس والإلغاء)
 */
export function bankShortages(db: DB, entryNo: string, mode: 'reverse' | 'repost', date?: string | null): string[] {
  const out: string[] = [];
  for (const r of db.all<{ bank_id: string; s: number }>(
    `SELECT t.bank_id, SUM(t.amount_halalas) AS s FROM bank_tx t
     WHERE t.journal_no = ? AND t.deleted_at IS NULL GROUP BY t.bank_id`, [entryNo])) {
    const amount = mode === 'reverse' ? Number(r.s) : -Number(r.s);
    const why = bankShortMessage(db, r.bank_id, amount, date);
    if (why) out.push(why);
  }
  return out;
}

/** يرفض العكس أو الإعادة إن لم يكفِ بنكٌ لما تُخرجه منه · قبل أي كتابة · وبتاريخ العاكس أو النسخة إن أُعطي (A2.8) */
export function requireBanksCover(db: DB, entryNo: string, mode: 'reverse' | 'repost', date?: string | null): void {
  const short = bankShortages(db, entryNo, mode, date);
  if (short.length) throw new BankShortfallError(short[0]);
}
