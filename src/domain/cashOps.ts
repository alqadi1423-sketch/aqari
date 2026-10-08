/**
 * التصرف بالنقد · عمليات المحفظة النقدية:
 * إيداع في بنك، سحب من بنك، تحويل بين بنكين، مصروف نثري، إيداع المالك، مسحوبات المالك.
 * الحساب 1100 يحمل النقد كله؛ أرصدة البنوك تُتتبَّع عبر bank_tx،
 * لذا الإيداع/السحب/التحويل حركات بنكية فقط بلا قيد، والمصروف والإيداع قيدان.
 */
import type { DB } from '../db/adapter';
import { requireCash } from './cashGuard';
import { uid } from './ids';
import { fmt } from './money';
import { logAudit } from './audit';
import { postEntry } from './accounting/post';
import { walletCashBalance, bankBalance } from './accounting/ledger';
import { t } from '../i18n';

const MODULE = 'المحفظة النقدية';

function bankName(db: DB, bankId: string): string {
  const b = db.get<{ name: string }>(`SELECT name FROM banks WHERE id = ?`, [bankId]);
  if (!b) throw new Error('تعذّر العثور على الحساب البنكي المحدد');
  return b.name;
}

function requirePositive(amountHalalas: number): void {
  if (!Number.isInteger(amountHalalas) || amountHalalas <= 0) {
    throw new Error('أدخل مبلغاً أكبر من صفر · المبلغ المُدخل ' + fmt(amountHalalas || 0));
  }
}

/** كفاية النقد بالدالة الواحدة (cashGuard) · الرسالة نفسها في كل صرف نقدي */
function requireWalletCovers(db: DB, amountHalalas: number, what: string): void {
  requireCash(db, amountHalalas, what);
}

function insertBankTx(db: DB, bankId: string, date: string, descr: string, amount: number, source: string): void {
  db.run(
    `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
     VALUES (?,?,?,?,?,1,'',?,?)`,
    [uid(), bankId, date, descr, amount, source, new Date().toISOString()]
  );
}

/** إيداع نقد من المحفظة في حساب بنكي · حركة بنكية موجبة، والنقدية 1100 لا تتغير */
export function depositCashToBank(
  db: DB,
  args: { bankId: string; amountHalalas: number; date: string; notes?: string }
): void {
  requirePositive(args.amountHalalas);
  requireWalletCovers(db, args.amountHalalas, 'الإيداع في البنك');
  const name = bankName(db, args.bankId);
  db.transaction(() => {
    insertBankTx(
      db, args.bankId, args.date,
      args.notes?.trim() || 'إيداع نقدي في ' + name,
      args.amountHalalas, 'إيداع نقدي من المحفظة'
    );
    logAudit(db, MODULE, 'create', 'إيداع نقدي في بنك', name, undefined, {
      amount_halalas: args.amountHalalas, date: args.date,
    });
  });
}

/** سحب نقد من حساب بنكي إلى المحفظة · حركة بنكية سالبة */
export function withdrawCashFromBank(
  db: DB,
  args: { bankId: string; amountHalalas: number; date: string; notes?: string }
): void {
  requirePositive(args.amountHalalas);
  const name = bankName(db, args.bankId);
  const b = bankBalance(db, args.bankId);
  if (args.amountHalalas > b) {
    throw new Error('رصيد ' + name + ' هو ' + fmt(b) + ' ولا يكفي لسحب ' + fmt(args.amountHalalas));
  }
  db.transaction(() => {
    insertBankTx(
      db, args.bankId, args.date,
      args.notes?.trim() || 'سحب نقدي من ' + name,
      -args.amountHalalas, 'سحب نقدي إلى المحفظة'
    );
    logAudit(db, MODULE, 'create', 'سحب نقدي من بنك', name, undefined, {
      amount_halalas: args.amountHalalas, date: args.date,
    });
  });
}

/** تحويل بين بنكين · حركتان بنكيتان متقابلتان، والنقدية 1100 لا تتغير */
export function transferBetweenBanks(
  db: DB,
  args: { fromBankId: string; toBankId: string; amountHalalas: number; date: string; notes?: string }
): void {
  requirePositive(args.amountHalalas);
  if (args.fromBankId === args.toBankId) {
    throw new Error('اختر بنكين مختلفين · لا يمكن التحويل من الحساب إلى نفسه');
  }
  const fromName = bankName(db, args.fromBankId);
  const toName = bankName(db, args.toBankId);
  const b = bankBalance(db, args.fromBankId);
  if (args.amountHalalas > b) {
    throw new Error('رصيد ' + fromName + ' هو ' + fmt(b) + ' ولا يكفي لتحويل ' + fmt(args.amountHalalas));
  }
  db.transaction(() => {
    const descr = args.notes?.trim() || 'تحويل من ' + fromName + ' إلى ' + toName;
    insertBankTx(db, args.fromBankId, args.date, descr, -args.amountHalalas, 'تحويل بين البنوك · صادر');
    insertBankTx(db, args.toBankId, args.date, descr, args.amountHalalas, 'تحويل بين البنوك · وارد');
    logAudit(db, MODULE, 'create', 'تحويل بين بنكين', fromName + ' ← ' + toName, undefined, {
      amount_halalas: args.amountHalalas, date: args.date,
    });
  });
}

/** مصروف نثري نقداً · قيد: مصروفات أخرى 5400 من النقدية 1100 */
export function pettyCashExpense(
  db: DB,
  args: { amountHalalas: number; descr: string; date: string }
): void {
  requirePositive(args.amountHalalas);
  const descr = args.descr.trim();
  if (!descr) throw new Error('اكتب بيان المصروف · لا يُقبل مصروف بلا بيان');
  requireWalletCovers(db, args.amountHalalas, 'صرف المصروف');
  const opId = uid();
  db.transaction(() => {
    postEntry(db, {
      date: args.date,
      memo: 'مصروف نثري نقداً · ' + descr,
      srcType: 'cash_op', srcId: opId,
      lines: [
        { account: '5400', descr, debit: args.amountHalalas, credit: 0 },
        { account: '1100', descr: 'نقداً من المحفظة', debit: 0, credit: args.amountHalalas },
      ],
    });
    logAudit(db, MODULE, 'create', 'مصروف نثري', descr, undefined, {
      amount_halalas: args.amountHalalas, date: args.date,
    });
  });
}

/** إيداع المالك نقداً في المحفظة · قيد: النقدية 1100 من رأس المال 3100 */
export function ownerCashIn(
  db: DB,
  args: { amountHalalas: number; date: string; notes?: string }
): void {
  requirePositive(args.amountHalalas);
  const memo = args.notes?.trim() || 'إيداع المالك نقداً';
  const opId = uid();
  db.transaction(() => {
    postEntry(db, {
      date: args.date,
      memo,
      srcType: 'cash_op', srcId: opId,
      lines: [
        { account: '1100', descr: memo, debit: args.amountHalalas, credit: 0 },
        { account: '3100', descr: memo, debit: 0, credit: args.amountHalalas },
      ],
    });
    logAudit(db, MODULE, 'create', 'إيداع المالك', memo, undefined, {
      amount_halalas: args.amountHalalas, date: args.date,
    });
  });
}

/** مسحوبات المالك نقداً من المحفظة · قيد: رأس المال 3100 من النقدية 1100 */
export function ownerCashOut(
  db: DB,
  args: { amountHalalas: number; date: string; notes?: string }
): void {
  requirePositive(args.amountHalalas);
  requireWalletCovers(db, args.amountHalalas, 'مسحوبات المالك');
  const memo = args.notes?.trim() || 'مسحوبات المالك نقداً';
  const opId = uid();
  db.transaction(() => {
    postEntry(db, {
      date: args.date,
      memo,
      srcType: 'cash_op', srcId: opId,
      lines: [
        { account: '3100', descr: memo, debit: args.amountHalalas, credit: 0 },
        { account: '1100', descr: memo, debit: 0, credit: args.amountHalalas },
      ],
    });
    logAudit(db, MODULE, 'create', 'مسحوبات المالك', memo, undefined, {
      amount_halalas: args.amountHalalas, date: args.date,
    });
  });
}

/**
 * الحركة البنكية اليدوية بنوعها (#33): المحفظة والبنوك كلها في 1100، فالحركة بلا قيد تحويلٌ خفي بين المحفظة والبنك ·
 * فتُسجَّل بنوعها في مسارها: إيداعٌ من المحفظة أو سحبٌ إليها (بكفايتهما)، أو رسومٌ مصروفاً، أو واردٌ آخر إيراداً، بقيدٍ
 * مرتبطٍ بالحركة · قرار المالك 2026-10-05: «كل صرف نقدي يتحقق من رصيد النقد، ولا يصير النقد سالباً أبداً».
 */
export type ManualBankKind = 'deposit' | 'withdraw' | 'fee' | 'income';

export function recordManualBankTx(
  db: DB,
  a: { kind: ManualBankKind; bankId: string; amountHalalas: number; date: string; descr: string },
): void {
  if (a.kind === 'deposit') return depositCashToBank(db, { bankId: a.bankId, amountHalalas: a.amountHalalas, date: a.date, notes: a.descr });
  if (a.kind === 'withdraw') return withdrawCashFromBank(db, { bankId: a.bankId, amountHalalas: a.amountHalalas, date: a.date, notes: a.descr });
  requirePositive(a.amountHalalas);
  const descr = a.descr.trim();
  if (!descr) throw new Error(t('bankTx.descrRequired'));
  const name = bankName(db, a.bankId);
  const fee = a.kind === 'fee';
  if (fee && a.amountHalalas > bankBalance(db, a.bankId)) {
    throw new Error(t('bankTx.bankShort', { bank: name, balance: fmt(bankBalance(db, a.bankId)), amount: fmt(a.amountHalalas) }));
  }
  const opId = uid();
  db.transaction(() => {
    const entry = postEntry(db, {
      date: a.date,
      memo: descr + ' · ' + name,
      srcType: 'cash_op', srcId: opId,
      lines: fee
        ? [{ account: '5400', descr, debit: a.amountHalalas, credit: 0 }, { account: '1100', descr: name, debit: 0, credit: a.amountHalalas }]
        : [{ account: '1100', descr: name, debit: a.amountHalalas, credit: 0 }, { account: '4300', descr, debit: 0, credit: a.amountHalalas }],
    });
    db.run(
      `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
       VALUES (?,?,?,?,?,1,?,?,?)`,
      [uid(), a.bankId, a.date, descr, fee ? -a.amountHalalas : a.amountHalalas, entry ? entry.no : '',
       t(fee ? 'bankTx.kindFee' : 'bankTx.kindIncome', { lng: 'ar' }), new Date().toISOString()]);
    logAudit(db, MODULE, 'create', t(fee ? 'bankTx.kindFee' : 'bankTx.kindIncome', { lng: 'ar' }), name, undefined, {
      amount_halalas: a.amountHalalas, date: a.date,
    });
  });
}

