/**
 * أبعاد الدفتر ومراكز التكلفة (قرار المالك ٢٠٢٦-١٠-٠٤): كل سطر قيدٍ يحمل أبعاده لتُفلتر بها التقارير ·
 * العقار والوحدة والعقد ومركز التكلفة والأصل (الهجرة ٢٨).
 *  - العقار والوحدة والعقد تُشتق من مستند القيد نفسه (الدفعة ← العقد ← الوحدة ← العقار، والمشترى والفاتورة
 *    بعقارهما ووحدتهما، والحجز بوحدته…) · الدالة نفسها تملأ الجديد وتملأ القديم بأداةٍ تُعرض قبل التنفيذ.
 *  - مركز التكلفة من الشاشة التي أنشأت القيد (withCostCenter حول العملية)، وافتراضه «عام» الذي لا يُحذف.
 *  - القيد العاكس ينسخ أبعاد أصله سطراً بسطر.
 */
import type { DB } from '../../db/adapter';

/** مركز «عام» · معرّفٌ ثابت على كل جهاز (الهجرة ٢٨) فلا يتكرر في المزامنة */
export const GENERAL_COST_CENTER = 'cc-general';

export interface Dims {
  propertyId?: string | null;
  unitId?: string | null;
  contractId?: string | null;
  costCenterId?: string | null;
  assetId?: string | null;
}

/* ═══════════ مركز العملية الجارية ═══════════ */

const stack: Array<string | null> = [];

/** مركز التكلفة الذي اختارته الشاشة لكل قيدٍ يُرحَّل داخل العملية · متزامنة أو بانتظار */
export function withCostCenter<T>(costCenterId: string | null | undefined, fn: () => T): T {
  stack.push(costCenterId || null);
  let async = false;
  try {
    const out = fn();
    if (out && typeof (out as unknown as Promise<unknown>).then === 'function') {
      async = true;
      return (out as unknown as Promise<unknown>).finally(() => { stack.pop(); }) as unknown as T;
    }
    return out;
  } finally {
    if (!async) stack.pop();
  }
}

/** مركز العملية الجارية · وإلا «عام» */
export const currentCostCenter = (): string => stack[stack.length - 1] ?? GENERAL_COST_CENTER;

/** سطور القيد بأعمدة الأبعاد (الهجرة ٢٨) · قاعدةٌ أقدم تُفحص قبل ترقيتها بلا أبعاد */
const dimCols = new WeakMap<object, boolean>();
export function hasDimColumns(db: DB): boolean {
  const k = db as unknown as object;
  let v = dimCols.get(k);
  if (v === undefined) {
    v = db.all<{ name: string }>(`PRAGMA table_info(journal_lines)`).some((c) => c.name === 'cost_center_id');
    // لا يُحفظ «بلا أبعاد» · فالقاعدة نفسها قد تُرقّى بعده
    if (v) dimCols.set(k, v);
  }
  return v;
}

/* ═══════════ الاشتقاق من مستند القيد ═══════════ */

const one = <T>(db: DB, sql: string, p: unknown[]) => db.get<T>(sql, p as never);

function fromUnit(db: DB, unitId: string | null | undefined): Dims {
  if (!unitId) return {};
  const u = one<{ property_id: string }>(db, `SELECT property_id FROM units WHERE id = ?`, [unitId]);
  return { unitId, propertyId: u?.property_id ?? null };
}

function fromContract(db: DB, contractId: string | null | undefined): Dims {
  if (!contractId) return {};
  const c = one<{ unit_id: string | null }>(db, `SELECT unit_id FROM contracts WHERE id = ?`, [contractId]);
  if (!c) return {};
  return { contractId, ...fromUnit(db, c.unit_id) };
}

function fromPayment(db: DB, paymentId: string): Dims {
  const p = one<{ contract_id: string }>(db, `SELECT contract_id FROM contract_payments WHERE id = ?`, [paymentId]);
  return p ? fromContract(db, p.contract_id) : {};
}

/**
 * أبعاد قيدٍ من مصدره (src_type وsrc_id) · فارغةٌ لما لا مصدر له (القيد اليدوي، وعمليات النقد، واسترداد
 * الضريبة) أو لمصدرٍ لم يعد موجوداً · ومركز التكلفة ليس من هنا.
 */
export function dimsFromSource(db: DB, srcType: string | null | undefined, srcId: string | null | undefined): Dims {
  if (!srcType || !srcId) return {};
  const base = srcType.replace(/_rev$/, '');
  // التحصيل والخصم والفائض: مصدرها دفعةٌ أو قسطٌ أو عقد
  if (base === 'rent' || base.startsWith('surplus') || base === 'payment' || base === 'discount') {
    const viaPay = fromPayment(db, srcId);
    if (viaPay.contractId) return viaPay;
    const i = one<{ contract_id: string }>(db, `SELECT contract_id FROM contract_installments WHERE id = ?`, [srcId]);
    return fromContract(db, i ? i.contract_id : srcId);
  }
  if (base === 'contract_deposit' || base.startsWith('deposit')) return fromContract(db, srcId);
  if (base.startsWith('claim')) {
    const c = one<{ contract_id: string }>(db, `SELECT contract_id FROM claims WHERE id = ?`, [srcId]);
    return c ? fromContract(db, c.contract_id) : {};
  }
  if (base.startsWith('reservation')) {
    const r = one<{ unit_id: string; converted_contract_id: string | null }>(db,
      `SELECT unit_id, converted_contract_id FROM reservations WHERE id = ?`, [srcId]);
    if (!r) return {};
    return r.converted_contract_id ? { ...fromUnit(db, r.unit_id), ...fromContract(db, r.converted_contract_id) } : fromUnit(db, r.unit_id);
  }
  if (base === 'key_money') {
    const k = one<{ unit_id: string; contract_id: string | null }>(db, `SELECT unit_id, contract_id FROM key_money_deals WHERE id = ?`, [srcId]);
    if (!k) return {};
    return k.contract_id ? fromContract(db, k.contract_id) : fromUnit(db, k.unit_id);
  }
  if (base.startsWith('purchase') || base.startsWith('invoice')) {
    const t = base.startsWith('purchase') ? 'purchases' : 'invoices';
    const d = one<{ property_id: string | null; unit_id: string | null }>(db, `SELECT property_id, unit_id FROM ${t} WHERE id = ?`, [srcId]);
    if (!d) return {};
    const u = fromUnit(db, d.unit_id);
    return { propertyId: d.property_id ?? u.propertyId ?? null, unitId: d.unit_id ?? null };
  }
  return {};
}

/** أبعاد سطرٍ للإدراج · الصريح يغلب المشتق، ومركز التكلفة من العملية الجارية */
export function lineDims(derived: Dims, explicit?: Dims | null, lineOwn?: Dims | null): Required<Dims> {
  const pick = <K extends keyof Dims>(k: K) => (lineOwn?.[k] ?? explicit?.[k] ?? derived[k] ?? null) as string | null;
  return {
    propertyId: pick('propertyId'),
    unitId: pick('unitId'),
    contractId: pick('contractId'),
    costCenterId: lineOwn?.costCenterId ?? explicit?.costCenterId ?? currentCostCenter(),
    assetId: pick('assetId'),
  };
}

/* ═══════════ ملء القيود القديمة · يُعرض قبل التنفيذ ═══════════ */

export interface DimsBackfillPlan {
  /** قيودٌ عُرف مصدرها فتُملأ أبعادها */
  known: Array<{ entryId: string; no: string; dims: Dims }>;
  /** قيودٌ لا يُعرف مصدرها · تبقى فارغة وتظهر في مراجعة الدفتر */
  unknown: Array<{ entryId: string; no: string; date: string; memo: string }>;
}

/** القيود المرحّلة التي لا بُعد في سطورها · وما يُشتق لكلٍّ منها */
export function planDimsBackfill(db: DB): DimsBackfillPlan {
  const rows = db.all<{ id: string; no: string; date: string; memo: string; src_type: string | null; src_id: string | null }>(
    `SELECT e.id, e.no, e.date, e.memo, e.src_type, e.src_id FROM journal_entries e
     WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id
         AND (l.property_id IS NOT NULL OR l.unit_id IS NOT NULL OR l.contract_id IS NOT NULL OR l.cost_center_id IS NOT NULL))
     ORDER BY e.date, e.no`);
  const plan: DimsBackfillPlan = { known: [], unknown: [] };
  for (const r of rows) {
    // العاكس يأخذ أبعاد أصله إن كانت · وإلا من مصدر أصله
    let d = dimsFromSource(db, r.src_type, r.src_id);
    if (!d.propertyId && !d.unitId && !d.contractId) {
      const orig = db.get<{ p: string | null; u: string | null; c: string | null }>(
        `SELECT l.property_id AS p, l.unit_id AS u, l.contract_id AS c FROM journal_entries o JOIN journal_lines l ON l.entry_id = o.id
         WHERE o.reversed_by = ? AND (l.property_id IS NOT NULL OR l.unit_id IS NOT NULL OR l.contract_id IS NOT NULL) LIMIT 1`, [r.id]);
      if (orig) d = { propertyId: orig.p, unitId: orig.u, contractId: orig.c };
    }
    if (d.propertyId || d.unitId || d.contractId) plan.known.push({ entryId: r.id, no: r.no, dims: d });
    else plan.unknown.push({ entryId: r.id, no: r.no, date: r.date, memo: r.memo });
  }
  return plan;
}

/** ملء أبعاد ما عُرف مصدره بكلمة المالك · ومركز تكلفته «عام» · يعيد عدد القيود */
export function applyDimsBackfill(db: DB, plan: DimsBackfillPlan): number {
  db.transaction(() => {
    for (const k of plan.known) {
      db.run(
        `UPDATE journal_lines SET property_id = ?, unit_id = ?, contract_id = ?, cost_center_id = COALESCE(cost_center_id, ?)
         WHERE entry_id = ?`,
        [k.dims.propertyId ?? null, k.dims.unitId ?? null, k.dims.contractId ?? null, GENERAL_COST_CENTER, k.entryId]);
    }
  });
  return plan.known.length;
}

/** ما لا يُعرف مصدره يبقى بلا عقار ولا وحدة ولا عقد بإقرار المالك · ويُعلَّم بمركز «عام» فيخرج من المراجعة */
export function acknowledgeUnknownDims(db: DB, entryIds: string[]): number {
  db.transaction(() => {
    for (const id of entryIds) {
      db.run(`UPDATE journal_lines SET cost_center_id = ? WHERE entry_id = ? AND cost_center_id IS NULL`, [GENERAL_COST_CENTER, id]);
    }
  });
  return entryIds.length;
}

/* ═══════════ مراكز التكلفة ═══════════ */

export interface CostCenter { id: string; name: string; is_default: number }

export function costCenters(db: DB): CostCenter[] {
  return db.all<CostCenter>(`SELECT id, name, is_default FROM cost_centers WHERE deleted_at IS NULL ORDER BY is_default DESC, name`);
}

export function addCostCenter(db: DB, id: string, name: string): void {
  const n = name.trim();
  if (n.length < 2) throw new Error('اسم مركز التكلفة حرفان على الأقل');
  if (db.get(`SELECT 1 FROM cost_centers WHERE deleted_at IS NULL AND name = ?`, [n])) throw new Error('يوجد مركز تكلفة بهذا الاسم');
  db.run(`INSERT INTO cost_centers (id, name, is_default, created_at) VALUES (?, ?, 0, ?)`, [id, n, new Date().toISOString()]);
}

export function renameCostCenter(db: DB, id: string, name: string): void {
  const n = name.trim();
  if (n.length < 2) throw new Error('اسم مركز التكلفة حرفان على الأقل');
  if (db.get(`SELECT 1 FROM cost_centers WHERE deleted_at IS NULL AND name = ? AND id != ?`, [n, id])) throw new Error('يوجد مركز تكلفة بهذا الاسم');
  db.run(`UPDATE cost_centers SET name = ? WHERE id = ?`, [n, id]);
}

/** حذف مركز إلى السلة · «عام» لا يُحذف (ويمنعه محفّز الهجرة ٢٨ أيضاً) · وسطوره القائمة تبقى بمعرّفه */
export function deleteCostCenter(db: DB, id: string): void {
  if (id === GENERAL_COST_CENTER) throw new Error('مركز «عام» لا يُحذف');
  db.run(`UPDATE cost_centers SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
}

/** وصف التصفية بالأبعاد للعرض والتصدير · فارغٌ بلا تصفية */
export function dimsLabel(db: DB, f: Dims | null | undefined): string {
  if (!f) return '';
  const parts: string[] = [];
  const name = (sql: string, id: string) => db.get<{ n: string }>(sql, [id])?.n ?? '';
  if (f.propertyId) parts.push('العقار: ' + name(`SELECT name AS n FROM properties WHERE id = ?`, f.propertyId));
  if (f.unitId) parts.push('الوحدة: ' + name(`SELECT unit_no AS n FROM units WHERE id = ?`, f.unitId));
  if (f.contractId) parts.push('العقد: ' + name(`SELECT COALESCE(NULLIF(contract_no, ''), tenant_name) AS n FROM contracts WHERE id = ?`, f.contractId));
  if (f.costCenterId) parts.push('مركز التكلفة: ' + name(`SELECT name AS n FROM cost_centers WHERE id = ?`, f.costCenterId));
  return parts.join(' · ');
}
