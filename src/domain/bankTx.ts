/**
 * الحركات البنكية · اليدوية وحدها تُحذف إلى السلة. المرتبطة بقيد (journal_no) أثرٌ لعملية في الدفتر،
 * فحذفها يفصل البنك عن الدفتر (المراجعة ٤.٦) · تُلغى بإلغاء عمليتها فتقابلها حركة معاكسة.
 */
import type { DB } from '../db/adapter';
import { logAudit } from './audit';

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
  db.transaction(() => {
    const t = db.get<{ descr: string }>(`SELECT descr FROM bank_tx WHERE id = ?`, [id]);
    db.run(`UPDATE bank_tx SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    if (t) logAudit(db, 'الحركات البنكية', 'delete', 'حركة بنكية', t.descr);
  });
}
