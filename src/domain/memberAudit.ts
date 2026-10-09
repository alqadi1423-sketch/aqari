/**
 * سجل العمليات للأعضاء (دراسة القائم · قرار المالك 2026-10-09 أولاً ٥: «تسجيل منح الصلاحيات وإزالة العضو»): الدعوة ومنح
 * الصلاحية وتعديلها وإزالة العضو وإلغاء الدعوة سطورٌ بمنفّذها، بأقسامه وعقاراته قبل وبعد · الهوية لا تُكتب (يقرأ السجلَّ غيرُ المالك)
 */
import type { DB } from '../db/adapter';
import { logAudit } from './audit';
import { GRANTABLE, LEVEL_LABEL, type Level, type Perms } from './access/sections';

export interface MemberAccessDoc { email: string; perm: Perms; all: boolean; props: string[] }
export type MemberAccessEvent = 'invite' | 'grant' | 'remove' | 'revoke';

/** ملخص الصلاحية بسطر: الأقسام المفتوحة بمستوياتها */
export function permLine(perm: Perms): string {
  const parts = GRANTABLE.filter((s) => (perm[s.key] ?? 0) > 0).map((s) => s.label + ': ' + LEVEL_LABEL[perm[s.key] as Level]);
  return parts.length ? parts.join(' · ') : 'لا أقسام'; // i18n-exempt: قيمة مخزّنة في سجل العمليات
}

function view(db: DB, d: MemberAccessDoc | null): Record<string, string> | null {
  if (!d) return null;
  const name = (id: string) => db.get<{ n: string }>(`SELECT name AS n FROM properties WHERE id = ?`, [id])?.n ?? id;
  return {
    الأقسام: permLine(d.perm ?? {}),
    العقارات: d.all ? 'كل العقارات' : (d.props ?? []).map(name).join('، '), // i18n-exempt: قيمة مخزّنة في سجل العمليات
  };
}

const KIND: Record<MemberAccessEvent, ['create' | 'update' | 'delete', string]> = {
  invite: ['create', 'دعوة عضو'], // i18n-exempt: نوع مخزّن في سجل العمليات
  grant: ['update', 'صلاحية عضو'], // i18n-exempt: نوع مخزّن في سجل العمليات
  remove: ['delete', 'إزالة عضو'], // i18n-exempt: نوع مخزّن في سجل العمليات
  revoke: ['delete', 'إلغاء دعوة'], // i18n-exempt: نوع مخزّن في سجل العمليات
};

/** سطر العضوية في سجل العمليات · المنح بلا تغيير لا يُكتب */
export function logMemberAccess(db: DB, ev: MemberAccessEvent, email: string,
  before: MemberAccessDoc | null, after: MemberAccessDoc | null): void {
  const b = view(db, before), a = view(db, after);
  if (ev === 'grant' && JSON.stringify(b) === JSON.stringify(a)) return;
  const [action, entity] = KIND[ev];
  logAudit(db, 'الأعضاء', action, entity, email, b, a); // i18n-exempt: وحدة مخزّنة في سجل العمليات
}
