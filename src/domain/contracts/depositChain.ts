/**
 * سلسلة التأمين المرحَّل (المراجعة الشاملة 2026-11-13 · R12-DEP-2): التأمين المرحَّل في التجديد هو تأمين العقد السابق نفسه، والسابق لا
 * يُسوّى بعد ترحيله (depositCarried) · فما بقي من أقساط السابق متأخراً يُسدَّد من التأمين حين يُسوّى في العقد الذي يحمله الآن (قرار
 * المالك س١: «يُسدَّد به القسط نفسه») · والسلسلة: العقد نفسه، ثم سابقه ما دام قيد deposit_carry إليه حيّاً، ثم سابق سابقه كذلك.
 */
import type { DB } from '../../db/adapter';

/** حدّ السلسلة: التجديد لانهائي، والدورة في بياناتٍ تالفة لا تُعلّق الحساب */
const MAX_CHAIN = 100;
const POSTED = 'مرحّل'; // i18n-exempt: حالة القيد المخزّنة

/** معرّفات العقد ومن رُحِّل تأمينه إليه بترحيلٍ حيّ هنا، الأقرب أولاً */
export function depositCarryChain(db: DB, contractId: string): string[] {
  const ids = [contractId];
  let cur = contractId;
  for (let i = 0; i < MAX_CHAIN; i++) {
    const prev = db.get<{ p: string | null }>(`SELECT renewed_from AS p FROM contracts WHERE id = ?`, [cur])?.p;
    if (!prev || ids.includes(prev)) break;
    const carried = db.get(
      `SELECT 1 FROM journal_entries WHERE src_type = 'deposit_carry' AND src_id = ? AND reversed_by IS NULL AND deleted_at IS NULL
         AND status = ? LIMIT 1`, [cur, POSTED]);
    if (!carried) break;
    ids.push(prev);
    cur = prev;
  }
  return ids;
}
