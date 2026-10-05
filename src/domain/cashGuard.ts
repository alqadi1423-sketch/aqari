/**
 * كفاية النقد (قرار المالك ٢٠٢٦-١٠-٠٥): كل صرفٍ نقدي يتحقق من رصيد المحفظة، ولا يصير النقد سالباً أبداً.
 * المحفظة = حساب النقدية 1100 ناقص ما استقر في البنوك (walletCashBalance) · فالصرف البنكي لا يمسّها.
 * وأثر القيد على المحفظة = مدينه على 1100 ناقص حركات البنك المربوطة برقمه · وعكسه يُخرج مثله.
 * الواجهة: عند عدم الكفاية لا يظهر زر الصرف، ومكانه السبب ورابط «إيداع المالك» بالناقص (CashGate).
 */
import type { DB } from '../db/adapter';
import { walletCashBalance } from './accounting/ledger';
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
