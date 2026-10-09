/**
 * المنشأة والأعضاء (docs/PERMISSIONS.md) · منطقٌ فوق عميل Firestore بلا وحدات الجهاز، فيُختبر على المحاكي.
 * رقم المنشأة = uid المالك. الأعضاء في orgs/{org}/members/{uid}، والدعوات في orgs/{org}/invites/{email}.
 */
import type { DB } from '../db/adapter';
import { SCHEMA_VERSION } from '../db/schema';
import { FirestoreHttpError } from '../cloud/firestore';
import { t } from '../i18n';
import type { FirestoreRemote } from '../cloud/firestore';
import { getSyncState, setSyncState, seedOutbox } from '../sync/engine';
import { hasUserData } from '../domain/backup/upgrade';
import { memberTokens } from '../sync/acl';
import { SECTION_KEYS, type Level, type Perms } from '../domain/access/sections';
import { readMembership, saveMembership, type Membership } from './access';
import { EMPTY_PROFILE, type MemberProfile } from '../domain/access/profile';
import { pendingUnitMoves, PENDING_MOVES_KEY, type UnitMove } from '../domain/unitMove';

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
  // والدعوة تحمل إصدار المالك حدّاً أدنى، فيطلب الأقدمُ التحديث قبل الانضمام (#36) · وبريد صاحبها ظاهراً للمدعوّ (#52)
  await remote.setDoc(`orgs/${org}/invites/${doc.email}`, { ...doc, minApp: SCHEMA_VERSION, invitedBy: normEmail(ownerEmail) } as unknown as Record<string, unknown>);
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

const MEMBERSHIP_GONE = 'العضوية لم تعد قائمة';

/**
 * تعديل صلاحية عضو · يُكتب المستند كاملاً برموزه الجديدة، وبياناته من المستند القائم لا من النموذج، فلا يمسح ما عدّله
 * العضو بعد فتحه (دراسة القائم) · والبيانات تُكتب بمسارها (updateMemberProfile) · ويعيد الصلاحية قبله وبعده لسجل العمليات
 */
export async function updateMember(remote: FirestoreRemote, org: string, uid: string, spec: MemberSpec, orgName: string): Promise<{ before: MemberDoc; after: MemberDoc }> {
  const cur = await remote.getDoc(`orgs/${org}/members/${uid}`);
  if (!cur) throw new Error(MEMBERSHIP_GONE);
  const before = asMemberDoc(cur);
  const after = memberDoc({ ...spec, profile: profileOf(before) }, orgName);
  await remote.setDoc(`orgs/${org}/members/${uid}`, after as unknown as Record<string, unknown>);
  return { before, after };
}

/**
 * بيانات عضو · يعدّلها المالك أو العضو نفسه، والمستند كما هو عدا مفاتيحها (القواعد تفرض ذلك على العضو).
 * يعيد ما قبل التعديل وما بعده لسجل العمليات.
 */
export async function updateMemberProfile(
  remote: FirestoreRemote, org: string, uid: string, profile: MemberProfile,
): Promise<{ before: MemberProfile; after: MemberProfile }> {
  const cur = await remote.getDoc(`orgs/${org}/members/${uid}`);
  if (!cur) throw new Error(MEMBERSHIP_GONE);
  const before = profileOf(asMemberDoc(cur));
  await remote.setDoc(`orgs/${org}/members/${uid}`, { ...cur, ...profile });
  return { before, after: profile };
}

/** إزالة العضو ومعها دعوةٌ باقية بإيميله، فلا يعود بها بنفسه (مراجعة التثبيت #36) */
export const removeMember = (remote: FirestoreRemote, org: string, uid: string, email?: string) =>
  remote.commitDocs([], [`orgs/${org}/members/${uid}`, ...(email ? [`orgs/${org}/invites/${normEmail(email)}`] : [])]);
export const revokeInvite = (remote: FirestoreRemote, org: string, email: string) => remote.deleteDoc(`orgs/${org}/invites/${normEmail(email)}`);

/**
 * انتقال المالك إلى منشأته (orgs/{uid}) مرة · حروف الأجهزة وعدّاد الترقيم يُنقلان كما هما فلا يُعطى رقمٌ مرتين،
 * وكل الصفوف تدخل الطابور ويُصفَّر مؤشر السحب كما في الانضمام. المسار القديم يبقى للقراءة ولا يُكتب.
 */
export async function moveOwnerToOrg(db: DB, legacy: FirestoreRemote, org: FirestoreRemote, uid: string): Promise<boolean> {
  if (getSyncState(db, 'org') === uid) return false;
  const letters = await org.getDoc(`orgs/${uid}/meta/devices`);
  if (!letters) {
    const old = await legacy.getDoc(`users/${uid}/meta/devices`);
    if (old) await org.setDoc(`orgs/${uid}/meta/devices`, old);
  }
  if (!(await org.getDoc(`orgs/${uid}/meta/counters`))) {
    const old = await legacy.getDoc(`users/${uid}/meta/counters`);
    if (old) await org.setDoc(`orgs/${uid}/meta/counters`, old);
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

/** هل للحساب منشأةٌ قائمة في السحابة (حروف أجهزتها في المسار الجديد أو القديم) · ليُعرض قبل دعوات غيره (#52) */
export async function ownOrgExists(remote: FirestoreRemote, uid: string): Promise<boolean> {
  // عدّاد الترقيم يُنشأ مع أول مزامنة للمالك الجديد · وحروف الأجهزة تأتي من المسار القديم (التحقق المستقل من 21ff082)
  for (const path of [`orgs/${uid}/meta/counters`, `orgs/${uid}/meta/devices`, `users/${uid}/meta/devices`]) {
    try { if (await remote.getDoc(path)) return true; } catch { /* لا صلاحية أو لا اتصال · يُجرَّب التالي */ }
  }
  return false;
}

export type InviteChoice = { kind: 'own' } | { kind: 'invite'; org: string; orgName: string; by: string; doc: MemberDoc };

/** ما تعرضه بوابة الدخول بترتيبه: منشأة الحساب القائمة أولاً، ثم الدعوات ببريد أصحابها (مراجعة التثبيت #52) */
export function inviteChoices(ownOrg: boolean, invites: Array<{ org: string; doc: MemberDoc }>): InviteChoice[] {
  const list: InviteChoice[] = invites.map((i) => ({
    kind: 'invite', org: i.org, orgName: i.doc.orgName, by: String((i.doc as unknown as { invitedBy?: string }).invitedBy ?? ''), doc: i.doc,
  }));
  return ownOrg ? [{ kind: 'own' }, ...list] : list;
}

export async function findInvites(remote: FirestoreRemote, email: string): Promise<Array<{ org: string; doc: MemberDoc }>> {
  return (await remote.invitesFor(normEmail(email))).map((x) => ({ org: x.org, doc: asMemberDoc(x.data) }));
}

/** قبول الدعوة: العضوية تُنشأ بنصّ الدعوة حرفياً ثم تُحذف الدعوة · والجهاز يُربط بالمنشأة */
export async function acceptInvite(db: DB, remote: FirestoreRemote, org: string, uid: string, invite: MemberDoc): Promise<Membership> {
  const raw = await remote.getDoc(`orgs/${org}/invites/${invite.email}`);
  if (!raw) throw new Error('الدعوة لم تعد قائمة · اطلب من صاحب المنشأة دعوة جديدة');
  if (appTooOld(Number(raw.minApp ?? 0))) throw new Error(t('compat.updateBeforeJoin'));
  // العضوية والدعوة في التزامٍ واحد: القواعد ترفض عضويةً تبقى دعوتها (فلا تُعيد الدعوةُ الباقية المُزالَ) · مراجعة التثبيت #36
  await remote.commitDocs([{ path: `orgs/${org}/members/${uid}`, data: raw }], [`orgs/${org}/invites/${invite.email}`]);
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

/* ─── الحد الأدنى لإصدار التطبيق (#36 · قرار المالك 2026-10-09: «حد أدنى لإصدار التطبيق، والإصدار الأقدم يطلب
   التحديث قبل الانضمام أو المزامنة») · الإصدار رقم المخطط ─── */

const compatPath = (org: string) => `orgs/${org}/meta/compat`;

/** الحد وهل قواعده منشورة (قواعدٌ أقدم ترفض قراءته) · فلا يُرفع الإصدار مع الصفوف قبل نشرها */
export async function readCompat(remote: FirestoreRemote, org: string): Promise<{ live: boolean; min: number }> {
  try {
    const d = await remote.getDoc(compatPath(org));
    return { live: true, min: typeof d?.min === 'number' ? d.min : 0 };
  } catch (e) {
    if (e instanceof FirestoreHttpError && e.status === 403) return { live: false, min: 0 };
    throw e;
  }
}

/** جهاز المالك يرفع الحد إلى إصداره ولا يخفضه · يعيد هل رفعه */
export async function raiseCompat(remote: FirestoreRemote, org: string, v: number = SCHEMA_VERSION): Promise<boolean> {
  const cur = await readCompat(remote, org);
  if (!cur.live || cur.min >= v) return false;
  await remote.setDoc(compatPath(org), { min: v });
  return true;
}

/** إصدار هذا التطبيق أقدم من حدّ المنشأة */
export const appTooOld = (min: number, v: number = SCHEMA_VERSION): boolean => min > v;

/** مغادرة العضو المنشأة بنفسه · تُحذف عضويته من الخادم، ومسح الجهاز على المستدعي */
export const leaveOrg = (remote: FirestoreRemote, org: string, uid: string) => remote.deleteDoc(`orgs/${org}/members/${uid}`);

/* ─── نقل الوحدات بين العقارات (ملاحظة المالك ٢٠٢٦-١٠-٠٥ على ٤.١٢) ─── */

/** آخر ما يُحفظ من سجل النقل في المنشأة · يكفي لجهازٍ غاب أشهراً، والأقدم منه لم يعد يؤثر بعد إعادة السحب */
const MOVES_KEEP = 300;

/** المالك ينشر ما نقله من وحدات بعد رفع صفوفها بوسمها الجديد · فيعرف كل عضو هل خرجت من عقاراته */
export async function publishUnitMoves(db: DB, remote: FirestoreRemote, org: string): Promise<number> {
  const pending = pendingUnitMoves(db);
  if (!pending.length) return 0;
  const cur = await remote.getDoc(`orgs/${org}/meta/moves`);
  const prev = Array.isArray(cur?.moves) ? (cur!.moves as UnitMove[]) : [];
  await remote.setDoc(`orgs/${org}/meta/moves`, { moves: [...prev, ...pending].slice(-MOVES_KEEP) });
  setSyncState(db, PENDING_MOVES_KEY, null);
  return pending.length;
}

/**
 * العضو يقرأ سجل النقل · 'lost' إن خرجت وحدةٌ من عقاراته إلى عقار ليس له (فيُفرَّغ جهازه ويُعاد سحبه بصلاحيته
 * كما يحدث عند تغيّرها)، وما دخل عقاراته يصله بالسحب العادي لأن صفوفه رُفعت من جديد. أول قراءة تحفظ الموضع ولا تفرّغ.
 */
export async function checkUnitMoves(db: DB, remote: FirestoreRemote): Promise<'lost' | 'none'> {
  const m = readMembership(db);
  if (!m) return 'none';
  const cur = await remote.getDoc(`orgs/${m.org}/meta/moves`);
  const moves = Array.isArray(cur?.moves) ? (cur!.moves as UnitMove[]) : [];
  const seen = getSyncState(db, 'moves_seen');
  // الموضع يُحفظ من أول قراءة ولو كان السجل فارغاً · «0» قبل أي تاريخ، فأول نقلٍ بعدها يُحتسب
  if (!moves.length) {
    if (seen == null) setSyncState(db, 'moves_seen', '0');
    return 'none';
  }
  const last = moves.reduce((mx, x) => (x.at > mx ? x.at : mx), '');
  setSyncState(db, 'moves_seen', last);
  if (seen == null || m.allProps) return 'none';
  const lost = moves.some((x) => x.at > seen && m.props.includes(x.from) && !m.props.includes(x.to));
  return lost ? 'lost' : 'none';
}

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
 * قبل كل مزامنة: هل مُسحت المنشأة بعد آخر ما يعرفه الجهاز؟ (قاعدة المالك ٢٠٢٦-١٠-٠٥: لا يُمسح شيء من الجهاز
 * إلا بأمر صريح من المستخدم في تلك اللحظة أو بإزالة عضويته) · 'ask' على الجهاز بيانات فيُسأل المستخدم ولا يُفرَّغ،
 * وتتوقف المزامنة حتى يقرر · 'adopt' جهاز بلا بيانات يأخذ العهد · 'same' كما هو.
 */
export function epochAction(local: number | null, remote: number, hasData: boolean): 'ask' | 'adopt' | 'same' {
  if (remote <= (local ?? 0)) return local === null && remote > 0 ? (hasData ? 'ask' : 'adopt') : 'same';
  return hasData ? 'ask' : 'adopt';
}

/**
 * مسح المحادثات بمسح المالك الشامل (قرار المالك 2026-10-08): العهد في الخادم بعد آخر عهدٍ مُسحت عنده محادثات هذا الجهاز
 * (أو آخر عهدٍ اعتمده) وعليه محادثات · والأساس يُقرأ قبل فحص العهد، فاعتماده لا يُخفي المسح
 */
export function chatWipeDue(baseline: number | null, remote: number, hasChat: boolean): boolean {
  return hasChat && remote > (baseline ?? 0);
}
export const chatEpochBaseline = (db: DB): number | null => {
  const v = getSyncState(db, 'chat_epoch') ?? getSyncState(db, 'wipe_epoch');
  return v === null ? null : Number(v);
};

/** عهد مسحٍ ينتظر قرار المستخدم · null إن لم يكن */
export const pendingEpoch = (db: DB): number | null => {
  const v = getSyncState(db, 'epoch_pending');
  return v === null ? null : Number(v);
};

/** تفريغٌ لتغيّر الصلاحية ينتظر رفع ما على الجهاز · 'changed' أو 'moved' (نُقلت وحدة من عقاراته) */
export const PERM_WIPE_KEY = 'perm_wipe_pending';

/**
 * تفريغ الجهاز لتغيّر الصلاحية (قاعدة المالك ٢٠٢٦-١٠-٠٥: لا تفريغ وفي الطابور ما لم يُرفع) · يُحفظ منتظراً، ويقع في أول دورة
 * يخلو فيها طابور المزامنة وما لم يُرسل من المحادثة · فالعضوية الجديدة تُحفظ عند اكتشافها والتفريغ لا يضيع بذلك
 * (تحقق الدمج الثاني، ف٢) · يعيد سببه إن حان، وإلا null
 */
export function permWipeDue(db: DB, r: 'same' | 'changed', moved: 'lost' | 'none', waiting: number): 'changed' | 'moved' | null {
  if (r === 'changed') notePermWipe(db, moved === 'lost' ? 'moved' : 'changed');
  const pend = getSyncState(db, PERM_WIPE_KEY);
  return pend === 'changed' || pend === 'moved' ? (waiting === 0 ? pend : null) : null;
}

/**
 * يُسجَّل التفريغ المنتظر فور اكتشاف سببه · ونقل الوحدة يُسجَّل حال اكتشافه قبل أي طلب بعده، فلا يضيع بفشل الشبكة
 * بعد أن تقدّم مؤشر النقل (التحقق الثالث) · 'moved' يغلب ولا يُنزَّل
 */
export function notePermWipe(db: DB, reason: 'changed' | 'moved'): void {
  const cur = getSyncState(db, PERM_WIPE_KEY);
  setSyncState(db, PERM_WIPE_KEY, reason === 'moved' || cur === 'moved' ? 'moved' : 'changed');
}

/** فحص العهد قبل المزامنة · لا يفرّغ شيئاً: 'ask' يُحفظ عهدها منتظراً قرار المستخدم (resolveEpoch) */
export async function checkEpoch(db: DB, remote: FirestoreRemote, org: string): Promise<'ask' | 'adopt' | 'same'> {
  const remoteEpoch = await readEpoch(remote, org);
  setSyncState(db, 'remote_epoch', String(remoteEpoch));
  const raw = getSyncState(db, 'wipe_epoch');
  const act = epochAction(raw === null ? null : Number(raw), remoteEpoch, hasUserData(db));
  if (act === 'adopt') setSyncState(db, 'wipe_epoch', String(remoteEpoch));
  if (act === 'ask') setSyncState(db, 'epoch_pending', String(remoteEpoch));
  return act;
}

/**
 * قرار المستخدم في عهد مسحٍ منتظر · 'keep' تبقى بياناته ويُرفع كل شيء من جديد إلى المنشأة الممسوحة،
 * و'wipe' يفرّغ المستدعي الجهاز (بنسخة أمان وسجل) ثم يُسجَّل العهد على القاعدة الجديدة.
 */
export async function resolveEpoch(db: DB, choice: 'keep' | 'wipe', wipe: () => Promise<DB | void>): Promise<DB> {
  const n = pendingEpoch(db);
  if (n === null) return db;
  if (choice === 'keep') {
    db.transaction(() => {
      setSyncState(db, 'wipe_epoch', String(n));
      setSyncState(db, 'epoch_pending', null);
      seedOutbox(db);
    });
    return db;
  }
  const live = (await wipe()) ?? db;
  setSyncState(live, 'wipe_epoch', String(n));
  setSyncState(live, 'epoch_pending', null);
  setSyncState(live, 'joining', '1');
  return live;
}
