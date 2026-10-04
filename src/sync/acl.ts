/**
 * رؤية كل مستند في المنشأة (docs/PERMISSIONS.md §٣) · يُحسب عند الرفع من القاعدة المحلية:
 *  - pids: عقارات الصف (الدفعة ← العقد ← الوحدة ← العقار) · '*' للصف العام.
 *  - g: رموز «قسم|عقار» لكل قسم يقرؤه، و«قسم|@» يطابقها العضو ذو كل العقارات.
 *  - op: قسم العملية التي تجيز الكتابة لهذا العضو (القواعد تتحقق منه) · والمالك لا يحتاجه.
 *  - by: كاتب المسودة (العقد والفاتورة والقيد) · لا يتغير بعد الإنشاء.
 */
import type { DB } from '../db/adapter';
import type { RemoteDoc, RowData } from './types';
import type { Access } from '../domain/access/access';
import { level } from '../domain/access/access';
import { SECTION_KEYS, type SectionKey } from '../domain/access/sections';
import { moneySplit, publicFields, readSectionsOf } from '../domain/access/readSections';
import { OP_WRITES } from '../domain/access/opWrites';

export const ORG_WIDE = '*';
export const ANY_PROP = '@';
export const DRAFT_TABLES = new Set(['contracts', 'invoices', 'journal_entries']);

const one = (db: DB, sql: string, p: unknown[]): string | null =>
  (db.get<{ v: string | null }>(sql, p as never)?.v ?? null);

function unitProp(db: DB, unitId: unknown): string | null {
  return unitId ? one(db, `SELECT property_id AS v FROM units WHERE id = ?`, [unitId]) : null;
}
function contractProp(db: DB, contractId: unknown): string | null {
  return contractId ? unitProp(db, one(db, `SELECT unit_id AS v FROM contracts WHERE id = ?`, [contractId])) : null;
}

/** المصدر الذي يحمله القيد · يُبحث معرّفه في جداول المصادر بالترتيب */
const SOURCE_TABLES = ['contract_payments', 'contracts', 'claims', 'reservations', 'key_money_deals', 'purchases', 'invoices', 'contract_installments'];

/** عقارات الصف · فارغة لا تكون: ما لا عقار له صفٌّ عام */
export function rowPids(db: DB, table: string, row: RowData | null, depth = 0): string[] {
  if (!row) return [ORG_WIDE];
  const r = row as Record<string, unknown>;
  let p: string | null = null;
  if (table === 'properties') p = String(r.id);
  else if (table === 'tenants') {
    const ps = db.all<{ v: string }>(
      `SELECT DISTINCT u.property_id AS v FROM contracts c JOIN units u ON u.id = c.unit_id WHERE c.tenant_id = ? AND c.deleted_at IS NULL`, [r.id as string]);
    return ps.length ? ps.map((x) => x.v) : [ORG_WIDE];
  } else if (table === 'meters') {
    p = r.owner_type === 'property' ? String(r.owner_id) : unitProp(db, r.owner_id);
  } else if (table === 'journal_entries') {
    if (depth > 0 || !r.src_id) return [ORG_WIDE];
    for (const t of SOURCE_TABLES) {
      const src = db.get<RowData>(`SELECT * FROM ${t} WHERE id = ?`, [r.src_id as string]);
      if (src) return rowPids(db, t, src, depth + 1);
    }
    return [ORG_WIDE];
  } else if (r.property_id) p = String(r.property_id);
  else if (r.unit_id) p = unitProp(db, r.unit_id);
  else if (r.contract_id) p = contractProp(db, r.contract_id);
  else if (r.room_id) p = unitProp(db, one(db, `SELECT unit_id AS v FROM unit_rooms WHERE id = ?`, [r.room_id]));
  else if (r.area_id) p = one(db, `SELECT property_id AS v FROM property_areas WHERE id = ?`, [r.area_id]);
  else if (r.payment_id) p = contractProp(db, one(db, `SELECT contract_id AS v FROM contract_payments WHERE id = ?`, [r.payment_id]));
  else if (r.meter_id) {
    const m = db.get<{ owner_type: string; owner_id: string }>(`SELECT owner_type, owner_id FROM meters WHERE id = ?`, [r.meter_id as string]);
    p = m ? (m.owner_type === 'property' ? m.owner_id : unitProp(db, m.owner_id)) : null;
  }
  return [p ?? ORG_WIDE];
}

/** رموز الرؤية لقرّاءٍ وعقارات */
export function tokensFor(readers: SectionKey[], pids: string[]): string[] {
  const out = new Set<string>();
  for (const s of readers) {
    out.add(s + '|' + ANY_PROP);
    for (const p of pids) out.add(s + '|' + p);
  }
  return [...out].sort();
}

/** رموز العضو · يكتبها المالك في مستند العضوية (القواعد تقرؤها، والسحب يستعلم بها) */
export function memberTokens(a: Pick<Access, 'owner' | 'perms' | 'allProps' | 'props'>): string[] {
  const out: string[] = [];
  for (const s of SECTION_KEYS) {
    if (level({ ...a, owner: false, uid: null }, s) < 1) continue;
    if (a.allProps) { out.push(s + '|' + ANY_PROP); continue; }
    for (const p of [...a.props, ORG_WIDE]) out.push(s + '|' + p);
  }
  return out;
}

/**
 * قسم العملية لكتابة عضو · الأقوى أولاً: جدول القسم بمستوى كامل، ثم ما ينشئه بإدخال،
 * ثم ما يمسّه جانبياً بإدخال. null: لا قسم يجيزها، فلا تُرفع (القواعد سترفضها أصلاً).
 */
export function chooseOp(a: Access, table: string): SectionKey | null {
  const entries = Object.entries(OP_WRITES) as Array<[SectionKey, NonNullable<(typeof OP_WRITES)[SectionKey]>]>;
  const lv = (s: SectionKey) => level(a, s);
  return entries.find(([s, w]) => w.own.includes(table) && lv(s) >= 3)?.[0]
    ?? entries.find(([s, w]) => (w.create.includes(table) || w.own.includes(table)) && lv(s) >= 2)?.[0]
    ?? entries.find(([s, w]) => !!w.touch?.[table] && lv(s) >= 2)?.[0]
    ?? null;
}

export interface AclDocs {
  /** المستند الكامل بحقول الرؤية */
  doc: RemoteDoc;
  /** الإسقاط بلا مبالغ لقرّاء غير ماليين · null إن لم يلزم */
  pub: RemoteDoc | null;
}

/** يزيّن مستنداً خارجاً بحقول الرؤية والكتابة · ويبني إسقاطه إن لزم */
export function annotate(db: DB, doc: RemoteDoc, a: Access): AclDocs {
  const row = doc.d;
  const pids = row ? rowPids(db, doc.t, row) : (doc.pids ?? [ORG_WIDE]);
  const readers = readSectionsOf(doc.t, row as Record<string, unknown> | null);
  const { full, pub } = moneySplit(row as Record<string, unknown> | null, readers);
  const extra: Partial<RemoteDoc> = { pids, g: tokensFor(full, pids) };
  if (!a.owner) {
    const op = chooseOp(a, doc.t);
    if (op) extra.op = op;
  }
  if (DRAFT_TABLES.has(doc.t)) {
    const by = one(db, `SELECT uid AS v FROM row_by WHERE tbl = ? AND pk = ?`, [doc.t, doc.k]);
    if (by) extra.by = by;
  }
  const out: RemoteDoc = { ...doc, ...extra };
  if (!pub.length) return { doc: out, pub: null };
  const pubDoc: RemoteDoc = {
    ...out,
    id: doc.t + '~pub__' + doc.k,
    t: doc.t + '~pub',
    d: row ? (publicFields(row) as RowData) : null,
    g: tokensFor(pub, pids),
  };
  return { doc: out, pub: pubDoc };
}
