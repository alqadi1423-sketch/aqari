/**
 * ربط الرسالة بسجل (المواصفة): «يفتحه من له صلاحية عليه، ومن لا صلاحية له يرى اسمه فقط».
 * يُفتح السجل حين يجيز المسارُ قسمه لهذا المستخدم ويكون السجل نفسه على جهازه (والعضو لا يصله إلا ما يجيزه
 * نطاقه) · وطلب الصيانة مصمَّم ولا يُفتح حتى يُبنى.
 */
import type { DB } from '../db/adapter';
import type { Access } from '../domain/access/access';
import { routeAllowed } from '../domain/access/routes';
import type { ChatLink, ChatLinkType } from './types';

const ROUTE: Record<ChatLinkType, string | null> = {
  contract: '/contracts',
  unit: '/units',
  asset: '/assets',
  maintenance: null,
};

const EXISTS: Record<Exclude<ChatLinkType, 'maintenance'>, string> = {
  contract: `SELECT 1 FROM contracts WHERE id = ? AND deleted_at IS NULL`,
  unit: `SELECT 1 FROM units WHERE id = ? AND deleted_at IS NULL`,
  asset: `SELECT 1 FROM assets WHERE id = ? AND deleted_at IS NULL`,
};

export interface LinkTarget { canOpen: boolean; route: string | null }

const DRAFT = 'مسودة'; // i18n-exempt: حالة العقد المخزّنة

export function linkTarget(db: DB, access: Access, link: ChatLink): LinkTarget {
  const route = ROUTE[link.type];
  if (!route || link.type === 'maintenance') return { canOpen: false, route: null };
  if (!routeAllowed(access, route)) return { canOpen: false, route: null };
  let found = false;
  try { found = !!db.get(EXISTS[link.type], [link.id]); } catch { found = false; }
  return { canOpen: found, route: found ? route : null };
}

/**
 * ما يُربط به من جهاز المرسل · ما يراه هو وحده (العضو لا تصله إلا سجلات نطاقه) · propertyId: سجلات عقارٍ بعينه
 * (محادثة العقار تجمع ما يخصه · الدفعة ٤)
 */
export function linkCandidates(db: DB, access: Access, type: Exclude<ChatLinkType, 'maintenance'>, q = '', limit = 50, propertyId: string | null = null): ChatLink[] {
  if (!routeAllowed(access, ROUTE[type]!)) return [];
  const like = '%' + q.trim() + '%';
  const prop = propertyId ?? '';
  try {
    if (type === 'contract') {
      return db.all<{ id: string; label: string }>(
        `SELECT c.id, COALESCE(NULLIF(c.contract_no, ''), '#') || ' · ' || c.unit_label AS label
         FROM contracts c LEFT JOIN units u ON u.id = c.unit_id
         WHERE c.deleted_at IS NULL AND c.status != ? AND (? = '' OR u.property_id = ?)
           AND (c.tenant_name LIKE ? OR COALESCE(c.contract_no,'') LIKE ? OR c.unit_label LIKE ?)
         ORDER BY COALESCE(c.start, '') DESC LIMIT ?`, [DRAFT, prop, prop, like, like, like, limit])
        .map((r) => ({ type, id: r.id, label: r.label }));
    }
    if (type === 'unit') {
      return db.all<{ id: string; label: string }>(
        `SELECT u.id, COALESCE(p.name, '') || ' · ' || u.unit_no AS label FROM units u
         LEFT JOIN properties p ON p.id = u.property_id
         WHERE u.deleted_at IS NULL AND (? = '' OR u.property_id = ?) AND (u.unit_no LIKE ? OR COALESCE(p.name,'') LIKE ?)
         ORDER BY p.name, u.unit_no LIMIT ?`, [prop, prop, like, like, limit])
        .map((r) => ({ type, id: r.id, label: r.label }));
    }
    return db.all<{ id: string; label: string }>(
      `SELECT id, name AS label FROM assets WHERE deleted_at IS NULL AND (? = '' OR property_id = ?) AND name LIKE ? ORDER BY name LIMIT ?`,
      [prop, prop, like, limit])
      .map((r) => ({ type, id: r.id, label: r.label }));
  } catch {
    return [];
  }
}
