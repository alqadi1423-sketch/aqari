/**
 * قواعد المحادثة فحوصاً خالصة (ق٠-٧ · F §٥.٢): كل دالةٍ هنا ترجمةُ دالةٍ من كتلة «<chat>» في firestore.rules باسمها، بلا تخزين ولا
 * ساعة · والخادم (server.ts) يجمعها لكل عملية · وأرقام القواعد (C1 وT3 وM11…) هي أرقام الجدول في اختبار الخادم.
 */

/** ما يقبله الخادم في المحادثة (مطابقٌ لـsrc/chat/types.ts) */
export type ChatKind = 'direct' | 'group';
export type ChannelRef = { t: 'section'; key: string } | { t: 'announce' } | { t: 'prop'; id: string };
export interface GroupSettings { h?: 'all' | 'join'; w?: 'all' | 'admins'; ad?: 'admins' | 'all' }
export type ChatTag = 'urgent' | 'decision' | 'followup';
export interface ChatLink { type: 'contract' | 'unit' | 'asset' | 'maintenance'; id: string; label: string }
export interface ChatPoll { o: string[]; m: boolean }

/** المحادثة كما تُخزَّن · jm رقم آخر سطر «انضم المالك»، وla آخر من أُضيف (كما في Firestore) */
export interface ThreadRec {
  id: string; k: ChatKind; p: string[]; name: string; by: string; at: string;
  s?: GroupSettings; a?: string[]; jt?: Record<string, string>; ch?: ChannelRef | null; jm?: string; la?: string;
}

/** عضو المنشأة كما في مستند عضويته اليوم (members/{uid}) · المالك ليس عضواً */
export interface OrgMember { uid: string; name: string; email: string; perm: Record<string, number>; all: boolean; props: string[] }

/** من ينادي: رقمه، وهل هو المالك (رقمه رقم المنشأة · orgOwner)، وعضويته إن كان عضواً */
export interface Caller { uid: string; owner: boolean; member: OrgMember | null }

/* ═══ الضوابط (مطابقةٌ للقواعد ولـsrc/chat/types.ts) ═══ */

export const BODY_MAX = 4000;
export const NAME_MAX = 80;
export const PARTIES_MAX = 100;
export const ADMINS_MAX = 100;
export const MENTIONS_MAX = 30;
export const SUP_MAX = 30;
export const POLL_MIN = 2;
export const POLL_MAX = 10;
export const POLL_TEXT_MAX = 1000;
export const LINK_ID_MAX = 64;
export const LINK_LABEL_MAX = 200;
export const REASON_MAX = 500;
export const TASK_TITLE_MAX = 200;
export const REVIEW_TTL_MS = 30 * 60_000;
export const DELETION_TTL_MS = 3_600_000;
export const TAGS: readonly ChatTag[] = ['urgent', 'decision', 'followup'];
export const LINK_TYPES: readonly ChatLink['type'][] = ['contract', 'unit', 'asset', 'maintenance'];
/** سطر انضمام المالك واسم من حذف حسابه · قيمٌ مخزّنة تطابقها القواعد (OWNER_JOINED وFORMER_MEMBER في src/chat/types.ts) */
export const OWNER_JOINED = 'انضم المالك';
export const FORMER_MEMBER = 'عضو سابق';

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,300}$/;
export const GROUP_ID_RE = /^g_[A-Za-z0-9_-]{6,64}$/;
const RESERVED_GROUP_RE = /^g_(sec_|announce|prop_)/;
const MENTION_RE = /^[us]:[A-Za-z0-9_-]{1,128}$/;
const DUE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keysOnly = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));
export const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** S1 · chatSettingsOk: الإعدادات بمفاتيحها وقيمها، والمسؤولون قائمةٌ لا تتجاوز مئة ومن الأطراف وحدهم */
export function settingsOk(d: { p: string[]; s?: unknown; a?: unknown }): boolean {
  const s = d.s ?? {};
  if (!isObj(s) || !keysOnly(s, ['h', 'w', 'ad'])) return false;
  if (!['all', 'join'].includes((s.h as string) ?? 'all')) return false;
  if (!['all', 'admins'].includes((s.w as string) ?? 'all')) return false;
  if (!['admins', 'all'].includes((s.ad as string) ?? 'admins')) return false;
  const a = d.a ?? [];
  return isStrList(a) && a.length <= ADMINS_MAX && a.every((u) => d.p.includes(u));
}

/** S2 · chatAdmin: المالك دائماً، والمنشئ والمعيَّن ما داما طرفين فيها */
export function isAdmin(c: Caller, d: ThreadRec): boolean {
  return c.owner || ((d.by === c.uid || (d.a ?? []).includes(c.uid)) && d.p.includes(c.uid));
}

/** MS · chatMaySend: الفردية لطرفيها، والمجموعة لكل أعضائها أو لمسؤوليها إن قُيِّدت */
export function maySend(c: Caller, d: ThreadRec): boolean {
  return d.k !== 'group' || (d.s?.w ?? 'all') === 'all' || isAdmin(c, d);
}

/** CH1 · chatChannelOk: القناة بمفاتيحها ورقمها من نوعها */
export function channelOk(chatId: string, ch: unknown): ch is ChannelRef {
  if (!isObj(ch)) return false;
  if (ch.t === 'section') return keysOnly(ch, ['t', 'key']) && typeof ch.key === 'string' && /^[a-z]{2,20}$/.test(ch.key) && chatId === 'g_sec_' + ch.key;
  if (ch.t === 'announce') return keysOnly(ch, ['t']) && chatId === 'g_announce';
  if (ch.t === 'prop') return keysOnly(ch, ['t', 'id']) && typeof ch.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(ch.id) && chatId === 'g_prop_' + ch.id;
  return false;
}

/** Q1 · chatQualifies: المحادثة العادية بلا شرط، والقناة للمالك ولمن تحق له الآن من عضويته */
export function qualifies(c: Caller, d: ThreadRec): boolean {
  const ch = d.ch ?? null;
  if (!ch || c.owner) return true;
  const m = c.member;
  if (!m) return false;
  if (ch.t === 'announce') return true;
  if (ch.t === 'section') return (m.perm[ch.key] ?? 0) >= 1;
  return m.all === true || m.props.includes(ch.id);
}

/** وقت انضمامي إلى المحادثة: من أُضيف بعد إنشائها بوقته، والأوائل وقت إنشائها */
const joinedAt = (c: Caller, d: ThreadRec) => d.jt?.[c.uid] ?? d.at;

/** chatHistoryOk: سجل المنضم كل السابق، أو ما بعد انضمامه */
export function historyOk(c: Caller, d: ThreadRec, msgTs: string): boolean {
  return (d.s?.h ?? 'all') === 'all' || msgTs >= joinedAt(c, d);
}

/** MV · chatMsgVisible: من يقرأ الرسالة يقرأ ما يتبعها · كل السابق، أو بعد انضمامه، أو رسالته هو */
export function msgVisible(c: Caller, d: ThreadRec, m: { ts: string; from: string }): boolean {
  return historyOk(c, d, m.ts) || m.from === c.uid;
}

/** C1 · chatIn: داخلٌ برمزٍ صحيح، وهو المالك أو عضوٌ في المنشأة */
export const chatIn = (c: Caller | null): c is Caller => !!c && (c.owner || c.member !== null);
/** T1 · طرفٌ فيها */
export const party = (c: Caller, d: ThreadRec) => d.p.includes(c.uid);

/** M5 · الاستطلاع: من ٢ إلى ١٠ خيارات نصية، مجموعها ألف حرف، وهل يُختار أكثر من واحد */
export function pollOk(v: unknown): v is ChatPoll {
  return isObj(v) && keysOnly(v, ['o', 'm']) && isStrList(v.o) && v.o.length >= POLL_MIN && v.o.length <= POLL_MAX
    && v.o.join('').length <= POLL_TEXT_MAX && typeof v.m === 'boolean';
}

/** M13 · الربط: لا شيء، أو نوعٌ من الأربعة برقمٍ واسم في حدّيهما */
export function linkOk(v: unknown): v is ChatLink | null {
  if (v === null || v === undefined) return true;
  return isObj(v) && keysOnly(v, ['type', 'id', 'label']) && LINK_TYPES.includes(v.type as ChatLink['type'])
    && typeof v.id === 'string' && v.id.length <= LINK_ID_MAX && typeof v.label === 'string' && v.label.length <= LINK_LABEL_MAX;
}

/** M9 · الإشارات: قائمةٌ لا تتجاوز ثلاثين، كلٌّ «u:رقم» أو «s:قسم» */
export function mentionsOk(v: unknown): v is string[] {
  return isStrList(v) && v.length <= MENTIONS_MAX && v.every((x) => MENTION_RE.test(x));
}

/** M6 · الوسم من الثلاثة أو لا شيء */
export const tagOk = (v: unknown): v is ChatTag | null => v === null || v === undefined || TAGS.includes(v as ChatTag);

/** ST6 · المهمة: عنوانٌ من ١ إلى ٢٠٠، وموعدٌ بصيغة YYYY-MM-DD، وإنجازٌ صحيحٌ أو خطأ، ومسؤولٌ نصّ */
export function taskFieldsOk(t: { title?: unknown; as?: unknown; due?: unknown; done?: unknown }): boolean {
  return typeof t.title === 'string' && t.title.length > 0 && t.title.length <= TASK_TITLE_MAX
    && typeof t.as === 'string' && typeof t.due === 'string' && DUE_RE.test(t.due) && typeof t.done === 'boolean';
}

/** T4 · رقم المجموعة العادية: بصيغة المجموعة وليس من أرقام القنوات */
export const plainGroupId = (id: string) => GROUP_ID_RE.test(id) && !RESERVED_GROUP_RE.test(id);

/** ما تغيّر من مفاتيح بين حالين (كـdiff().affectedKeys() في القواعد) */
export function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(canon(before[k])) !== JSON.stringify(canon(after[k])));
}
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
