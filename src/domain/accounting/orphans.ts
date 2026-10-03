/**
 * قيد بلا مستند · القيد المرحّل لا يُحذف (التصميم ٤)، فإن غاب مستنده بقي هو ويُراجَع:
 *  - بالاستعادة: قيدٌ رُحّل بعد تاريخ النسخة ومستنده ليس فيها، أو فيها بحاله قبل القيد (keepPosted.ts).
 *  - بالمزامنة: قيدٌ وصل من جهاز آخر ومستنده حذفته استعادةٌ على جهاز ثالث.
 *
 * العلامة سطرٌ في سجل العمليات لا إعدادٌ على الجهاز: السجل يُزامَن ولا يُعدَّل، فيرى القائمةَ نفسها
 * كلُّ جهاز على الحساب. والقيد المعلَّم (وعكسه إن عُكس) خارج فحوص مطابقة الدفتر بالمستندات
 * (integrity.ts) لأنه لا مستند له يطابقه · فلا يمنع النسخ الاحتياطي، ويبقى ظاهراً في أداة المراجعة
 * حتى يُعكس أو يُعلَّم «تمّت مراجعته».
 */
import type { DB } from '../../db/adapter';
import { logAudit } from '../audit';

export const KEPT_REVIEW_ENTITY = 'قيد بلا مستند بعد الاستعادة';
export const KEPT_REVIEWED_ENTITY = 'مراجعة قيد بعد الاستعادة';

/** نوع المستند وجدوله · ومعرّف المستند في src_id */
export const SOURCE_DOC: Record<string, [label: string, tables: string[]]> = {
  invoice: ['فاتورة', ['invoices']],
  purchase: ['فاتورة شراء', ['purchases']],
  purchase_pay: ['سداد فاتورة شراء', ['purchases']],
  vat_refund: ['استرداد ضريبة', ['purchases']],
  claim: ['مطالبة', ['claims']],
  claim_collect: ['تحصيل مطالبة', ['claims']],
  contract_deposit: ['تأمين عقد', ['contracts']],
  deposit_refund: ['ردّ تأمين', ['contracts']],
  deposit_carry: ['ترحيل تأمين', ['contracts']],
  deposit_deduct: ['خصم من التأمين', ['contracts']],
  deposit_deduct_move: ['خصم من التأمين', ['contracts']],
  reservation: ['حجز', ['reservations']],
  reservation_convert: ['تحويل حجز', ['reservations']],
  reservation_forfeit: ['مصادرة حجز', ['reservations']],
  key_money: ['تقبيل', ['key_money_deals']],
  surplus_refund: ['ردّ فائض', ['contracts']],
  surplus_credit: ['فائض رصيداً', ['contracts']],
  discount: ['خصم', ['contract_payments', 'contract_installments']],
  rent: ['دفعة إيجار', []],
};

/** شرط SQL: القيد (بالاسم e) مستنده غائب · قيد الدفعة بدفعته، وغيره بجدول مستنده */
function orphanSql(): string {
  const parts = [`(e.src_type = 'rent' AND NOT EXISTS (SELECT 1 FROM contract_payments p WHERE p.journal_entry_id = e.id))`];
  for (const [type, [, tables]] of Object.entries(SOURCE_DOC)) {
    if (!tables.length) continue;
    parts.push(`(e.src_type = '${type}' AND ${tables.map((t) => `NOT EXISTS (SELECT 1 FROM "${t}" x WHERE x.id = e.src_id)`).join(' AND ')})`);
  }
  return '(' + parts.join(' OR ') + ')';
}

const MARKED = (alias: string) =>
  `EXISTS (SELECT 1 FROM audit_log a WHERE a.entity_type = '${KEPT_REVIEW_ENTITY}' AND json_extract(a.after_json, '$.id') = ${alias}.id)`;

/** القيود المعلَّمة وعكوسها · خارج مطابقة الدفتر بالمستندات */
export const MARKED_OR_ITS_REVERSAL = (alias: string) =>
  `(${MARKED(alias)} OR EXISTS (SELECT 1 FROM journal_entries o WHERE o.reversed_by = ${alias}.id AND ${MARKED('o')}))`;

/** صافي حساب (مدين موجب) في القيود المعلَّمة وعكوسها · يُطرح من رصيد الدفتر قبل مطابقته بالمستندات */
export function markedNetOn(db: DB, account: string): number {
  return Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas), 0) AS s
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_code = ? AND e.status = 'مرحّل' AND e.deleted_at IS NULL AND ${MARKED_OR_ITS_REVERSAL('e')}`, [account])!.s);
}

/** قيود مرحّلة قائمة الأثر مستندها غائب ولم تُعلَّم بعد */
export function unmarkedOrphans(db: DB): Array<{ id: string; no: string; src_type: string }> {
  return db.all(
    `SELECT e.id, e.no, e.src_type FROM journal_entries e
     WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL AND e.auto = 1 AND e.reversed_by IS NULL
       AND e.src_type IS NOT NULL AND e.src_type NOT LIKE '%\\_rev' ESCAPE '\\'
       AND ${orphanSql()} AND NOT ${MARKED('e')}
     ORDER BY e.date, e.no`);
}

/** القيد غائب المستند؟ · لعكسه من الدفتر حين لا مستند يُلغى منه */
export function isOrphanEntry(db: DB, entryId: string): boolean {
  return !!db.get(`SELECT 1 FROM journal_entries e WHERE e.id = ? AND e.src_type IS NOT NULL AND ${orphanSql()}`, [entryId]);
}

export function markForReview(db: DB, entry: { id: string; no: string }, reason: string): void {
  logAudit(db, 'النسخ الاحتياطي', 'create', KEPT_REVIEW_ENTITY, entry.no, undefined, { id: entry.id, no: entry.no, reason });
}

/** تعليم ما غاب مستنده · بعد اكتمال تطبيق الوارد · يعيد عدد ما عُلِّم */
export function markOrphans(db: DB, how: string): number {
  const found = unmarkedOrphans(db);
  for (const e of found) {
    const label = SOURCE_DOC[e.src_type]?.[0] ?? e.src_type;
    markForReview(db, e, `قيد ${label} ${how} ومستنده ليس في البيانات`);
  }
  return found.length;
}

export interface KeptReviewItem { id: string; no: string; reason: string }

/** أداة المراجعة: ما عُلِّم ولم يُعكس ولم يُراجَع */
export function keptForReview(db: DB): KeptReviewItem[] {
  return db.all<KeptReviewItem>(
    `SELECT e.id, e.no, MAX(json_extract(a.after_json, '$.reason')) AS reason
     FROM audit_log a JOIN journal_entries e ON e.id = json_extract(a.after_json, '$.id')
     WHERE a.entity_type = ? AND e.reversed_by IS NULL AND e.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM audit_log d WHERE d.entity_type = ? AND json_extract(d.after_json, '$.id') = e.id)
     GROUP BY e.id ORDER BY e.date, e.no`, [KEPT_REVIEW_ENTITY, KEPT_REVIEWED_ENTITY]);
}

/** «تمّت مراجعته» · بقرار المستخدم · يبقى القيد خارج المطابقة لأن مستنده غائب */
export function dismissKeptReview(db: DB, id: string): void {
  const e = db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ?`, [id]);
  logAudit(db, 'النسخ الاحتياطي', 'update', KEPT_REVIEWED_ENTITY, e?.no ?? id, undefined, { id });
}
