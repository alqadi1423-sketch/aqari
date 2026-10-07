/**
 * المكتبة · فهرس مركزي فوق attachments: عشرة تصنيفات، تنقّل هرمي
 * (المكتبة ← التصنيف ← العقار ← الوحدة ← الملفات)، بحث يتجاوز الشجرة،
 * وكشف الملفات غير المرتبطة والمفقودة.
 */
import type { DB } from '../db/adapter';
import type { FilesEnv } from '../files/store';
import { blobPath, extOf } from '../files/store';

export const LIB_CATS: Record<string, { label: string; icon: string }> = {
  deed: { label: 'صكوك وملكية', icon: 'shield' },
  lease: { label: 'عقود الإيجار', icon: 'contract' },
  tenant_id: { label: 'هويات المستأجرين', icon: 'card' },
  claim: { label: 'مطالبات وأضرار', icon: 'claim' },
  receipt: { label: 'إيصالات وسندات', icon: 'invoice' },
  purchase: { label: 'فواتير مشتريات', icon: 'wrench' },
  handover: { label: 'محاضر استلام وتسليم', icon: 'clipboard' },
  company: { label: 'مستندات المنشأة', icon: 'building' },
  photo: { label: 'صور العقارات والوحدات', icon: 'library' },
  other: { label: 'غير مصنَّف', icon: 'archive' },
};

export const libCat = (c: string) => LIB_CATS[c] || LIB_CATS.other;

/**
 * التصنيف المشتق من نوع الكيان ونوع الملف · المكتبة تعرض كل المرفقات
 * وكل ملف يقع تحت تصنيفه حسب مصدره (البند ١٣) · يطابق LIB_CAT_SQL حرفياً
 */
export function libCatFor(entityType: string, kind: string): string {
  const k = (kind || '').trim();
  switch (entityType) {
    case 'contract':
      if (k === 'handover' || k.includes('محضر') || k.includes('استلام') || k.includes('تسليم')) return 'handover';
      if (k === 'receipt' || k === 'statement') return 'receipt';
      return 'lease';
    case 'handover': return 'handover';
    case 'purchase':
    case 'supplier': return 'purchase';
    case 'payment':
    case 'invoice': return 'receipt';
    case 'property': return k === 'deed' || k === 'صك' ? 'deed' : 'photo';
    case 'unit': return 'photo';
    case 'tenant':
    case 'occupant': return 'tenant_id';
    case 'claim': return k === 'purchase' ? 'purchase' : 'claim';
    case 'company':
    case 'company_doc': return 'company';
    default: return LIB_CATS[k] ? k : 'other';
  }
}

const KNOWN_CATS_SQL = Object.keys(LIB_CATS).map((k) => `'${k}'`).join(', ');

/**
 * نفس اشتقاق التصنيف داخل SQL (المرفق بالاسم المستعار a) مع أولوية cat_override ·
 * يسمح للشاشات بالترشيح وتقسيم الصفحات في الاستعلام · يجب أن يبقى مطابقاً لـ libCatFor
 */
export const LIB_CAT_SQL = `CASE
  WHEN a.cat_override IS NOT NULL AND a.cat_override <> '' THEN a.cat_override
  WHEN a.entity_type = 'contract' THEN CASE
    WHEN a.kind = 'handover' OR a.kind LIKE '%محضر%' OR a.kind LIKE '%استلام%' OR a.kind LIKE '%تسليم%' THEN 'handover'
    WHEN a.kind IN ('receipt', 'statement') THEN 'receipt'
    ELSE 'lease' END
  WHEN a.entity_type = 'handover' THEN 'handover'
  WHEN a.entity_type IN ('purchase', 'supplier') THEN 'purchase'
  WHEN a.entity_type IN ('payment', 'invoice') THEN 'receipt'
  WHEN a.entity_type = 'property' THEN CASE WHEN a.kind IN ('deed', 'صك') THEN 'deed' ELSE 'photo' END
  WHEN a.entity_type = 'unit' THEN 'photo'
  WHEN a.entity_type IN ('tenant', 'occupant') THEN 'tenant_id'
  WHEN a.entity_type = 'claim' THEN CASE WHEN a.kind = 'purchase' THEN 'purchase' ELSE 'claim' END
  WHEN a.entity_type IN ('company', 'company_doc') THEN 'company'
  WHEN a.kind IN (${KNOWN_CATS_SQL}) THEN a.kind
  ELSE 'other' END`;

export interface LibraryFile {
  id: string;
  sha256: string;
  ext: string;
  sizeBytes: number;
  name: string;
  mime: string;
  note: string;
  cat: string;
  link: string;
  propertyId: string | null;
  unitId: string | null;
  createdAt: string;
  missing: boolean;
  isImage: boolean;
  /** المصغّرة الخفيفة المزامَنة مع صفّه · يظهر بها الملف الذي في الخادم ولم يُنزَّل */
  thumb: string | null;
}

/**
 * كل ملفات المكتبة الحية مع تصنيفها وارتباطها بالعقار/الوحدة وكشف المفقود ·
 * القاعدة الملزمة: كل صف في attachments غير محذوف deleted_at يظهر هنا، لذا
 * الانضمام مع blobs يسار (LEFT JOIN) لا داخلي: مرفق مستورد من نسخة قديمة بلا
 * صف blob لا يختفي بل يظهر موسوماً بالفقدان إن غاب ملفه الفعلي.
 */
export function libraryFiles(env: FilesEnv): LibraryFile[] {
  const db = env.db;
  const rows = db.all<{
    id: string; sha256: string; ext: string | null; size_bytes: number | null;
    original_name: string; display_name: string; mime: string; note: string;
    kind: string; cat_override: string | null;
    entity_type: string; entity_id: string; created_at: string; thumb: string | null;
  }>(
    `SELECT a.id, a.sha256, b.ext, b.size_bytes, a.original_name, a.display_name, a.mime, a.note,
            a.kind, a.cat_override, a.entity_type, a.entity_id, a.created_at, a.thumb
     FROM attachments a LEFT JOIN blobs b ON b.sha256 = a.sha256
     WHERE a.deleted_at IS NULL
     ORDER BY a.created_at DESC`
  );
  const unitProp = new Map(
    db.all<{ id: string; property_id: string; unit_no: string }>(
      `SELECT id, property_id, unit_no FROM units`
    ).map((u) => [u.id, u])
  );
  // كل جداول الربط تُقرأ دفعة واحدة · لا استعلام لكل ملف
  const contractsMap = new Map(
    db.all<{ id: string; unit_id: string | null; tenant_name: string }>(
      `SELECT id, unit_id, tenant_name FROM contracts`
    ).map((c) => [c.id, c])
  );
  const claimsMap = new Map(
    db.all<{ id: string; contract_id: string }>(`SELECT id, contract_id FROM claims`).map((c) => [c.id, c])
  );
  const purchasesMap = new Map(
    db.all<{ id: string; unit_id: string | null; property_id: string | null; supplier_name: string }>(
      `SELECT id, unit_id, property_id, supplier_name FROM purchases`
    ).map((p) => [p.id, p])
  );
  const handoversMap = new Map(
    db.all<{ id: string; unit_id: string | null }>(`SELECT id, unit_id FROM handovers`).map((h) => [h.id, h])
  );
  const tenantsMap = new Map(
    db.all<{ id: string; name: string }>(`SELECT id, name FROM tenants`).map((t) => [t.id, t])
  );
  const occupantsMap = new Map(
    db.all<{ id: string; unit_id: string | null; name: string }>(
      `SELECT id, unit_id, name FROM occupants`
    ).map((o) => [o.id, o])
  );
  const paymentsMap = new Map(
    db.all<{ id: string; contract_id: string }>(`SELECT id, contract_id FROM contract_payments /* تشمل الملغاة: مرفق الدفعة يبقى في المكتبة */`).map((p) => [p.id, p])
  );
  const suppliersMap = new Map(
    db.all<{ id: string; name: string }>(`SELECT id, name FROM suppliers`).map((s) => [s.id, s])
  );
  const invoicesMap = new Map(
    db.all<{ id: string; no: string }>(`SELECT id, no FROM invoices`).map((v) => [v.id, v])
  );
  // قراءة مجلد المرفقات مرة واحدة بدل فحص القرص لكل ملف · يتحمل آلاف الملفات
  let onDisk: Set<string> | null = null;
  try { onDisk = new Set(env.fs.list(env.attachmentsDir)); } catch { onDisk = null; }
  return rows.map((r) => {
    let propertyId: string | null = null;
    let unitId: string | null = null;
    let link = '';
    switch (r.entity_type) {
      case 'property': propertyId = r.entity_id; link = 'عقار'; break;
      case 'unit': {
        unitId = r.entity_id;
        propertyId = unitProp.get(r.entity_id)?.property_id ?? null;
        link = 'وحدة';
        break;
      }
      case 'contract': {
        const c = contractsMap.get(r.entity_id);
        if (c) {
          unitId = c.unit_id;
          propertyId = c.unit_id ? unitProp.get(c.unit_id)?.property_id ?? null : null;
          link = 'عقد: ' + c.tenant_name;
        }
        break;
      }
      case 'claim': {
        const cl = claimsMap.get(r.entity_id);
        const c = cl ? contractsMap.get(cl.contract_id) : undefined;
        if (c) {
          unitId = c.unit_id;
          propertyId = c.unit_id ? unitProp.get(c.unit_id)?.property_id ?? null : null;
          link = 'مطالبة: ' + c.tenant_name;
        }
        break;
      }
      case 'purchase': {
        const p = purchasesMap.get(r.entity_id);
        if (p) {
          unitId = p.unit_id;
          propertyId = p.property_id ?? (p.unit_id ? unitProp.get(p.unit_id)?.property_id ?? null : null);
          link = 'فاتورة شراء: ' + p.supplier_name;
        }
        break;
      }
      case 'handover': {
        const h = handoversMap.get(r.entity_id);
        if (h?.unit_id) {
          unitId = h.unit_id;
          propertyId = unitProp.get(h.unit_id)?.property_id ?? null;
        }
        link = 'محضر تسليم';
        break;
      }
      case 'tenant': {
        link = 'مستأجر: ' + (tenantsMap.get(r.entity_id)?.name ?? 'محذوف');
        break;
      }
      case 'occupant': {
        const o = occupantsMap.get(r.entity_id);
        if (o?.unit_id) {
          unitId = o.unit_id;
          propertyId = unitProp.get(o.unit_id)?.property_id ?? null;
        }
        link = 'ساكن: ' + (o?.name ?? 'محذوف');
        break;
      }
      case 'payment': {
        const pm = paymentsMap.get(r.entity_id);
        const c = pm ? contractsMap.get(pm.contract_id) : undefined;
        if (c) {
          unitId = c.unit_id;
          propertyId = c.unit_id ? unitProp.get(c.unit_id)?.property_id ?? null : null;
          link = 'سند قبض: ' + c.tenant_name;
        } else link = 'سند قبض';
        break;
      }
      case 'supplier': {
        link = 'مورد: ' + (suppliersMap.get(r.entity_id)?.name ?? 'محذوف');
        break;
      }
      case 'invoice': {
        link = 'فاتورة ' + (invoicesMap.get(r.entity_id)?.no ?? 'محذوفة');
        break;
      }
      case 'company':
      case 'company_doc': link = 'المنشأة'; break;
      case 'library': link = 'رفع مباشر'; break;
    }
    const isImage = (r.mime || '').startsWith('image');
    // بلا صف blob (استيراد قديم) يُشتق الامتداد من الاسم أو النوع ليبقى الفتح ممكناً إن وُجد الملف
    const ext = r.ext || extOf(r.original_name, r.mime);
    return {
      id: r.id,
      sha256: r.sha256,
      ext,
      sizeBytes: Number(r.size_bytes ?? 0),
      name: r.display_name || r.original_name || 'ملف',
      mime: r.mime,
      note: r.note,
      cat: r.cat_override || libCatFor(r.entity_type, r.kind),
      link,
      propertyId,
      unitId,
      createdAt: r.created_at,
      missing: onDisk ? !onDisk.has(`${r.sha256}.${ext}`) : !env.fs.exists(blobPath(env, r.sha256, ext)),
      isImage,
      thumb: r.thumb ?? null,
    };
  });
}

export type LibSort = 'new' | 'old' | 'name' | 'size';

export function sortLibrary(rows: LibraryFile[], sort: LibSort): LibraryFile[] {
  const out = [...rows];
  out.sort((a, b) =>
    sort === 'new' ? (a.createdAt < b.createdAt ? 1 : -1)
    : sort === 'old' ? (a.createdAt > b.createdAt ? 1 : -1)
    : sort === 'size' ? b.sizeBytes - a.sizeBytes
    : String(a.name).localeCompare(String(b.name), 'ar')
  );
  return out;
}

/** البحث يتجاوز الشجرة */
export function searchLibrary(rows: LibraryFile[], q: string): LibraryFile[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) =>
    [r.name, r.link, r.note, libCat(r.cat).label].some(
      (v) => v && v.toLowerCase().includes(needle)
    )
  );
}

export function libSizeLabel(b: number): string {
  // الصفر قيمة لا غياب · يُعرض رقماً لا «لا يوجد»
  if (!b) return '0 ب';
  if (b < 1024) return b + ' ب';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' ك.ب';
  return (b / 1048576).toFixed(1) + ' م.ب';
}

/** تعديل بيانات ملف من المكتبة */
export function updateLibraryFile(
  db: DB,
  id: string,
  patch: { name?: string; note?: string; cat?: string }
): void {
  db.transaction(() => {
    if (patch.name !== undefined) db.run(`UPDATE attachments SET display_name = ? WHERE id = ?`, [patch.name, id]);
    if (patch.note !== undefined) db.run(`UPDATE attachments SET note = ? WHERE id = ?`, [patch.note, id]);
    if (patch.cat !== undefined) db.run(`UPDATE attachments SET cat_override = ? WHERE id = ?`, [patch.cat, id]);
  });
}
