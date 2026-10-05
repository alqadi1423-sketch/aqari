/**
 * عضوية هذا الجهاز · تُحفظ في sync_state (تخص الجهاز ولا تُزامَن كصف) وتُقرأ عند كل رسم.
 * بلا عضوية: الجهاز للمالك، كامل في كل قسم.
 */
import type { DB } from '../db/adapter';
import type { MemberProfile } from '../domain/access/profile';
import { getSyncState, setSyncState } from '../sync/engine';
import { OWNER_ACCESS, type Access } from '../domain/access/access';
import { SECTION_KEYS, type Level, type Perms } from '../domain/access/sections';

export interface Membership {
  /** رقم المنشأة = uid المالك */
  org: string;
  uid: string;
  perms: Perms;
  allProps: boolean;
  props: string[];
  /** بيانات العضو نفسه · لشاشة الإكمال وإعداداته، واسمه منفّذاً في سجل العمليات */
  profile?: MemberProfile;
}

const KEY = 'membership';

function cleanPerms(p: unknown): Perms {
  const out: Perms = {};
  if (!p || typeof p !== 'object') return out;
  for (const k of SECTION_KEYS) {
    const v = (p as Record<string, unknown>)[k];
    if (v === 1 || v === 2 || v === 3) out[k] = v as Level;
  }
  return out;
}

export function readMembership(db: DB): Membership | null {
  const raw = getSyncState(db, KEY);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Partial<Membership>;
    if (typeof m.org !== 'string' || typeof m.uid !== 'string') return null;
    return {
      org: m.org, uid: m.uid, perms: cleanPerms(m.perms),
      allProps: m.allProps === true,
      props: Array.isArray(m.props) ? m.props.filter((x): x is string => typeof x === 'string') : [],
      profile: m.profile && typeof m.profile === 'object'
        ? { name: String(m.profile.name ?? ''), phone: String(m.profile.phone ?? ''), nid: String(m.profile.nid ?? ''), title: String(m.profile.title ?? '') }
        : undefined,
    };
  } catch {
    return null;
  }
}

export function saveMembership(db: DB, m: Membership | null): void {
  setSyncState(db, KEY, m ? JSON.stringify(m) : null);
}

/** كاتب الصف الأول (الهجرة ٢٢) · للعقد والفاتورة والقيد وحدها · null لما لا يُعرف كاتبه */
export function rowBy(db: DB, tbl: 'contracts' | 'invoices' | 'journal_entries', pk: string): string | null {
  return db.get<{ uid: string }>(`SELECT uid FROM row_by WHERE tbl = ? AND pk = ?`, [tbl, pk])?.uid ?? null;
}

/**
 * صلاحية من يستعمل الجهاز · العضوية التالفة لا تفتح شيئاً (لا تعود مالكاً)
 */
export function readAccess(db: DB): Access {
  const raw = getSyncState(db, KEY);
  const uid = getSyncState(db, 'uid');
  if (!raw) return { ...OWNER_ACCESS, uid };
  const m = readMembership(db);
  if (!m) return { owner: false, uid, perms: {}, allProps: false, props: [] };
  return { owner: false, uid: m.uid, perms: m.perms, allProps: m.allProps, props: m.props };
}
