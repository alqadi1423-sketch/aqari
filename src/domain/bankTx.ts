/**
 * الحركات البنكية · اليدوية وحدها تُحذف إلى السلة. المرتبطة بقيد (journal_no) أثرٌ لعملية في الدفتر،
 * فحذفها يفصل البنك عن الدفتر (المراجعة ٤.٦) · تُلغى بإلغاء عمليتها فتقابلها حركة معاكسة.
 */
import type { DB } from '../db/adapter';
import { logAudit } from './audit';
import { requireCash } from './cashGuard';
import { bankBalance } from './accounting/ledger';
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
  const tx = db.get<{ amount_halalas: number; bank_id: string }>(`SELECT amount_halalas, bank_id FROM bank_tx WHERE id = ? AND deleted_at IS NULL`, [id]);
  if (tx) {
    const amt = Number(tx.amount_halalas);
    if (amt < 0) requireCash(db, -amt, t('bankTx.deleteWhat', { lng: 'ar' }));
    if (amt > 0 && amt > bankBalance(db, tx.bank_id)) throw new Error(t('bankTx.deleteBankShort', { balance: fmt(bankBalance(db, tx.bank_id)), amount: fmt(amt) }));
  }
  db.transaction(() => {
    const t = db.get<{ descr: string }>(`SELECT descr FROM bank_tx WHERE id = ?`, [id]);
    db.run(`UPDATE bank_tx SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    if (t) logAudit(db, 'الحركات البنكية', 'delete', 'حركة بنكية', t.descr);
  });
}
