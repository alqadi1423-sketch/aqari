/**
 * قيد بلا مستند · القيد المرحّل لا يُحذف (التصميم ٤)، فإن غاب مستنده بقي هو ويُراجَع:
 *  - بالاستعادة: قيدٌ رُحّل بعد تاريخ النسخة ومستنده ليس فيها، أو فيها بحاله قبل القيد (keepPosted.ts).
 *  - بالمزامنة: قيدٌ وصل من جهاز آخر ومستنده حذفته استعادةٌ على جهاز ثالث.
 *
 * العلامة سطرٌ في سجل العمليات لا إعدادٌ على الجهاز: السجل يُزامَن ولا يُعدَّل، فيرى القائمةَ نفسها
 * كلُّ جهاز على الحساب. والقيد المعلَّم (وعكسه إن عُكس) خارج فحوص مطابقة الدفتر بالمستندات
 * (integrity.ts) لأنه لا مستند له يطابقه · فلا يمنع النسخ الاحتياطي، ويبقى ظاهراً في أداة المراجعة
 * حتى يُعكس أو يُعلَّم «تمّت مراجعته»، أو يصير له مستندٌ بحفظ مستنده بعد العلامة (documentedSql) فيعود داخل المطابقة.
 * وما ضمّه اعتماد استعادةٍ من السجل من خطٍّ زمنيٍّ لم تَعُد إليه البيانات (علامةٌ أو حفظ مستند) لا يعمل فيها (KEPT_FOREIGN_ENTITY).
 */
import type { DB } from '../../db/adapter';
import { logAudit } from '../audit';

export const KEPT_REVIEW_ENTITY = 'قيد بلا مستند بعد الاستعادة';
export const KEPT_REVIEWED_ENTITY = 'مراجعة قيد بعد الاستعادة';

/** نوع المستند وجدوله · ومعرّف المستند في src_id */
export const SOURCE_DOC: Record<string, [label: string, tables: string[]]> = {
  invoice: ['فاتورة', ['invoices']],
  invoice_pay: ['سداد فاتورة', ['invoices']], // i18n-exempt: نوع مستند في سجل العمليات
  asset_cost: ['تكلفة أصل', ['assets']], // i18n-exempt: نوع مستند في سجل العمليات
  asset_transfer: ['نقل أصل', ['assets']], // i18n-exempt: نوع مستند في سجل العمليات
  asset_dispose: ['استبعاد أصل', ['assets']], // i18n-exempt: نوع مستند في سجل العمليات
  asset_sell: ['بيع أصل', ['assets']], // i18n-exempt: نوع مستند في سجل العمليات
  asset_dep: ['إهلاك أصل', ['assets']], // i18n-exempt: نوع مستند في سجل العمليات
  asset_convert: ['تحويل شراء إلى أصل', ['purchases']], // i18n-exempt: نوع مستند في سجل العمليات
  asset_catchup: ['إهلاك لاحق لأصل', ['purchases']], // i18n-exempt: نوع مستند في سجل العمليات
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
  deposit_rent: ['سداد قسط من التأمين', ['contracts']], // i18n-exempt: نوع مستند في سجل العمليات · A1-2
  reservation: ['حجز', ['reservations']],
  reservation_convert: ['تحويل حجز', ['reservations']],
  reservation_forfeit: ['مصادرة حجز', ['reservations']],
  reservation_refund: ['ردّ عربون', ['reservations']],
  key_money: ['تقبيل', ['key_money_deals']],
  surplus_refund: ['ردّ فائض', ['contracts']],
  surplus_credit: ['فائض رصيداً', ['contracts']],
  discount: ['خصم', ['contract_payments', 'contract_installments']],
  rent: ['دفعة إيجار', []],
};

/**
 * شرط SQL: القيد (بالاسم e) مستنده غائب · قيد الدفعة بدفعته، وغيره بجدول مستنده · والمصدر الذي لم يُنشأ جدوله بعد في هذه
 * القاعدة (نسخةٌ قبل الترقية يُفحص تكاملها) لا قيد له فيها
 */
function orphanSql(db: DB): string {
  const exists = (t: string) => !!db.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [t]);
  // تشمل الملغاة: صفّها باقٍ مستنداً لقيدها المعكوس
  const parts = [`(e.src_type = 'rent' AND NOT EXISTS (SELECT 1 FROM contract_payments p WHERE p.journal_entry_id = e.id /* تشمل الملغاة: مستند لقيدها المعكوس */))`];
  for (const [type, [, tables]] of Object.entries(SOURCE_DOC)) {
    if (!tables.length || !tables.every(exists)) continue;
    parts.push(`(e.src_type = '${type}' AND ${tables.map((t) => `NOT EXISTS (SELECT 1 FROM "${t}" x WHERE x.id = e.src_id)`).join(' AND ')})`);
  }
  return '(' + parts.join(' OR ') + ')';
}

/**
 * سطور مراجعةٍ ضمّها اعتماد استعادةٍ من السحابة وليست في النسخة المعتمدة (المراجع المعاكس الرابع على R12-BAK-2): سجل العمليات يُضمّ كله
 * عند الاعتماد (adoptAsCloudTruth: إضافةٌ لا تغيّر رقماً) فتصل معه علاماتٌ وحفظٌ لمستنداتٍ كُتبت في خطٍّ زمنيٍّ لم تَعُد إليه البيانات ·
 * والاستعادة حكمت من جديد على كل قيدٍ بعد النسخة (keepPosted.ts)، وما في النسخة حكمه في سجلّها · فيُكتب في الاعتماد سطرٌ واحد بمعرّفاتها
 * (ids) فلا تعمل هنا: لا علامةٌ قديمة على زوجٍ صار كله مضموماً، ولا حفظٌ لم يقع في هذه البيانات · وسطر الاعتماد نفسه يُضمّ في اعتمادٍ لاحق
 * فيسمّيه ذلك الاعتماد كغيره (foreignAuditIds)
 */
export const KEPT_FOREIGN_ENTITY = 'سطور مراجعة من غير النسخة المعتمدة'; // i18n-exempt: نوع سجلٍ مخزَّن يقارن به الكود
/**
 * مفتاحٌ في سطر حفظ المستند (after_json) بمعرّفه: حفظٌ يعيد ترحيل قيوده كلها، يعكس الحيّ منها ثم يرحّل الجديد (تسوية التأمين وإلغاء العقد
 * بتسوية بالعقد صاحب التأمين، وحذف المطالبة وتعديلها بالمطالبة)
 */
export const REPOSTED_KEY = 'reposted';
/** قيودٌ مصدرها مستندٌ يعيد حفظه ترحيلها كلها (REPOSTED_KEY) · ومعرّف المستند src_id */
const REPOST_SRC = ['deposit_deduct', 'deposit_refund', 'deposit_deduct_move', 'deposit_rent', 'claim'];
const REPOST_TYPES = [...REPOST_SRC, ...REPOST_SRC.map((t) => t + '_rev')];
const quoted = (xs: string[]) => xs.map((x) => `'${x}'`).join(', ');
const jsonOf = (col: string, path: string) => `CASE WHEN json_valid(${col}) THEN json_extract(${col}, '${path}') END`;

/**
 * معرّفات سطور السجل التي لا تعمل في هذه البيانات: ما سمّاه سطر اعتمادٍ نافذ (KEPT_FOREIGN_ENTITY) · وسطر الاعتماد نافذٌ ما لم يسمّه
 * سطر اعتمادٍ نافذ (اعتمادٌ لاحق ضمّه من خطٍّ آخر) · ولا يسمّي سطرٌ إلا ما سبقه، فالحساب ينتهي
 */
export function foreignAuditIds(db: DB): string[] {
  const rows = db.all<{ id: string; aj: string | null }>(`SELECT id, after_json AS aj FROM audit_log WHERE entity_type = ?`, [KEPT_FOREIGN_ENTITY]);
  if (!rows.length) return [];
  const lists = new Map<string, string[]>();
  for (const r of rows) {
    let ids: string[] = [];
    try { const j = JSON.parse(r.aj ?? '{}') as { ids?: unknown }; if (Array.isArray(j.ids)) ids = j.ids.map(String); } catch { ids = []; }
    lists.set(r.id, ids);
  }
  const listers = new Map<string, string[]>();
  for (const [a, ids] of lists) for (const x of ids) if (lists.has(x) && x !== a) listers.set(x, [...(listers.get(x) ?? []), a]);
  const memo = new Map<string, boolean>();
  const live = (a: string, path: Set<string>): boolean => {
    if (memo.has(a)) return memo.get(a)!;
    if (path.has(a)) return true; // دورةٌ لا تقع بين سطور الاعتماد · تُقطع ولا تُسقط
    path.add(a);
    const v = !(listers.get(a) ?? []).some((b) => live(b, path));
    path.delete(a);
    memo.set(a, v);
    return v;
  };
  const out = new Set<string>();
  for (const [a, ids] of lists) if (live(a, new Set())) for (const x of ids) out.add(x);
  return [...out];
}

/** معرّفات سطور السجل المضمومة عند الاعتماد التي يُبنى عليها حكم المراجعة: العلامات، وحفظ مستندٍ أعاد ترحيل قيوده، وسطور الاعتماد */
export function foreignReviewRows(docs: Array<{ k: string; d?: Record<string, unknown> | null }>): string[] {
  return docs.filter((x) => {
    const type = String(x.d?.entity_type ?? '');
    if (type === KEPT_REVIEW_ENTITY || type === KEPT_FOREIGN_ENTITY) return true;
    const aj = x.d?.after_json;
    if (typeof aj !== 'string' || !aj.includes('"' + REPOSTED_KEY + '"')) return false;
    try { return (JSON.parse(aj) as Record<string, unknown>)[REPOSTED_KEY] != null; } catch { return false; }
  }).map((x) => String(x.d?.id ?? x.k));
}

/** سطر الاعتماد · في معاملة الاعتماد قبل رفع ما في القاعدة، فيُرفع معها */
export function recordForeignReview(db: DB, ids: string[]): void {
  if (!ids.length) return;
  logAudit(db, 'النسخ الاحتياطي', 'update', KEPT_FOREIGN_ENTITY, String(ids.length), undefined, { ids }); // i18n-exempt: قسمٌ مخزَّن في سجل العمليات كأخواته
}

/**
 * جداول الاستعلام (WITH) بمعامل واحد: معرّفات ما لا يعمل (foreignAuditIds) · fx: هي، mk: العلامات النافذة بمعرّف قيدها ونصّها ووقتها،
 * sv: حفظ المستندات النافذ بمعرّف المستند
 */
const REVIEW_CTE = `fx AS (SELECT value AS id FROM json_each(?)),
  mk AS (SELECT a.id AS mid, ${jsonOf('a.after_json', '$.id')} AS id, a.after_json AS aj, a.ts AS ts FROM audit_log a
         WHERE a.entity_type = '${KEPT_REVIEW_ENTITY}' AND a.id NOT IN (SELECT id FROM fx) AND ${jsonOf('a.after_json', '$.id')} IS NOT NULL),
  sv AS (SELECT a.id, ${jsonOf('a.after_json', '$.' + REPOSTED_KEY)} AS doc, a.ts FROM audit_log a
         WHERE instr(a.after_json, '"${REPOSTED_KEY}"') > 0 AND a.id NOT IN (SELECT id FROM fx)
           AND ${jsonOf('a.after_json', '$.' + REPOSTED_KEY)} IS NOT NULL)`;

/**
 * شرط SQL: القيد المعلَّم (بالاسم x) صار له مستند (المراجعة ١٢ · R12-BAK-2): مستنده يعيد حفظه ترحيل قيوده كلها (REPOST_SRC)، وحُفظ بعد
 * علاماته كلها، وهو في زوجٍ أثره صفر (عُكس، أو عاكسُ أصلٍ معكوس) · فيعود داخل المطابقة ويخرج من أداة المراجعة، وإلا بقي عاكسٌ معلَّم
 * خارجها وأصله داخلها أبداً.
 * «بعد العلامة» بلا ساعة: العلامة تسمّي حفظ مستندها الذي في البيانات حين كُتبت (saves · markForReview)، فحفظٌ لا تسمّيه وقع بعدها ·
 * والعلامة القديمة بلا saves بوقت السجل · وسطر الحفظ يكتبه من حفظ ولو عضواً لا يقرأ السجل، فيراه جهاز المالك (المراجع المعاكس الثالث) ·
 * ويبقى بعد عكس قيود ذلك الحفظ أو تعليمها في استعادةٍ لاحقة لنسخةٍ أُخذت بعده (المراجع المعاكس الرابع: كان الاشتقاق من قيد تسويةٍ حيّ
 * غير معلَّم فينقلب)، ويشمل حفظاً لا يرحّل شيئاً (تأمينٌ لدى طرف آخر) وحذف المطالبة بعد استعادةٍ ضمّت عكس قيدها ·
 * وما ضمّه الاعتماد من خطٍّ آخر لا يعمل (foreignAuditIds)
 */
function documentedSql(x: string): string {
  return `(${x}.src_type IN (${quoted(REPOST_TYPES)})
    AND (${x}.reversed_by IS NOT NULL OR EXISTS (SELECT 1 FROM journal_entries o WHERE o.reversed_by = ${x}.id))
    AND EXISTS (SELECT 1 FROM sv WHERE sv.doc = ${x}.src_id
      AND NOT EXISTS (SELECT 1 FROM mk k WHERE k.id = ${x}.id AND CASE WHEN json_type(k.aj, '$.saves') = 'array'
        THEN EXISTS (SELECT 1 FROM json_each(k.aj, '$.saves') j WHERE j.value = sv.id) ELSE sv.ts <= k.ts END)))`;
}

/** المعلَّم خارج المطابقة: عُلِّم ولم يصر له مستند · وعكوسه معه */
const OUT_OF_MATCH = `WITH ${REVIEW_CTE},
  m AS (SELECT DISTINCT e.id FROM journal_entries e JOIN mk ON mk.id = e.id WHERE NOT ${documentedSql('e')}),
  ids AS (SELECT id FROM m UNION SELECT e.reversed_by FROM journal_entries e JOIN m ON m.id = e.id WHERE e.reversed_by IS NOT NULL)`;

/** صافي حساب (مدين موجب) في القيود المعلَّمة وعكوسها · يُطرح من رصيد الدفتر قبل مطابقته بالمستندات · إلا ما صار له مستند */
export function markedNetOn(db: DB, account: string): number {
  // المعلَّم يُجمع مرة ثم عكوسه · لا مسح لسجل العمليات عند كل سطر
  return Number(db.get<{ s: number }>(
    `${OUT_OF_MATCH}
     SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas), 0) AS s
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_code = ? AND e.status = 'مرحّل' AND e.deleted_at IS NULL AND e.id IN (SELECT id FROM ids)`,
    [JSON.stringify(foreignAuditIds(db)), account])!.s);
}

/** القيد معلَّمٌ خارج المطابقة (أو عاكسُ معلَّمٍ خارجها) · بعد استعادة: من تعديلٍ ليس مستنده في البيانات */
export function outOfMatch(db: DB, entryId: string): boolean {
  return !!db.get(`${OUT_OF_MATCH} SELECT 1 FROM ids WHERE id = ?`, [JSON.stringify(foreignAuditIds(db)), entryId]);
}

/**
 * جهاز العضو نسخته جزئية بصلاحيته: تصله قيود عقاره ولا تصله مستندات أقسامٍ ليست له · فلا يُحكم فيه بغياب المستند
 * (التحقق المستقل من f07ad73: كان يُظهر «عكس القيد» لسداد فاتورة وإهلاك أصل، وفحص المطابقة ٧ أحمر)
 */
export function memberDevice(db: DB): boolean {
  try { return !!db.get(`SELECT 1 FROM sync_state WHERE k = 'membership' AND v IS NOT NULL`); } catch { return false; }
}

/** قيود مرحّلة قائمة الأثر مستندها غائب ولم تُعلَّم بعد · بعلامةٍ نافذة: علامةٌ ضمّها الاعتماد من خطٍّ آخر لا تُعدّ (foreignAuditIds) */
export function unmarkedOrphans(db: DB): Array<{ id: string; no: string; src_type: string }> {
  if (memberDevice(db)) return [];
  return db.all(
    `WITH ${REVIEW_CTE}
     SELECT e.id, e.no, e.src_type FROM journal_entries e
     WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL AND e.auto = 1 AND e.reversed_by IS NULL
       AND e.src_type IS NOT NULL AND e.src_type NOT LIKE '%\\_rev' ESCAPE '\\'
       AND ${orphanSql(db)} AND NOT EXISTS (SELECT 1 FROM mk WHERE mk.id = e.id)
     ORDER BY e.date, e.no`, [JSON.stringify(foreignAuditIds(db))]);
}

/** القيد غائب المستند؟ · لعكسه من الدفتر حين لا مستند يُلغى منه */
export function isOrphanEntry(db: DB, entryId: string): boolean {
  if (memberDevice(db)) return false;
  return !!db.get(`SELECT 1 FROM journal_entries e WHERE e.id = ? AND e.src_type IS NOT NULL AND ${orphanSql(db)}`, [entryId]);
}

/**
 * العلامة · وقيدٌ يعيد حفظ مستنده ترحيله (REPOST_SRC) تسمّي علامته حفظ مستنده الذي في البيانات الآن (saves)، فحفظٌ لا تسمّيه وقع بعدها
 * (documentedSql) · بلا ساعة: سجل العمليات بالثانية، والحفظ قد يكتبه جهازٌ آخر بساعته
 */
export function markForReview(db: DB, entry: { id: string; no: string }, reason: string): void {
  const e = db.get<{ t: string | null; s: string | null }>(`SELECT src_type AS t, src_id AS s FROM journal_entries WHERE id = ?`, [entry.id]);
  const saves = e?.s && REPOST_TYPES.includes(String(e.t))
    ? db.all<{ id: string }>(`SELECT id FROM audit_log WHERE instr(after_json, ?) > 0 AND ${jsonOf('after_json', '$.' + REPOSTED_KEY)} = ?`,
      ['"' + REPOSTED_KEY + '"', e.s]).map((r) => r.id)
    : null;
  logAudit(db, 'النسخ الاحتياطي', 'create', KEPT_REVIEW_ENTITY, entry.no, undefined,
    { id: entry.id, no: entry.no, reason, ...(saves ? { saves } : {}) });
}

/** تعليم ما غاب مستنده · بعد اكتمال تطبيق الوارد · يعيد عدد ما عُلِّم */
export function markOrphans(db: DB, how: string): number {
  const found = unmarkedOrphans(db);
  for (const e of found) {
    const label = SOURCE_DOC[e.src_type]?.[0] ?? 'آلي'; // نوعٌ غير معروف لا يُعرض اسمه التقني
    markForReview(db, e, `قيد ${label} ${how} ومستنده ليس في البيانات`);
  }
  return found.length;
}

export interface KeptReviewItem { id: string; no: string; reason: string }

/** أداة المراجعة: ما عُلِّم بعلامةٍ نافذة ولم يُعكس ولم يُراجَع ولم يصر له مستند */
export function keptForReview(db: DB): KeptReviewItem[] {
  return db.all<KeptReviewItem>(
    `WITH ${REVIEW_CTE}
     SELECT e.id, e.no, MAX(${jsonOf('mk.aj', '$.reason')}) AS reason
     FROM mk JOIN journal_entries e ON e.id = mk.id
     WHERE e.reversed_by IS NULL AND e.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM audit_log d WHERE d.entity_type = ? AND json_extract(d.after_json, '$.id') = e.id)
       AND NOT ${documentedSql('e')}
     GROUP BY e.id ORDER BY e.date, e.no`, [JSON.stringify(foreignAuditIds(db)), KEPT_REVIEWED_ENTITY]);
}

/** «تمّت مراجعته» · بقرار المستخدم · يبقى القيد خارج المطابقة لأن مستنده غائب */
export function dismissKeptReview(db: DB, id: string): void {
  const e = db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ?`, [id]);
  logAudit(db, 'النسخ الاحتياطي', 'update', KEPT_REVIEWED_ENTITY, e?.no ?? id, undefined, { id });
}
