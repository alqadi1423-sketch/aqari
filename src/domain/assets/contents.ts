/**
 * تحويل محتويات الوحدات القائمة إلى أصول (موجز الأصول §٦): الترحيلة لا تحوّل شيئاً آلياً ·
 * الأداة تعرض كل وحدة وبنودها والفئة المقترحة من الاسم (تُعدَّل)، وتُنفَّذ لوحدةٍ أو للكل بعد المراجعة.
 * كل بند يصير أصلاً «في الخدمة» و«بانتظار تكلفة» بلا قيد، ووصفه في ملاحظاته · والبند المحوَّل لا يُحوَّل ثانية.
 */
import type { DB } from '../../db/adapter';
import { logAudit } from '../audit';
import { suggestCategory, isAssetCategory } from './catalog';
import { createPendingAsset } from './service';

const AUDIT = 'الأصول'; // i18n-exempt: وحدة سجل العمليات المخزّنة

export interface ContentItem {
  unitId: string;
  unitNo: string;
  propertyName: string;
  room: string;
  name: string;
  descr: string;
  suggested: string | null;
  converted: boolean;
}

export function contentsCandidates(db: DB, unitId?: string | null): ContentItem[] {
  const rows = db.all<{ unit_id: string; unit_no: string; pname: string; room: string; name: string; descr: string }>(
    `SELECT r.unit_id, u.unit_no, p.name AS pname, r.room_name AS room, i.name, i.descr
     FROM unit_room_items i JOIN unit_rooms r ON r.id = i.room_id JOIN units u ON u.id = r.unit_id JOIN properties p ON p.id = u.property_id
     WHERE u.deleted_at IS NULL AND p.deleted_at IS NULL AND TRIM(i.name) != '' ${unitId ? 'AND r.unit_id = ?' : ''}
     ORDER BY p.name, COALESCE(u.unit_no_key, u.unit_no), r.sort, i.sort`, unitId ? [unitId] : []);
  return rows.map((r) => ({
    unitId: r.unit_id, unitNo: r.unit_no, propertyName: r.pname, room: r.room.trim(), name: r.name.trim(), descr: r.descr.trim(),
    suggested: suggestCategory(r.name),
    converted: !!db.get(`SELECT 1 FROM assets WHERE unit_id = ? AND room = ? AND name = ? AND deleted_at IS NULL`, [r.unit_id, r.room.trim(), r.name.trim()]),
  }));
}

/** ينشئ أصلاً «بانتظار تكلفة» لكل بندٍ مختار بفئته · ويعيد عدد ما أُنشئ */
export function convertContents(db: DB, items: Array<{ unitId: string; room: string; name: string; descr: string; category: string }>): number {
  let n = 0;
  db.transaction(() => {
    for (const it of items) {
      if (!isAssetCategory(it.category)) continue;
      if (db.get(`SELECT 1 FROM assets WHERE unit_id = ? AND room = ? AND name = ? AND deleted_at IS NULL`, [it.unitId, it.room, it.name])) continue;
      createPendingAsset(db, { name: it.name, category: it.category, unitId: it.unitId, room: it.room, notes: it.descr, source: 'contents' });
      n++;
    }
    if (n) logAudit(db, AUDIT, 'create', 'contents', String(n));
  });
  return n;
}
