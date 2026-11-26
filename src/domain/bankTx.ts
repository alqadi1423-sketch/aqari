/**
 * الحركات البنكية · اليدوية وحدها تُحذف إلى السلة. المرتبطة بقيد (journal_no) أثرٌ لعملية في الدفتر،
 * فحذفها يفصل البنك عن الدفتر (المراجعة ٤.٦) · تُلغى بإلغاء عمليتها فتقابلها حركة معاكسة.
 */
import type { DB } from '../db/adapter';
import { logAudit } from './audit';
import { requireCash, requireBankFunds } from './cashGuard';
import { fmt } from './money';
import { t } from '../i18n';

/** رقم القيد الذي تتبعه الحركة إن كانت مرتبطة بقيد قائم */
export function bankTxEntryNo(db: DB, id: string): string | null {
  const t = db.get<{ journal_no: string | null }>(`SELECT journal_no FROM bank_tx WHERE id = ?`, [id]);
  const no = (t?.journal_no || '').trim();
  if (!no) return null;
  return db.get(`SELECT 1 FROM journal_entries WHERE no = ?`, [no]) ? no : null;
}

export function deleteBankTx(db: DB, id: string): void {
  const no = bankTxEntryNo(db, id);
  if (no) throw new Error('الحركة مرتبطة بالقيد ' + no + ' · تُلغى بإلغاء عمليتها لا بحذفها');
  // الحركة بلا قيد تحويلٌ بين المحفظة والبنك: حذف الصادر منها يُنقص المحفظة، وحذف الوارد يُنقص البنك · ولا يصير أحدهما
  // سالباً (#33 · قرار المالك 2026-10-05)
  // وبتاريخ الحركة: أثر حذفها يبدأ يومها، فيكفيه أدنى رصيد المحفظة أو البنك منه فما بعده (قرار المالك س١٩ · A2.8: العكس والإلغاء)
  const tx = db.get<{ amount_halalas: number; bank_id: string; date: string | null }>(
    `SELECT amount_halalas, bank_id, date FROM bank_tx WHERE id = ? AND deleted_at IS NULL`, [id]);
  if (tx) {
    const amt = Number(tx.amount_halalas);
    if (amt < 0) requireCash(db, -amt, t('bankTx.deleteWhat', { lng: 'ar' }), tx.date);
    if (amt > 0) requireBankFunds(db, tx.bank_id, amt, tx.date, (_b, balance) => t('bankTx.deleteBankShort', { balance: fmt(balance), amount: fmt(amt) }));
  }
  db.transaction(() => {
    const t = db.get<{ descr: string }>(`SELECT descr FROM bank_tx WHERE id = ?`, [id]);
    db.run(`UPDATE bank_tx SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    // وسطر الكشف المطابَق بها يعود مفتوحاً، فلا يبقى «مطابَقاً» بحركةٍ في السلة (المدقق الخارجي U١٩)
    db.run(`UPDATE bank_statement_lines SET bank_tx_id = NULL, status = 'open', matched_at = NULL WHERE bank_tx_id = ?`, [id]);
    if (t) logAudit(db, 'الحركات البنكية', 'delete', 'حركة بنكية', t.descr);
  });
}

/**
 * استعادة حركةٍ بلا قيدٍ قائم من السلة عكسُ حذفها (المدقق الخارجي G٤): استعادة الوارد تُنقص المحفظة، واستعادة الصادر تُنقص البنك ·
 * ولا يصير أحدهما سالباً، كما في deleteBankTx
 */
export function requireBankTxRestorable(db: DB, id: string): void {
  if (bankTxEntryNo(db, id)) return;
  // وبتاريخ الحركة كحذفها (A2.8)
  const tx = db.get<{ amount_halalas: number; bank_id: string; date: string | null }>(
    `SELECT amount_halalas, bank_id, date FROM bank_tx WHERE id = ? AND deleted_at IS NOT NULL`, [id]);
  if (!tx) return;
  const amt = Number(tx.amount_halalas);
  if (amt > 0) requireCash(db, amt, t('bankTx.restoreWhat', { lng: 'ar' }), tx.date);
  if (amt < 0) requireBankFunds(db, tx.bank_id, -amt, tx.date, (_b, balance) => t('bankTx.restoreBankShort', { balance: fmt(balance), amount: fmt(-amt) }));
}
