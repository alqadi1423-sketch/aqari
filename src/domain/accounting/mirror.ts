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

/**
 * شكل قيد عكس الإهلاك عند التراجع عن تحويل المشتريات إلى أصول (assets/convert.ts: undoConversion) · مصدره «asset_convert_rev»
 * وليس مرآةً لقيدٍ بعينه: مدين مجمع الإهلاك 1490 ودائن مصروف الإهلاك 5600 أو الأرباح المحتجزة 3200، لكل سطرٍ أصله ·
 * (المتحقق المستقل، الجولة الثانية عشرة: كان يُرفض على جهاز المالك الآخر فيبقى الإهلاك) · وشروط قبوله في depUndoIssue
 */
export function isDepreciationUndoShape(db: DB, revId: string): boolean {
  const lines = db.all<{ account_code: string; debit_halalas: number; credit_halalas: number; asset_id: string | null }>(
    `SELECT account_code, debit_halalas, credit_halalas, asset_id FROM journal_lines WHERE entry_id = ?`, [revId]);
  if (!lines.length) return false;
  return lines.every((l) => !!l.asset_id && (l.account_code === '1490'
    ? Number(l.credit_halalas) === 0
    : ['5600', ACC_RETAINED].includes(l.account_code) && Number(l.debit_halalas) === 0));
}

const POSTED_SQL = "e.status = 'مرحّل' AND e.deleted_at IS NULL"; // i18n-exempt: حالة القيد المخزّنة

/**
 * شروط قبول عكس الإهلاك (المتحقق المستقل، الجولة الثالثة عشرة: كان شكله وحده يكفي فيمحو إهلاك أي أصلٍ والتحويل قائم):
 * تحويلٌ «asset_convert» قائمٌ لمصدره قد عُكس أو وصلت مرآته (وإلا انتظر: المرايا وقيد الإهلاك في معاملةٍ واحدة وتصل بأي ترتيب)،
 * وكل أصلٍ فيه من قيود تحويله، ولا يتجاوز لأصلٍ ما رُحِّل عليه من إهلاك (قيود «depreciation» و«asset_dep» كما يحسبه التراجع)،
 * ولا قيود عكس إهلاكٍ أكثر من تحويلاته · 'await' إن لم يصل ما ينتظره، وإلا سبب الرفض، وفارغ إن قُبل
 */
export function depUndoIssue(db: DB, revId: string, srcId: string): string {
  const conv = db.all<{ id: string; reversed_by: string | null }>(
    `SELECT e.id, e.reversed_by FROM journal_entries e WHERE e.src_type = 'asset_convert' AND e.src_id = ? AND ${POSTED_SQL}`, [srcId]);
  if (!conv.length) return 'await';
  const mirrored = conv.filter((c) => c.reversed_by || db.all<{ id: string }>(
    `SELECT e.id FROM journal_entries e WHERE e.src_type = 'asset_convert_rev' AND e.src_id = ? AND e.id != ? AND ${POSTED_SQL}`, [srcId, revId])
    .some((r) => mirrorIssue(db, c.id, r.id) === ''));
  if (!mirrored.length) return 'await';
  const lines = db.all<{ account_code: string; debit_halalas: number; asset_id: string }>(
    `SELECT account_code, debit_halalas, asset_id FROM journal_lines WHERE entry_id = ?`, [revId]);
  for (const id of [...new Set(lines.map((l) => l.asset_id))]) {
    const own = db.get(`SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.asset_id = ? AND e.src_type IN ('asset_convert', 'asset_catchup') AND e.src_id = ? AND ${POSTED_SQL} LIMIT 1`, [id, srcId]);
    if (!own) return t('mirror.depForeign', { lng: 'ar' });
    const booked = Number(db.get<{ n: number }>(`SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS n FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_code = '1490' AND l.asset_id = ? AND e.src_type IN ('depreciation', 'asset_dep') AND ${POSTED_SQL}`, [id])!.n);
    const undone = Number(db.get<{ n: number }>(`SELECT COALESCE(SUM(l.debit_halalas), 0) AS n FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_code = '1490' AND l.asset_id = ? AND e.src_type = 'asset_convert_rev' AND ${POSTED_SQL}
        AND e.id IN (SELECT id FROM journal_entries WHERE src_type = 'asset_convert_rev' AND src_id = ?)`, [id, srcId])!.n);
    if (undone > booked) return t('mirror.depOver', { lng: 'ar' });
  }
  const undos = db.all<{ id: string }>(`SELECT e.id FROM journal_entries e WHERE e.src_type = 'asset_convert_rev' AND e.src_id = ? AND ${POSTED_SQL}`, [srcId])
    .filter((r) => isDepreciationUndoShape(db, r.id)).length;
  if (undos > conv.length) return t('mirror.depExtra', { lng: 'ar' });
  return '';
}

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
