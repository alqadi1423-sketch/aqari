/**
 * عكس قيد من شاشة الدفتر · للقيد اليدوي وحده.
 *
 * القيد الآلي ابنُ مستنده: قيد الدفعة مربوطٌ بمسدَّد قسطها، وقيد التأمين برصيد التأمينات، وقيد
 * المطالبة بذممها، وقيد الفاتورة بفاتورتها. وعكسه من الدفتر وحده يُبقي المستند كما هو ويلغي أثره
 * في الأرصدة · فيصير المسدَّد على القسط أكثر من نقد الدفتر، أو التأمينات خلاف المحتجز فعلاً.
 * وجده اختبار الثوابت العشوائي (tests/fuzz.test.ts) · فيُرفض هنا بسببه، ويُلغى القيد الآلي من مستنده.
 */
import type { DB } from '../../db/adapter';
import { RuleViolation } from '../contracts/service';
import { reverseEntryById, type PostedEntry } from './post';

/** سبب منع عكس القيد من الدفتر · فارغ إن جاز */
export function journalReversalBlock(db: DB, entryId: string): string {
  const e = db.get<{ auto: number; src_type: string | null }>(
    `SELECT auto, src_type FROM journal_entries WHERE id = ?`, [entryId]);
  if (!e) return '';
  const paid = db.get(`SELECT 1 FROM contract_payments WHERE journal_entry_id = ? LIMIT 1`, [entryId]);
  if (paid) return 'قيد دفعة إيجار مربوط بمسدَّد قسطها · عكسه من الدفتر وحده يترك القسط مسدَّداً بلا نقد يقابله';
  if (Number(e.auto) === 1 && e.src_type) {
    return 'قيد آلي من مستنده · عكسه من الدفتر وحده يترك المستند قائماً بلا أثر في الأرصدة، فيُلغى من المستند نفسه';
  }
  return '';
}

/** العكس من شاشة الدفتر · يرمي سبباً عربياً للقيد الآلي ويعكس اليدوي */
export function reverseFromJournal(db: DB, entryId: string): PostedEntry | null {
  const why = journalReversalBlock(db, entryId);
  if (why) throw new RuleViolation(why);
  return reverseEntryById(db, entryId);
}
