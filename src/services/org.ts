/**
 * المنشأة والأعضاء (docs/PERMISSIONS.md) · منطقٌ فوق عميل Firestore بلا وحدات الجهاز، فيُختبر على المحاكي.
 * رقم المنشأة = uid المالك. الأعضاء في orgs/{org}/members/{uid}، والدعوات في orgs/{org}/invites/{email}.
 */
import type { DB } from '../db/adapter';
import type { FirestoreRemote } from '../cloud/firestore';
import { getSyncState, setSyncState, seedOutbox } from '../sync/engine';
import { memberTokens } from '../sync/acl';
import { SECTION_KEYS, type Level, type Perms } from '../domain/access/sections';
import { readMembership, saveMembership, type Membership } from './access';

export interface MemberSpec {
  email: string;
  perms: Perms;
  allProps: boolean;
  props: string[];
}

/** مستند العضوية/الدعوة · الحقول نفسها في الاثنين (القواعد تشترط أن تُنسخ الدعوة حرفياً) */
export interface MemberDoc {
  email: string;
  perm: Perms;
  all: boolean;
  props: string[];
  tokens: string[];
  /** اسم المنشأة يُعرض للمدعوّ */
  orgName: string;
}

export const normEmail = (e: string) => e.trim().toLowerCase();

export function memberDoc(spec: MemberSpec, orgName: string): MemberDoc {
  const perm: Perms = {};
  for (const k of SECTION_KEYS) if ((spec.perms[k] ?? 0) > 0 && k !== 'admin') perm[k] = spec.perms[k] as Level;
  return {
    email: normEmail(spec.email), perm, all: spec.allProps, props: spec.allProps ? [] : [...spec.props].sort(),
    tokens: memberTokens({ owner: false, perms: perm, allProps: spec.allProps, props: spec.allProps ? [] : spec.props }),
    orgName,
  };
}

function asMemberDoc(d: Record<string, unknown>): MemberDoc {
  return {
    email: String(d.email ?? ''), perm: (d.perm ?? {}) as Perms, all: d.all === true,
    props: Array.isArray(d.props) ? (d.props as string[]) : [], tokens: Array.isArray(d.tokens) ? (d.tokens as string[]) : [],
    orgName: String(d.orgName ?? ''),
  };
}

/* ─── المالك ─── */

export async function sendInvite(remote: FirestoreRemote, org: string, spec: MemberSpec, orgName: string): Promise<MemberDoc> {
  const doc = memberDoc(spec, orgName);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(doc.email)) throw new Error('اكتب إيميل قوقل صحيحاً للعضو');
  await remote.setDoc(`orgs/${org}/invites/${doc.email}`, doc as unknown as Record<string, unknown>);
  return doc;
}

export async function listTeam(remote: FirestoreRemote, org: string): Promise<{
  members: Array<{ uid: string; doc: MemberDoc }>; invites: MemberDoc[];
}> {
  const [m, i] = await Promise.all([remote.listDocs(`orgs/${org}/members`), remote.listDocs(`orgs/${org}/invites`)]);
  return {
    members: m.map((x) => ({ uid: x.id, doc: asMemberDoc(x.data) })),
    invites: i.map((x) => asMemberDoc(x.data)),
  };
}

/** تعديل صلاحية عضو · يُكتب المستند كاملاً برموزه الجديدة */
export async function updateMember(remote: FirestoreRemote, org: string, uid: string, spec: MemberSpec, orgName: string): Promise<void> {
  await remote.setDoc(`orgs/${org}/members/${uid}`, memberDoc(spec, orgName) as unknown as Record<string, unknown>);
}

export const removeMember = (remote: FirestoreRemote, org: string, uid: string) => remote.deleteDoc(`orgs/${org}/members/${uid}`);
export const revokeInvite = (remote: FirestoreRemote, org: string, email: string) => remote.deleteDoc(`orgs/${org}/invites/${normEmail(email)}`);

/**
 * انتقال المالك إلى منشأته (orgs/{uid}) مرة · حروف الأجهزة تُنقل كما هي فيبقى أول جهاز بلا حرف،
 * وكل الصفوف تدخل الطابور ويُصفَّر مؤشر السحب كما في الانضمام. المسار القديم يبقى للقراءة ولا يُكتب.
 */
export async function moveOwnerToOrg(db: DB, legacy: FirestoreRemote, org: FirestoreRemote, uid: string): Promise<boolean> {
  if (getSyncState(db, 'org') === uid) return false;
  const letters = await org.getDoc(`orgs/${uid}/meta/devices`);
  if (!letters) {
    const old = await legacy.getDoc(`users/${uid}/meta/devices`);
    if (old) await org.setDoc(`orgs/${uid}/meta/devices`, old);
  }
  db.transaction(() => {
    db.run(`DELETE FROM sync_inbox`);
    setSyncState(db, 'cursor', null);
    seedOutbox(db);
    setSyncState(db, 'joining', '1');
    setSyncState(db, 'org', uid);
  });
  return true;
}

/* ─── العضو ─── */

export async function findInvites(remote: FirestoreRemote, email: string): Promise<Array<{ org: string; doc: MemberDoc }>> {
  return (await remote.invitesFor(normEmail(email))).map((x) => ({ org: x.org, doc: asMemberDoc(x.data) }));
}

/** قبول الدعوة: العضوية تُنشأ بنصّ الدعوة حرفياً ثم تُحذف الدعوة · والجهاز يُربط بالمنشأة */
export async function acceptInvite(db: DB, remote: FirestoreRemote, org: string, uid: string, invite: MemberDoc): Promise<Membership> {
  const raw = await remote.getDoc(`orgs/${org}/invites/${invite.email}`);
  if (!raw) throw new Error('الدعوة لم تعد قائمة · اطلب من صاحب المنشأة دعوة جديدة');
  await remote.setDoc(`orgs/${org}/members/${uid}`, raw);
  await remote.deleteDoc(`orgs/${org}/invites/${invite.email}`);
  const doc = asMemberDoc(raw);
  const m: Membership = { org, uid, perms: doc.perm, allProps: doc.all, props: doc.props };
  db.transaction(() => {
    saveMembership(db, m);
    setSyncState(db, 'org', org);
    setSyncState(db, 'org_name', doc.orgName || null);
    setSyncState(db, 'cursor', null);
  });
  return m;
}

/**
 * مقارنة العضوية المحفوظة بما في الخادم · 'removed' أُزيلت (يُمسح الجهاز)، و'changed' تغيّرت صلاحيته
 * (يُعاد السحب من أوله بصلاحيته الجديدة)، و'same' كما هي.
 */
export async function refreshMembership(db: DB, remote: FirestoreRemote): Promise<'same' | 'changed' | 'removed' | 'none'> {
  const m = readMembership(db);
  if (!m) return 'none';
  const raw = await remote.getDoc(`orgs/${m.org}/members/${m.uid}`);
  if (!raw) return 'removed';
  const doc = asMemberDoc(raw);
  const next: Membership = { org: m.org, uid: m.uid, perms: doc.perm, allProps: doc.all, props: doc.props };
  const same = JSON.stringify([m.perms, m.allProps, [...m.props].sort()]) === JSON.stringify([next.perms, next.allProps, [...next.props].sort()]);
  if (same) return 'same';
  saveMembership(db, next);
  return 'changed';
}

/** مغادرة العضو المنشأة بنفسه · تُحذف عضويته من الخادم، ومسح الجهاز على المستدعي */
export const leaveOrg = (remote: FirestoreRemote, org: string, uid: string) => remote.deleteDoc(`orgs/${org}/members/${uid}`);
