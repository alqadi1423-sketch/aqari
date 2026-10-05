/**
 * المنشأة والأعضاء (docs/PERMISSIONS.md) · منطقٌ فوق عميل Firestore بلا وحدات الجهاز، فيُختبر على المحاكي.
 * رقم المنشأة = uid المالك. الأعضاء في orgs/{org}/members/{uid}، والدعوات في orgs/{org}/invites/{email}.
 */
import type { DB } from '../db/adapter';
import type { FirestoreRemote } from '../cloud/firestore';
import { getSyncState, setSyncState, seedOutbox } from '../sync/engine';
import { hasUserData } from '../domain/backup/upgrade';
import { memberTokens } from '../sync/acl';
import { SECTION_KEYS, type Level, type Perms } from '../domain/access/sections';
import { readMembership, saveMembership, type Membership } from './access';
import { EMPTY_PROFILE, type MemberProfile } from '../domain/access/profile';

export interface MemberSpec {
  email: string;
  perms: Perms;
  allProps: boolean;
  props: string[];
  /** بيانات العضو · يملؤها المالك عند الدعوة أو بعدها، ويكملها العضو (موحَّدة بـ validateProfile) */
  profile?: MemberProfile;
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
  /** بيانات العضو · الهوية nid لا يقرؤها إلا المالك والعضو (مستند العضوية لا يقرؤه غيرهما) */
  name: string;
  phone: string;
  nid: string;
  title: string;
}

/** مفاتيح بيانات العضو · العضو يعدّل هذه وحدها في مستند عضويته (القواعد) */
export const PROFILE_KEYS = ['name', 'phone', 'nid', 'title'] as const;

export const profileOf = (d: MemberDoc): MemberProfile => ({ name: d.name, phone: d.phone, nid: d.nid, title: d.title });

export const normEmail = (e: string) => e.trim().toLowerCase();

export function memberDoc(spec: MemberSpec, orgName: string): MemberDoc {
  const perm: Perms = {};
  for (const k of SECTION_KEYS) if ((spec.perms[k] ?? 0) > 0 && k !== 'admin') perm[k] = spec.perms[k] as Level;
  return {
    email: normEmail(spec.email), perm, all: spec.allProps, props: spec.allProps ? [] : [...spec.props].sort(),
    tokens: memberTokens({ owner: false, perms: perm, allProps: spec.allProps, props: spec.allProps ? [] : spec.props }),
    orgName,
    ...(spec.profile ?? EMPTY_PROFILE),
  };
}

function asMemberDoc(d: Record<string, unknown>): MemberDoc {
  return {
    email: String(d.email ?? ''), perm: (d.perm ?? {}) as Perms, all: d.all === true,
    props: Array.isArray(d.props) ? (d.props as string[]) : [], tokens: Array.isArray(d.tokens) ? (d.tokens as string[]) : [],
    orgName: String(d.orgName ?? ''),
    name: String(d.name ?? ''), phone: String(d.phone ?? ''), nid: String(d.nid ?? ''), title: String(d.title ?? ''),
  };
}

/* ─── المالك ─── */

export async function sendInvite(
  remote: FirestoreRemote, org: string, spec: MemberSpec, orgName: string, ownerEmail: string,
): Promise<MemberDoc> {
  const doc = memberDoc(spec, orgName);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(doc.email)) throw new Error('اكتب إيميل قوقل صحيحاً للعضو');
  // لا دعوة للمالك نفسه ولا لعضو قائم (والقواعد ترفض الأولى أيضاً)
  if (doc.email === normEmail(ownerEmail)) throw new Error('هذا إيميلك أنت · المالك لا يُدعى إلى منشأته');
  const team = await listTeam(remote, org);
  if (team.members.some((m) => normEmail(m.doc.email) === doc.email)) throw new Error('هذا الإيميل عضو في المنشأة بالفعل · عدّل صلاحيته بدل دعوته');
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

/** تعديل صلاحية عضو · يُكتب المستند كاملاً برموزه الجديدة، وبياناته كما هي ما لم تُمرَّر */
export async function updateMember(remote: FirestoreRemote, org: string, uid: string, spec: MemberSpec, orgName: string): Promise<void> {
  const cur = spec.profile ? null : await remote.getDoc(`orgs/${org}/members/${uid}`);
  const profile = spec.profile ?? (cur ? profileOf(asMemberDoc(cur)) : EMPTY_PROFILE);
  await remote.setDoc(`orgs/${org}/members/${uid}`, memberDoc({ ...spec, profile }, orgName) as unknown as Record<string, unknown>);
}

/**
 * بيانات عضو · يعدّلها المالك أو العضو نفسه، والمستند كما هو عدا مفاتيحها (القواعد تفرض ذلك على العضو).
 * يعيد ما قبل التعديل وما بعده لسجل العمليات.
 */
export async function updateMemberProfile(
  remote: FirestoreRemote, org: string, uid: string, profile: MemberProfile,
): Promise<{ before: MemberProfile; after: MemberProfile }> {
  const cur = await remote.getDoc(`orgs/${org}/members/${uid}`);
  if (!cur) throw new Error('العضوية لم تعد قائمة');
  const before = profileOf(asMemberDoc(cur));
  await remote.setDoc(`orgs/${org}/members/${uid}`, { ...cur, ...profile });
  return { before, after: profile };
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
  const m: Membership = { org, uid, perms: doc.perm, allProps: doc.all, props: doc.props, profile: profileOf(doc) };
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
  const next: Membership = { org: m.org, uid: m.uid, perms: doc.perm, allProps: doc.all, props: doc.props, profile: profileOf(doc) };
  const same = JSON.stringify([m.perms, m.allProps, [...m.props].sort()]) === JSON.stringify([next.perms, next.allProps, [...next.props].sort()]);
  // تغيّر البيانات وحدها لا يعيد السحب · تُحفظ فقط
  if (same) {
    if (JSON.stringify(m.profile ?? null) !== JSON.stringify(next.profile)) saveMembership(db, next);
    return 'same';
  }
  saveMembership(db, next);
  return 'changed';
}

/** مغادرة العضو المنشأة بنفسه · تُحذف عضويته من الخادم، ومسح الجهاز على المستدعي */
export const leaveOrg = (remote: FirestoreRemote, org: string, uid: string) => remote.deleteDoc(`orgs/${org}/members/${uid}`);

/* ─── المسح الشامل (توجيه المالك ٢٠٢٦-١٠-٠٤) ─── */

/** عهد المسح في المنشأة · ٠ ما لم تُمسح أبداً */
export async function readEpoch(remote: FirestoreRemote, org: string): Promise<number> {
  const d = await remote.getDoc(`orgs/${org}/meta/epoch`);
  return d && typeof d.n === 'number' ? d.n : 0;
}

/**
 * مسح سحابة المنشأة: العهد يُرفع أولاً (فكل جهاز يفرّغ نسخته عند أول مزامنة ولا يرفع قديمه)، ثم تُحذف
 * الصفوف كلها، ثم يُعاد الحذف مرة لما رفعه جهازٌ في أثناء ذلك. يعيد العهد الجديد.
 */
export async function wipeOrgCloud(remote: FirestoreRemote, org: string, onProgress?: (m: string) => void): Promise<number> {
  const n = (await readEpoch(remote, org)) + 1;
  await remote.setDoc(`orgs/${org}/meta/epoch`, { n, at: new Date().toISOString() });
  onProgress?.('جاري مسح بيانات المنشأة من السحابة');
  await remote.deleteRowsOnly((k) => onProgress?.('جاري مسح بيانات المنشأة من السحابة · ' + k));
  await remote.deleteRowsOnly();
  return n;
}

/**
 * قبل كل مزامنة: هل مُسحت المنشأة بعد آخر ما يعرفه الجهاز؟ 'wipe' يُفرَّغ الجهاز ثم يسحب ·
 * 'adopt' جهاز لا يعرف عهداً ولا بيانات عليه (تثبيت جديد) فيأخذه · 'same' كما هو.
 */
export function epochAction(local: number | null, remote: number, hasData: boolean): 'wipe' | 'adopt' | 'same' {
  if (local === null) return remote > 0 && hasData ? 'wipe' : (remote > 0 ? 'adopt' : 'same');
  return remote > local ? 'wipe' : 'same';
}

/**
 * فحص العهد قبل المزامنة ثم العمل به · wipe يفرّغ الجهاز (بنسخة أمان) ويستدعيه المستدعي بما يناسب منصته
 */
export async function checkEpoch(db: DB, remote: FirestoreRemote, org: string, wipe: () => Promise<DB | void>): Promise<'wipe' | 'adopt' | 'same'> {
  const remoteEpoch = await readEpoch(remote, org);
  const raw = getSyncState(db, 'wipe_epoch');
  const act = epochAction(raw === null ? null : Number(raw), remoteEpoch, hasUserData(db));
  // القاعدة بعد التفريغ قد تكون غير التي قبله (تُفتح من جديد) · فالكتابة على ما يعيده التفريغ
  let live = db;
  if (act === 'wipe') {
    live = (await wipe()) ?? db;
    setSyncState(live, 'joining', '1');
  }
  if (act !== 'same') setSyncState(live, 'wipe_epoch', String(remoteEpoch));
  return act;
}
