/**
 * المطالبات · التسجيل يرحّل (1250/4300)، والتحصيل يقفلها (1100/1250).
 */
import { t } from '../i18n';
import type { DB } from '../db/adapter';
import { uid } from './ids';
import { today } from './dates';
import { postClaim, postClaimCollection, reverseEntryBySource } from './accounting/post';
import { logAudit } from './audit';
import { correctionDate } from './vatFilings';
import { propertyMoveLocked, type Access } from './access/access';

export interface ClaimInput {
  contractId: string;
  amountHalalas: number;
  reason: string;
  date: string;
}

/** access: صلاحية من يعدّل · المحصور لا ينقل مطالبةً قائمة إلى عقد عقارٍ آخر (قرار المالك 2026-10-09 · التحقق المستقل) */
export function saveClaim(db: DB, input: ClaimInput, existingId?: string, opts: { access?: Access } = {}): string {
  if (!input.contractId || !input.amountHalalas) throw new Error('اختر العقد وأدخل المبلغ');
  return db.transaction(() => {
    if (existingId) {
      if (opts.access && propertyMoveLocked(opts.access, true)) {
        const propOf = (contractId: string) => db.get<{ p: string }>(
          `SELECT u.property_id AS p FROM contracts c JOIN units u ON u.id = c.unit_id WHERE c.id = ?`, [contractId])?.p ?? null;
        const cur = db.get<{ c: string }>(`SELECT contract_id AS c FROM claims WHERE id = ?`, [existingId])?.c;
        if (cur && propOf(cur) !== propOf(input.contractId)) throw new Error(t('access.moveAllPropsOnly'));
      }
      const cl = db.get<{ amount_halalas: number; status: string; date: string }>(
        `SELECT amount_halalas, status, date FROM claims WHERE id = ?`, [existingId]
      );
      if (!cl) throw new Error('تعذّر العثور على المطالبة');
      // المحصَّلة قيداها مرحّلان: مبلغها وتاريخها وعقدها كما هي، ويُعدَّل سببها وحده (مراجعة التثبيت #22)
      if (cl.status !== 'مفتوحة') { // i18n-exempt: حالة مخزّنة
        const cur = db.get<{ contract_id: string }>(`SELECT contract_id FROM claims WHERE id = ?`, [existingId])!;
        if (Number(cl.amount_halalas) !== input.amountHalalas || cl.date !== input.date || cur.contract_id !== input.contractId) {
          throw new Error(t('claims.collectedLocked'));
        }
      }
      const prevContract = db.get<{ contract_id: string }>(`SELECT contract_id FROM claims WHERE id = ?`, [existingId])!.contract_id;
      db.run(
        `UPDATE claims SET contract_id=?, amount_halalas=?, reason=?, date=? WHERE id = ?`,
        [input.contractId, input.amountHalalas, input.reason.trim(), input.date, existingId]
      );
      // تعديل مطالبة مفتوحة بمبلغ أو تاريخ أو عقد مختلف: عكس القيد القديم بأبعاده وترحيل الجديد بتاريخه (المراجعة ٤.١٧)
      // بعد تحديثها، فتُشتق أبعاده من عقدها الجديد (#34)
      if (cl.status === 'مفتوحة' && (Number(cl.amount_halalas) !== input.amountHalalas || cl.date !== input.date // i18n-exempt: حالة مخزّنة
        || prevContract !== input.contractId)) {
        reverseEntryBySource(db, 'claim', existingId, 'تعديل مطالبة · عكس القيد السابق');
        // قيد القيم الجديدة قيدُ تصحيح: بتاريخ المطالبة، إلا في فترةٍ قُدِّم إقرارها فاليوم كعكسه (#29)
        postClaim(db, { id: existingId, amount: input.amountHalalas, reason: input.reason, date: correctionDate(db, input.date) });
      }
      logAudit(db, 'المطالبات', 'update', 'مطالبة', input.reason || existingId);
      return existingId;
    }
    const id = uid();
    db.run(
      `INSERT INTO claims (id, contract_id, amount_halalas, reason, date, status, source, created_at)
       VALUES (?,?,?,?,?,'مفتوحة','يدوية',?)`,
      [id, input.contractId, input.amountHalalas, input.reason.trim(), input.date, new Date().toISOString()]
    );
    postClaim(db, { id, amount: input.amountHalalas, reason: input.reason, date: input.date });
    logAudit(db, 'المطالبات', 'create', 'مطالبة', input.reason || id);
    return id;
  });
}

/** تحصيل مطالبة مفتوحة */
export function collectClaim(db: DB, id: string, date: string = today()): void {
  db.transaction(() => {
    const cl = db.get<{ amount_halalas: number; reason: string; status: string }>(
      `SELECT amount_halalas, reason, status FROM claims WHERE id = ?`, [id]
    );
    if (!cl || cl.status !== 'مفتوحة') throw new Error('المطالبة غير مفتوحة');
    postClaimCollection(db, { id, amount: Number(cl.amount_halalas), reason: cl.reason }, date);
    db.run(`UPDATE claims SET status = 'محصَّلة', collected_at = ? WHERE id = ?`, [date, id]);
    logAudit(db, 'المطالبات', 'update', 'تحصيل مطالبة', cl.reason || id);
  });
}

/** حذف ناعم · المطالبة المفتوحة يُعكس قيدها ليبقى رصيد 1250 مطابقاً للمفتوح */
export function deleteClaim(db: DB, id: string): void {
  db.transaction(() => {
    const cl = db.get<{ reason: string; status: string }>(
      `SELECT reason, status FROM claims WHERE id = ?`, [id]
    );
    if (!cl) return;
    // المحصَّلة لا تُحذف: تعلّقت بها مبالغ مرحّلة (القاعدة ٩٠ · مراجعة التثبيت #22)
    if (cl.status !== 'مفتوحة') throw new Error(t('claims.collectedNoDelete')); // i18n-exempt: حالة مخزّنة
    reverseEntryBySource(db, 'claim', id, 'حذف مطالبة · عكس قيدها');
    db.run(`UPDATE claims SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    logAudit(db, 'المطالبات', 'delete', 'مطالبة', cl.reason || id);
  });
}
