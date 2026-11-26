/**
 * عكس قيد من شاشة الدفتر · للقيد اليدوي وحده.
 *
 * القيد الآلي ابنُ مستنده: قيد الدفعة مربوطٌ بمسدَّد قسطها، وقيد التأمين برصيد التأمينات، وقيد
 * المطالبة بذممها، وقيد الفاتورة بفاتورتها. وعكسه من الدفتر وحده يُبقي المستند كما هو ويلغي أثره
 * في الأرصدة · فيصير المسدَّد على القسط أكثر من نقد الدفتر، أو التأمينات خلاف المحتجز فعلاً.
 * وجده اختبار الثوابت العشوائي (tests/fuzz.test.ts) · فيُرفض هنا بسببه، ويُلغى القيد الآلي من مستنده.
 */
import type { DB } from '../../db/adapter';
import { requireCash, reversalCashOut, requireBanksCover } from '../cashGuard';
import { uid } from '../ids';
import { t } from '../../i18n';
import { RuleViolation } from '../contracts/service';
import { reverseEntryById, type PostedEntry } from './post';
import { correctionDate } from '../vatFilings';

/** سبب منع عكس القيد من الدفتر · فارغ إن جاز */
export function journalReversalBlock(db: DB, entryId: string): string {
  const e = db.get<{ auto: number; src_type: string | null }>(
    `SELECT auto, src_type FROM journal_entries WHERE id = ?`, [entryId]);
  if (!e) return '';
  // تشمل الملغاة: قيد الدفعة يُعكس من شاشة الدفعة وحدها، ملغاةً كانت أو حيّة
  const paid = db.get(`SELECT 1 FROM contract_payments WHERE journal_entry_id = ? LIMIT 1 /* تشمل الملغاة: ربط القيد بمستنده */`, [entryId]);
  if (paid) return 'قيد دفعة إيجار مربوط بمسدَّد قسطها · عكسه من الدفتر وحده يترك القسط مسدَّداً بلا نقد يقابله';
  if (Number(e.auto) === 1 && e.src_type) {
    return 'قيد آلي من مستنده · عكسه من الدفتر وحده يترك المستند قائماً بلا أثر في الأرصدة، فيُلغى من المستند نفسه';
  }
  return '';
}

/**
 * التاريخ الذي سيُكتب به العكس · الدالة نفسها التي يكتب بها reverseEntryById: تاريخ الأصل، إلا إن قُدِّم إقرار
 * فترته فاليوم المفتوح · فيقوله الحوار قبل التأكيد ولا يقول «اليوم» وهو يكتب شهراً مضى (D-7)
 */
export function journalReversalDate(db: DB, entryId: string): string {
  const d = db.get<{ date: string }>(`SELECT date FROM journal_entries WHERE id = ?`, [entryId])?.date;
  return correctionDate(db, d);
}

/** العكس من شاشة الدفتر · يرمي سبباً عربياً للقيد الآلي ويعكس اليدوي */
export function reverseFromJournal(db: DB, entryId: string): PostedEntry | null {
  const why = journalReversalBlock(db, entryId);
  if (why) throw new RuleViolation(why);
  // بأدنى رصيد المحفظة من تاريخ العاكس فما بعده: عكس قيدٍ أدخل نقداً بتاريخه لا يجعلها سالبةً في يومٍ مضى (قرار المالك س١٩ · A2.8)
  const on = journalReversalDate(db, entryId);
  requireCash(db, reversalCashOut(db, entryId), 'عكس القيد', on);
  // وحركة البنك المربوطة بالقيد اليدوي (خانة البنك · A2.10) تُعكس بمثلها، ولا يُنزل عكسُها البنك تحت الصفر في يومٍ مضى
  const no = db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ?`, [entryId])?.no ?? '';
  requireBanksCover(db, no, 'reverse', on);
  return db.transaction(() => {
    const rev = reverseEntryById(db, entryId);
    if (rev) {
      const revDate = db.get<{ d: string }>(`SELECT date AS d FROM journal_entries WHERE id = ?`, [rev.id])!.d;
      for (const x of db.all<{ bank_id: string; amount: number }>(
        `SELECT bank_id, amount_halalas AS amount FROM bank_tx WHERE journal_no = ? AND deleted_at IS NULL`, [no])) {
        db.run(`INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at) VALUES (?,?,?,?,?,1,?,?,?)`,
          [uid(), x.bank_id, revDate, t('journal.manualBankReversed', { no, lng: 'ar' }), -Number(x.amount), rev.no,
            t('journal.manualBankSource', { lng: 'ar' }), new Date().toISOString()]);
      }
    }
    return rev;
  });
}
