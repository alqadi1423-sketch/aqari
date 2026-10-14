/**
 * المرآة الحقيقية (المراجعة الخارجية ٧ · النتيجة ١ · قرار المالك «رابعاً ١ (أ)» 2026-10-10: «والعكس لا يُربط إلا بمرآة حقيقية»):
 * عاكس القيد مرحّلٌ، ومصدره «_rev» أصله ومعرّف مصدره، وسطوره تقابل سطور الأصل واحداً بواحد بمبالغها مقلوبةً ·
 * والاستثناء الوحيد عكس قيد سنةٍ سابقة: سطر الإيراد أو المصروف فيه على الأرباح المحتجزة 3200 (assets/convert.ts) ·
 * القواعد في السحابة تفحص عدد السطور والمجموع وحدهما (مطابقة السطور فيها مؤجلة إلى دالة الخادم «ج١») فيفحصها جهاز المالك هنا.
 */
import type { DB } from '../../db/adapter';
import { t } from '../../i18n';

const ACC_RETAINED = '3200';
type Line = { account_code: string; debit_halalas: number; credit_halalas: number; type: string | null };

const linesOf = (db: DB, id: string) => db.all<Line>(
  `SELECT l.account_code, l.debit_halalas, l.credit_halalas, a.type FROM journal_lines l
   LEFT JOIN accounts a ON a.code = l.account_code WHERE l.entry_id = ? ORDER BY l.rowid`, [id]);

const isIncome = (type: string | null) => type === 'إيراد' || type === 'مصروف'; // i18n-exempt: نوع حساب مخزَّن

/** سبب أن revId ليس مرآةً حقيقية لـ entryId (بالعربية كأسباب الرفض المخزّنة) · فارغ إن كان */
export function mirrorIssue(db: DB, entryId: string, revId: string): string {
  const o = db.get<{ src_type: string | null; src_id: string | null }>(`SELECT src_type, src_id FROM journal_entries WHERE id = ?`, [entryId]);
  const r = db.get<{ status: string; src_type: string | null; src_id: string | null; deleted_at: string | null }>(
    `SELECT status, src_type, src_id, deleted_at FROM journal_entries WHERE id = ?`, [revId]);
  if (!o || !r) return t('mirror.missing', { lng: 'ar' });
  if (r.status !== 'مرحّل' || r.deleted_at) return t('mirror.notPosted', { lng: 'ar' }); // i18n-exempt: حالة القيد المخزّنة
  if (r.src_type !== (o.src_type ?? 'manual') + '_rev' || r.src_id !== (o.src_id ?? entryId)) return t('mirror.source', { lng: 'ar' });
  const orig = linesOf(db, entryId);
  const rev = linesOf(db, revId);
  if (!orig.length || orig.length !== rev.length) return t('mirror.count', { lng: 'ar' });
  const used = new Set<number>();
  for (const l of rev) {
    const i = orig.findIndex((x, j) => !used.has(j)
      && Number(x.debit_halalas) === Number(l.credit_halalas) && Number(x.credit_halalas) === Number(l.debit_halalas)
      && (x.account_code === l.account_code || (l.account_code === ACC_RETAINED && isIncome(x.type))));
    if (i < 0) return t('mirror.line', { lng: 'ar' });
    used.add(i);
  }
  return '';
}
