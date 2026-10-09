/**
 * صلاحية من يستعمل الجهاز الآن · المالك كامل في كل قسم، والعضو بخريطته وعقاراته.
 * دوالّ خالصة يستعملها التنقل والحارس والأزرار، وتُختبر بلا واجهة.
 */
import { levelOf, type Level, type Perms, type SectionKey } from './sections';

export interface Access {
  /** صاحب المنشأة · وحده له «الأعضاء والإعدادات» */
  owner: boolean;
  /** uid من يستعمل الجهاز · لمسودته */
  uid: string | null;
  perms: Perms;
  /** كل العقارات · وإلا فقائمة props */
  allProps: boolean;
  props: string[];
}

export const OWNER_ACCESS: Access = { owner: true, uid: null, perms: {}, allProps: true, props: [] };

export function level(a: Access, k: SectionKey): Level {
  if (a.owner) return 3;
  return levelOf(a.perms, k);
}

export const canView = (a: Access, k: SectionKey): boolean => level(a, k) >= 1;
export const canAdd = (a: Access, k: SectionKey): boolean => level(a, k) >= 2;
/** التعديل والإلغاء والحذف · كامل وحده */
export const canManage = (a: Access, k: SectionKey): boolean => level(a, k) >= 3;

/**
 * دمج المستأجرين: يحذف المكرَّرين ويعيد ربط عقودهم في كل العقارات، فهو لصاحب القسم كاملاً في كل العقارات وحده.
 * المحصور لا يرى عقود غيره، والسحابة ترفض حذفه مستأجراً مشتركاً، فيبقى عنده محذوفاً وعند غيره قائماً.
 */
export const canMergeTenants = (a: Access): boolean => canManage(a, 'tenants') && (a.owner || a.allProps);

/**
 * تعديل صفٍّ بعينه: كامل دائماً · وإدخال لمسودته هو وحده قبل ترحيلها (قرار المالك).
 * `by` كاتب الصف الأول، و`draft` أنه مسودة لم تُرحَّل.
 */
export function canEdit(a: Access, k: SectionKey, row?: { by?: string | null; draft?: boolean }): boolean {
  const l = level(a, k);
  if (l >= 3) return true;
  return l === 2 && !!row?.draft && !!a.uid && row.by === a.uid;
}

/** هل العقار ضمن عقارات العضو · الصف العام (بلا عقار) مسموح لمن له القسم */
export function propAllowed(a: Access, propertyId: string | null | undefined): boolean {
  if (a.owner || a.allProps || !propertyId) return true;
  return a.props.includes(propertyId);
}

export const isAdmin = (a: Access): boolean => a.owner;

/**
 * قرار المالك 2026-10-09 (ثانياً · المسائل الثلاث ٢): «النقل بين العقارات لمن له كلها، ويُخفى عن المحصور مع سببه» ·
 * القواعد ترفض تغيير عقار صفٍّ قائم من المحصور (رؤيته بعد النقل لا تسعها حدود الخادم)
 */
export function canMoveAcrossProperties(a: Access): boolean {
  return a.owner || a.allProps;
}

/** هل يُقفل عقار الصف في النموذج: صفٌّ قائم عند المحصور يبقى في عقاره، والجديد يختار من عقاراته */
export function propertyMoveLocked(a: Access, existing: boolean): boolean {
  return existing && !canMoveAcrossProperties(a);
}
