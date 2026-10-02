/**
 * التصرف بالنقد · عمليات المحفظة النقدية:
 * إيداع في بنك، سحب من بنك، تحويل بين بنكين، مصروف نثري، إيداع المالك، مسحوبات المالك.
 * الحساب 1100 يحمل النقد كله؛ أرصدة البنوك تُتتبَّع عبر bank_tx،
 * لذا الإيداع/السحب/التحويل حركات بنكية فقط بلا قيد، والمصروف والإيداع قيدان.
 */
import type { DB } from '../db/adapter';
import { uid } from './ids';
import { fmt } from './money';
import { logAudit } from './audit';
import { postEntry } from './accounting/post';
import { walletCashBalance, bankBalance } from './accounting/ledger';

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

function requireWalletCovers(db: DB, amountHalalas: number, what: string): void {
  const w = walletCashBalance(db);
  if (amountHalalas > w) {
    throw new Error('رصيد المحفظة النقدية ' + fmt(w) + ' لا يكفي لـ' + what + ' بمبلغ ' + fmt(amountHalalas));
  }
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
