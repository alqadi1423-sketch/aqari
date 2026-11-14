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

export class CashShortfallError extends Error {
  constructor(public needed: number, public available: number, what: string) {
    super('النقد في المحفظة ' + fmt(Math.max(0, available)) + ' لا يكفي: ' + what + ' بمبلغ ' + fmt(needed)
      + ' · ينقصه ' + fmt(needed - Math.max(0, available)) + '، سجّله «إيداع المالك» أولاً');
    this.name = 'CashShortfallError';
  }
  get shortfall(): number { return this.needed - Math.max(0, this.available); }
}

/** الناقص عن صرف نقدي بمبلغ · صفر إن كفى */
export function cashShortfall(db: DB, amountHalalas: number): number {
  if (!(amountHalalas > 0)) return 0;
  return Math.max(0, amountHalalas - Math.max(0, walletCashBalance(db)));
}

/** يرفض الصرف النقدي إن لم يكفِ النقد · قبل أي كتابة */
export function requireCash(db: DB, amountHalalas: number, what: string): void {
  if (!(amountHalalas > 0)) return;
  const available = walletCashBalance(db);
  if (amountHalalas > available) throw new CashShortfallError(amountHalalas, available, what);
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
 * لا يرى البنك (المراجعة الشاملة 2026-11-13 · A2.2).
 */
export function bankShortages(db: DB, entryNo: string, mode: 'reverse' | 'repost'): string[] {
  const out: string[] = [];
  for (const r of db.all<{ bank_id: string; s: number; name: string | null }>(
    `SELECT t.bank_id, SUM(t.amount_halalas) AS s, b.name FROM bank_tx t LEFT JOIN banks b ON b.id = t.bank_id
     WHERE t.journal_no = ? AND t.deleted_at IS NULL GROUP BY t.bank_id`, [entryNo])) {
    const amount = mode === 'reverse' ? Number(r.s) : -Number(r.s);
    if (!(amount > 0)) continue;
    const balance = bankBalance(db, r.bank_id);
    if (balance < amount) out.push(t('bankTx.bankShort', { bank: r.name ?? '', balance: fmt(balance), amount: fmt(amount) }));
  }
  return out;
}

/** يرفض العكس أو الإعادة إن لم يكفِ بنكٌ لما تُخرجه منه · قبل أي كتابة */
export function requireBanksCover(db: DB, entryNo: string, mode: 'reverse' | 'repost'): void {
  const short = bankShortages(db, entryNo, mode);
  if (short.length) throw new BankShortfallError(short[0]);
}
