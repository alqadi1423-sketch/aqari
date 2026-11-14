/**
 * سلة المحذوفات · قائمة موحّدة فوق الحذف الناعم، مدتها من الإعدادات (٣٠/٦٠/٩٠).
 */
import type { DB } from '../db/adapter';
import { allIn, runIn } from '../db/inList';
import { entryCashEffect } from './cashGuard';
import { getSetting } from '../repos/settings';
import { restoreInvoice } from './invoices';
import { restorePurchase } from './purchases';
import { requireBankTxRestorable } from './bankTx';
import { logAudit } from './audit';
import { t } from '../i18n';
import { lastReversedOf, repostBlockers, repostCopy, repostDate } from './accounting/repost';
import { isFiledDate } from './vatFilings';

export const TRASH_ENTITY_LABELS: Record<string, string> = {
  suppliers: 'مورد', tenants: 'مستأجر', contracts: 'عقد إيجار',
  banks: 'حساب بنكي', properties: 'عقار', units: 'وحدة', purchases: 'فاتورة شراء',
  invoices: 'فاتورة بيع', bank_tx: 'حركة بنكية', accounts: 'حساب محاسبي',
  journal_entries: 'قيد يومية', message_scripts: 'قالب رسالة', handovers: 'نموذج استلام/تسليم',
  claims: 'مطالبة', reservations: 'حجز', key_money_deals: 'تقبيل',
  attachments: 'ملف', company_docs: 'مستند منشأة', form_templates: 'قالب نموذج',
};

/** الجداول المشمولة بالسلة وعمود تسمية العنصر في كل منها */
const TRASH_TABLES: Array<{ table: string; labelExpr: string }> = [
  { table: 'tenants', labelExpr: 'name' },
  { table: 'suppliers', labelExpr: 'name' },
  { table: 'contracts', labelExpr: `tenant_name || ' · ' || unit_label` },
  { table: 'banks', labelExpr: 'name' },
  { table: 'properties', labelExpr: 'name' },
  { table: 'units', labelExpr: 'unit_no' },
  { table: 'purchases', labelExpr: `no || ' · ' || supplier_name` },
  { table: 'invoices', labelExpr: `no || ' · ' || customer_name` },
  { table: 'bank_tx', labelExpr: 'descr' },
  { table: 'accounts', labelExpr: 'name' },
  { table: 'journal_entries', labelExpr: 'memo' },
  { table: 'message_scripts', labelExpr: 'title' },
  { table: 'handovers', labelExpr: `type || ' · ' || tenant_name` },
  { table: 'claims', labelExpr: 'reason' },
  { table: 'reservations', labelExpr: 'name' },
  { table: 'key_money_deals', labelExpr: `outgoing || ' ← ' || incoming` },
  { table: 'attachments', labelExpr: `COALESCE(NULLIF(display_name,''), original_name)` },
  { table: 'company_docs', labelExpr: 'name' },
  { table: 'form_templates', labelExpr: 'name' },
];

export interface TrashItem {
  table: string;
  id: string;
  label: string;
  entityLabel: string;
  deletedAt: string;
  daysLeft: number;
}

export function trashItems(db: DB, now: Date = new Date()): TrashItem[] {
  const retention = getSetting(db, 'trashRetention');
  const out: TrashItem[] = [];
  for (const t of TRASH_TABLES) {
    const pk = t.table === 'accounts' ? 'code' : 'id';
    // القيد المرحّل لا يُحذف ولا يُستعاد من السلة · ما بقي فيها من إصدار سابق لا يُعرض فلا يُعرض له زر
    const onlyDrafts = t.table === 'journal_entries' ? ` AND status != 'مرحّل'` : '';
    const rows = db.all<{ id: string; label: string; deleted_at: string }>(
      `SELECT ${pk} AS id, COALESCE(${t.labelExpr}, '') AS label, deleted_at
       FROM "${t.table}" WHERE deleted_at IS NOT NULL${onlyDrafts}`
    );
    for (const r of rows) {
      const elapsed = now.getTime() - new Date(r.deleted_at).getTime();
      out.push({
        table: t.table,
        id: r.id,
        label: r.label || r.id,
        entityLabel: TRASH_ENTITY_LABELS[t.table] || t.table,
        deletedAt: r.deleted_at,
        daysLeft: Math.max(0, retention - Math.floor(elapsed / 86400000)),
      });
    }
  }
  return out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
}

/**
 * قيدٌ عكسه الحذف ويُعاد بنسخته مع الاستعادة (المراجعة ٤.٦) · المطالبة المفتوحة وحدها عُكس قيدها عند حذفها،
 * وصفقة التقبيل تدخل السلة بإلغاء قيد عمولتها. وغير هذه لا أثر لحذفها في الدفتر فتُستعاد كما هي.
 */
function reversedOnDelete(db: DB, table: string, id: string): string | null {
  if (table === 'claims') {
    const st = db.get<{ status: string }>(`SELECT status FROM claims WHERE id = ?`, [id])?.status;
    return st === 'مفتوحة' ? lastReversedOf(db, 'claim', id) : null;
  }
  if (table === 'key_money_deals') return lastReversedOf(db, 'key_money', id);
  return null;
}

/**
 * استعادةٌ تكتب قيداً في فترةٍ قُدِّم إقرارها (المراجعة الشاملة ٨ · البند ١١ · التحقق المستقل): صفقة التقبيل تُستعاد بنسخة قيد
 * عمولتها بتاريخ عكسه (repostDate)، فإن قُدِّم إقرار فترته بعد الإلغاء تغيّر بها البند ١ لإقرارٍ مقدَّم (وسطر 2200 فيه) ·
 * فتُرفض كما تُرفض استعادة فاتورة الشراء إلى فترةٍ مقدَّمة، ولا يظهر زرّها. وتصحيحها تقبيلٌ جديد بتاريخٍ في فترةٍ مفتوحة.
 * وتُرفض ولو بلا سطر 2200 (منشأة غير مسجّلة يومها، أو قيدٌ قبل هذا الإصلاح): العمولة عمليةٌ نقدية، ولا عملية نقدية في فترةٍ
 * قُدِّم إقرارها (قرار المالك 2026-10-15 «٦»)، والتسجيل يُقرأ اليوم وقد تكون الفترة المقدَّمة من زمنٍ كانت فيه مسجّلة.
 */
export function restoreIntoFiledPeriod(db: DB, table: string, id: string): boolean {
  if (table !== 'key_money_deals') return false;
  const entry = lastReversedOf(db, 'key_money', id);
  return !!entry && isFiledDate(db, repostDate(db, entry));
}

function restoreOne(db: DB, table: string, id: string): void {
  if (table === 'invoices') { restoreInvoice(db, id); return; }
  if (table === 'purchases') { restorePurchase(db, id); return; }
  if (table === 'bank_tx') requireBankTxRestorable(db, id);
  if (restoreIntoFiledPeriod(db, table, id)) throw new Error(t('restore.filedPeriod'));
  const entry = reversedOnDelete(db, table, id);
  if (entry) {
    const blockers = repostBlockers(db, entry);
    if (blockers.length) throw new Error('لا يُستعاد العنصر: ' + blockers.join('، '));
  }
  const pk = table === 'accounts' ? 'code' : 'id';
  // الحي لا «يُستعاد» فيُعاد ترحيل قيده (المراجعة الخارجية ٧ · النتيجة ٤)
  if (!db.get(`SELECT 1 FROM "${table}" WHERE ${pk} = ? AND deleted_at IS NOT NULL`, [id])) throw new Error(t('restore.notInTrash'));
  db.run(`UPDATE "${table}" SET deleted_at = NULL WHERE ${pk} = ?`, [id]);
  if (!entry) return;
  const copy = repostCopy(db, entry, 'استعادة من السلة');
  // والصفقة تسمّي قيدها الحيّ (المدقق الخارجي ك١: كانت تبقى تسمّي القيد المعكوس، فيرفض جهاز المالك نسخة العضو رفضاً نهائياً، وفي
  // دفتر العضو إيرادٌ ونقدٌ ليسا عند المالك)
  if (copy && table === 'key_money_deals') db.run(`UPDATE key_money_deals SET journal_entry_id = ? WHERE id = ?`, [copy.id, id]);
}

/**
 * ما تُخرجه الاستعادة من المحفظة · فاتورة شراءٍ سُدّدت نقداً يُعاد سدادها، وغيرها لا يُخرج نقداً
 * (التحصيل والعمولة يُدخلانه). لزرّ الاستعادة حين لا يكفي النقد (قرار المالك ٢٠٢٦-١٠-٠٥).
 */
export function restoreCashOut(db: DB, table: string, id: string): number {
  if (table !== 'purchases') return 0;
  const p = db.get<{ paid: number; pj: string | null }>(`SELECT paid, payment_journal_entry_id AS pj FROM purchases WHERE id = ?`, [id]);
  if (!p || !Number(p.paid) || !p.pj) return 0;
  const reversed = db.get(`SELECT 1 FROM journal_entries WHERE id = ? AND reversed_by IS NOT NULL`, [p.pj]);
  return reversed ? Math.max(0, -entryCashEffect(db, p.pj)) : 0;
}

/** استعادة عنصر · وما عكسه حذفُه من قيود يُعاد بنسخته، أو تُرفض الاستعادة بسببٍ ظاهر */
export function restoreFromTrash(db: DB, table: string, id: string): void {
  db.transaction(() => restoreOne(db, table, id));
  logAudit(db, 'سلة المحذوفات', 'update', 'استعادة', TRASH_ENTITY_LABELS[table] || table);
}

/**
 * الحذف النهائي الجماعي: معاملة واحدة، الأبناء قبل الآباء، والصفوف الباقية
 * التي تشير لمحذوف تُفكّ إشارتها · فلا FOREIGN KEY constraint failed ولا معاملة لكل صف.
 */
export function purgeManyFromTrash(db: DB, items: Array<{ table: string; id: string }>): number {
  if (!items.length) return 0;
  const ids = new Map<string, string[]>();
  for (const i of items) {
    const arr = ids.get(i.table) ?? [];
    arr.push(i.id);
    ids.set(i.table, arr);
  }
  // كل عبارةٍ قطعاً (التوجيه الرابع ٣ · ٢): عناصر السلة يكبر عددها بالبيانات، وأثر كل عبارةٍ هنا على كل صفٍّ وحده
  const del = (sql: string, params: string[]) => runIn(db, sql, params);

  db.transaction(() => {
    db.exec('PRAGMA defer_foreign_keys = ON');

    // ١ · سطور القيود المحذوفة · المسودات وحدها: القيد المرحّل لا يُحذف أبداً ولو بقي في السلة من إصدار سابق
    const jeAll = ids.get('journal_entries') ?? [];
    const je = jeAll.length
      ? allIn<{ id: string }>(db, `SELECT id FROM journal_entries WHERE id IN (:list) AND status != 'مرحّل'`, jeAll).map((r) => r.id)
      : [];
    del(`DELETE FROM journal_lines WHERE entry_id IN (:list)`, je);

    // ٢ · الأوراق البسيطة بلا مُعالين · وحركة البنك تُفكّ مطابقة سطر الكشف بها قبل حذفها (المدقق الخارجي U١٩)
    runIn(db, `UPDATE bank_statement_lines SET bank_tx_id = NULL, status = 'open', matched_at = NULL WHERE bank_tx_id IN (:list)`, ids.get('bank_tx') ?? []);
    for (const t of ['attachments', 'message_scripts', 'company_docs', 'form_templates', 'handovers', 'reservations', 'key_money_deals', 'claims', 'bank_tx'] as const) {
      const arr = ids.get(t) ?? [];
      del(`DELETE FROM "${t}" WHERE id IN (:list) AND deleted_at IS NOT NULL`, arr);
    }

    // ٣ · الفواتير قبل قيودها (مفتاح journal_entry_id يمنع العكس)
    for (const t of ['invoices', 'purchases'] as const) {
      const arr = ids.get(t) ?? [];
      del(`DELETE FROM "${t}" WHERE id IN (:list) AND deleted_at IS NOT NULL`, arr);
    }

    // ٤ · القيود: الصفوف الحية المشيرة إليها تُفكّ إشارتها ثم تُحذف القيود
    if (je.length) {
      runIn(db, `UPDATE contract_payments SET journal_entry_id = NULL WHERE journal_entry_id IN (:list)`, je);
      runIn(db, `UPDATE invoices SET journal_entry_id = NULL WHERE journal_entry_id IN (:list)`, je);
      runIn(db, `UPDATE purchases SET journal_entry_id = NULL WHERE journal_entry_id IN (:list)`, je);
      runIn(db, `UPDATE journal_entries SET reversed_by = NULL WHERE reversed_by IN (:list)`, je);
      del(`DELETE FROM journal_entries WHERE id IN (:list) AND deleted_at IS NOT NULL`, je);
    }

    // ٥ · العقود: مُعاليها أولاً (دفعاتها وسطورها وتوزيعاتها وساكنوها وتسوياتها وتقييماتها ومطالباتها)
    const cs = ids.get('contracts') ?? [];
    if (cs.length) {
      runIn(db, `DELETE FROM payment_lines WHERE payment_id IN (SELECT id FROM contract_payments WHERE contract_id IN (:list))`, cs);
      runIn(db, `DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM contract_payments WHERE contract_id IN (:list))`, cs);
      runIn(db, `DELETE FROM contract_payments WHERE contract_id IN (:list)`, cs);
      runIn(db, `DELETE FROM occupants WHERE contract_id IN (:list)`, cs);
      runIn(db, `DELETE FROM contract_occupants WHERE contract_id IN (:list)`, cs);
      runIn(db, `DELETE FROM deposit_settlements WHERE contract_id IN (:list)`, cs);
      runIn(db, `DELETE FROM tenant_ratings WHERE contract_id IN (:list)`, cs);
      runIn(db, `DELETE FROM claims WHERE contract_id IN (:list)`, cs);
      runIn(db, `DELETE FROM handovers WHERE contract_id IN (:list)`, cs);
      del(`DELETE FROM contracts WHERE id IN (:list) AND deleted_at IS NOT NULL`, cs);
    }

    // ٦ · الوحدات ثم العقارات (توابعها المتسلسلة تُكنس بالتسلسل المعرَّف في المخطط)
    //
    // العلّة التي أُغلقت هنا: `contracts.unit_id` و`units.property_id` مفتاحان بلا تتالٍ،
    // فوحدةٌ في السلة ما زال يشير إليها عقدٌ حيّ (أو عقارٌ في السلة له وحدة حيّة) كانت
    // تُحذف فيسقط الحذف كله بـ«قيد مفتاح أجنبي» ويخرج النصّ الإنجليزي للمستخدم.
    // والقاعدة كقاعدة الحسابات في ٨: ما زال عليه معالون أحياء لا يُحذف ويُترك في السلة.
    const us = ids.get('units') ?? [];
    if (us.length) {
      runIn(db, `DELETE FROM reservations WHERE unit_id IN (:list)`, us);
      runIn(db, `DELETE FROM key_money_deals WHERE unit_id IN (:list)`, us);
      runIn(db, `UPDATE occupants SET unit_id = NULL WHERE unit_id IN (:list)`, us);
      runIn(db, `DELETE FROM meters WHERE owner_type = 'unit' AND owner_id IN (:list)
                AND owner_id NOT IN (SELECT unit_id FROM contracts WHERE unit_id IS NOT NULL)`, us);
      del(`DELETE FROM units WHERE id IN (:list) AND deleted_at IS NOT NULL
             AND id NOT IN (SELECT unit_id FROM contracts WHERE unit_id IS NOT NULL)`, us);
    }
    const ps = ids.get('properties') ?? [];
    if (ps.length) {
      runIn(db, `DELETE FROM meters WHERE owner_type = 'property' AND owner_id IN (:list)
                AND owner_id NOT IN (SELECT property_id FROM units)`, ps);
      del(`DELETE FROM properties WHERE id IN (:list) AND deleted_at IS NOT NULL
             AND id NOT IN (SELECT property_id FROM units)`, ps);
    }

    // ٧ · الأطراف: الصفوف الحية المشيرة إليها تُفكّ إشارتها
    const ts = ids.get('tenants') ?? [];
    if (ts.length) {
      runIn(db, `UPDATE contracts SET tenant_id = NULL WHERE tenant_id IN (:list)`, ts);
      del(`DELETE FROM tenants WHERE id IN (:list) AND deleted_at IS NOT NULL`, ts);
    }
    const ss = ids.get('suppliers') ?? [];
    if (ss.length) {
      runIn(db, `UPDATE meters SET supplier_id = NULL WHERE supplier_id IN (:list)`, ss);
      del(`DELETE FROM suppliers WHERE id IN (:list) AND deleted_at IS NOT NULL`, ss);
    }
    const bs = ids.get('banks') ?? [];
    if (bs.length) {
      // وكشوف البنك وسطورها معه، فلا يوقف مفتاحها الأجنبي الكنس كله (المدقق الخارجي U٢٠)
      runIn(db, `DELETE FROM bank_statement_lines WHERE bank_id IN (:list)`, bs);
      runIn(db, `DELETE FROM bank_statements WHERE bank_id IN (:list)`, bs);
      runIn(db, `UPDATE bank_statement_lines SET bank_tx_id = NULL, status = 'open', matched_at = NULL
         WHERE bank_tx_id IN (SELECT id FROM bank_tx WHERE bank_id IN (:list))`, bs);
      runIn(db, `DELETE FROM bank_tx WHERE bank_id IN (:list)`, bs);
      runIn(db, `UPDATE payment_lines SET bank_id = NULL WHERE bank_id IN (:list)`, bs);
      del(`DELETE FROM banks WHERE id IN (:list) AND deleted_at IS NOT NULL`, bs);
    }

    // ٨ · الحسابات المحاسبية: ما عليه سطور لا يُحذف (التاريخ لا يُمحى) ويُترك في السلة
    const as = ids.get('accounts') ?? [];
    if (as.length) {
      runIn(db,
        `DELETE FROM accounts WHERE code IN (:list) AND deleted_at IS NOT NULL
         AND code NOT IN (SELECT DISTINCT account_code FROM journal_lines)`, as);
    }
  });
  logAudit(db, 'سلة المحذوفات', 'delete', 'حذف نهائي جماعي', items.length + ' عنصراً');
  return items.length;
}

/** حذف نهائي لعنصر واحد · يمرّ عبر المسار الجماعي نفسه فلا يختلف سلوكاً */
export function purgeFromTrash(db: DB, table: string, id: string): void {
  purgeManyFromTrash(db, [{ table, id }]);
}

/**
 * كنس دوري: حذف ما انقضت مدته نهائياً · دفعة واحدة · على جهاز المالك وحده (المراجعة الخارجية ٧ · النتيجة ٢ · المتحقق المستقل،
 * الجولة العشرون): جهاز العضو كان يكنس بمدته هو فيُرسل حذف أبناء عقدٍ في سلة المالك (دفعاته ومطالباته) قبل أن تنقضي مدة المالك،
 * فتُستعاد ناقصة · وحذف المالك يصل الأعضاء بمزامنته
 */
export async function purgeExpiredTrash(db: DB, now: Date = new Date()): Promise<number> {
  let member = false;
  try { member = !!db.get(`SELECT 1 FROM sync_state WHERE k = 'membership' AND v IS NOT NULL`); } catch { member = false; }
  if (member) return 0;
  const items = trashItems(db, now).filter((i) => i.daysLeft <= 0);
  return purgeManyFromTrash(db, items);
}

/** يفسح للواجهة بين الدفعات */
const breathe = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** الاستعادة الجماعية · ما رُفض منها يبقى في السلة بسببه، والباقي يُستعاد */
export async function restoreAllFromTrash(db: DB, onProgress?: (done: number, total: number) => void): Promise<number> {
  const items = trashItems(db);
  let n = 0;
  let restored = 0;
  // الاستعادة تعيد ترحيل الفواتير قيداً قيداً · دفعات من ٢٥ مع تنفس بينها
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    for (const it of chunk) {
      try { db.transaction(() => restoreOne(db, it.table, it.id)); restored++; }
      catch { /* يبقى في السلة · سببه يظهر عند استعادته وحده */ }
    }
    n += chunk.length;
    onProgress?.(n, items.length);
    await breathe();
  }
  logAudit(db, 'سلة المحذوفات', 'update', 'استعادة جماعية', restored + ' من ' + items.length + ' عنصراً');
  return restored;
}

export async function deleteAllFromTrash(db: DB, onProgress?: (done: number, total: number) => void): Promise<number> {
  const items = trashItems(db);
  onProgress?.(0, items.length);
  const n = purgeManyFromTrash(db, items);
  onProgress?.(n, items.length);
  return n;
}
