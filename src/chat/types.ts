/**
 * المحادثة · وحدة مستقلة (قرار المالك 2026-10-07): «قابلة لأي إضافة أو تعديل: وحدة مستقلة بواجهة واضحة،
 * لا تمس بقية التطبيق». واجهتها مع التطبيق في src/chat/index.ts وحدها.
 *
 * المواصفة (سجل القرارات §٢٤):
 *  - محادثات فردية ومجموعات، وأي عضو يراسل أي عضو.
 *  - ربط الرسالة بسجل (عقد، وحدة، أصل، طلب صيانة) يفتحه من له صلاحية عليه، ومن لا صلاحية له يرى اسمه فقط.
 *  - تعمل بلا اتصال وتُرسل عند عودته، ولا تُحذف.
 *  - «مشرف القسم» في الدعوة · المالك والمشرفون ينشئون المجموعات، ويظهر الإشراف بجوار اسم العضو.
 *  - الصور والملفات والإشعارات: مصمَّمة (الحقل att محجوز) وتعمل بعد الفوترة.
 *
 * في السحابة تحت المنشأة (قواعد مضافة لا تغيّر القائمة · firestore.rules بعد الكتلة المولَّدة):
 *  orgs/{org}/chats/{chatId}            { k: 'direct'|'group', p: uid[], name, by, at }
 *  orgs/{org}/chats/{chatId}/msgs/{id}  { from, name, body, link, att, ts, sys }  · إنشاء فقط · يقرؤها أطرافها،
 *                                       والمالك بمراجعة مفتوحة بسببٍ مسجَّل (2026-10-08T04:11Z)
 *  orgs/{org}/chats/{chatId}/ids/{id}   {}  · فهرس الأرقام بلا محتوى ليحذف المالك دون أن يقرأ
 *  orgs/{org}/chatReviews/{rid}         { chat, reason, by, at }  · سجل المراجعات · للمالك وحده
 *  orgs/{org}/chatReviewOpen/{chatId}   { rid, at }  · المراجعة المفتوحة · تُحذف بالإغلاق
 *  orgs/{org}/chatDir/{uid}             { name, sup, at }  · دليل الأعضاء للمحادثة · يكتبه صاحبه
 *  orgs/{org}/chatRoles/{email}         { sup: SectionKey[] }  · إشراف الأقسام · يكتبه المالك
 */

export type ChatKind = 'direct' | 'group';

/** ما تُربط به الرسالة · maintenance مصمَّم ويعمل حين تُبنى طلبات الصيانة */
export type ChatLinkType = 'contract' | 'unit' | 'asset' | 'maintenance';
export const CHAT_LINK_TYPES: readonly ChatLinkType[] = ['contract', 'unit', 'asset', 'maintenance'];

export interface ChatLink {
  type: ChatLinkType;
  id: string;
  /** اسم السجل يوم الإرسال · يراه من لا صلاحية له عليه بدل فتحه */
  label: string;
}

export interface ChatThread {
  id: string;
  kind: ChatKind;
  name: string;
  members: string[];
  createdBy: string;
  createdAt: string | null;
  lastTs: string | null;
  lastBody: string;
  unread: number;
  /** أُنشئت على الجهاز ولم تُرفع بعد */
  pending: boolean;
  /** رفض الخادم إنشاءها (مثل مجموعة أنشأها مشرف سُحب إشرافه) */
  rejected: boolean;
  /** إعدادات المجموعة ومسؤولوها المعيَّنون ووقت انضمام من أُضيف بعد إنشائها (2026-10-08T05:31Z) */
  settings: Required<GroupSettings>;
  admins: string[];
  joined: Record<string, string>;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  sender: string;
  senderName: string;
  body: string;
  link: ChatLink | null;
  /** وقت الكتابة على الجهاز · للترتيب قبل الإرسال */
  localAt: string;
  /** وقت الخادم بعد الإرسال */
  serverTs: string | null;
  sent: boolean;
  /** رفضها الخادم · تبقى موسومة */
  rejected: boolean;
  /** سطر نظام لا رسالة · 'join' انضم المالك */
  sys: string | null;
  /** الرد في سلسلة: رقم الرسالة الأصل (الدفعة ٢) */
  re: string | null;
  /** الإشارات: «u:رقم عضو» و«s:قسم» */
  men: string[];
  /** الدفعة ٣: الوسم، والإعلان المهم بتأكيد الاطلاع، وعدد تعديلاتها */
  tag: ChatTag | null;
  ack: boolean;
  ev: number;
}

/** الوسوم (الدفعة ٣ · 2026-10-08T05:31Z): عاجل، قرار، متابعة · مطابقة لقواعد الخادم */
export type ChatTag = 'urgent' | 'decision' | 'followup';
export const CHAT_TAGS: readonly ChatTag[] = ['urgent', 'decision', 'followup'];

/** إشارة إلى عضو أو قسم في الرسالة (الدفعة ٢ · 2026-10-08T05:31Z) */
export const mentionUser = (uid: string) => 'u:' + uid;
export const mentionSection = (key: string) => 's:' + key;
export const MENTIONS_MAX = 30;
/** هل تشيرني الرسالة: باسمي، أو بقسمٍ لي عليه صلاحية */
export function mentionsMe(m: { men: string[] }, me: string, mySections: string[]): boolean {
  return m.men.some((x) => x === mentionUser(me) || (x.startsWith('s:') && mySections.includes(x.slice(2))));
}

export interface ChatPerson {
  uid: string;
  name: string;
  /** الأقسام التي يشرف عليها · تظهر بجوار اسمه */
  sup: string[];
}

/** المستخدم الحالي في المحادثة */
export interface ChatMe {
  org: string;
  uid: string;
  email: string;
  name: string;
  /** صاحب المنشأة */
  owner: boolean;
}

/** اسم من حذف حسابه في رسائله (قرار المالك 2026-10-07: #2) · مطابق لقواعد الخادم */
export const FORMER_MEMBER = 'عضو سابق'; // i18n-exempt: قيمة مخزّنة تطابقها القواعد

/** سطر انضمام المالك إلى مجموعة ليس فيها (قرار المالك 2026-10-08T04:11Z) · مطابق لقواعد الخادم */
export const OWNER_JOINED = 'انضم المالك'; // i18n-exempt: قيمة مخزّنة تطابقها القواعد · وتُعرض بمفتاحها

/** نوع السجل في سجل العمليات لمراجعة المالك محادثةً بسبب (قرار المالك 2026-10-08T04:11Z) */
export const REVIEW_ENTITY = 'مراجعة محادثة'; // i18n-exempt: قيمة مخزّنة في سجل العمليات
export const CHAT_MODULE = 'المحادثة'; // i18n-exempt: قيمة مخزّنة في سجل العمليات
export const JOIN_ENTITY = 'انضمام المالك إلى مجموعة'; // i18n-exempt: قيمة مخزّنة في سجل العمليات

/**
 * إعدادات المجموعة (قرار المالك 2026-10-08T05:31Z) · تُحدَّد عند الإنشاء ويعدّلها مسؤولوها:
 *  h سجل الرسائل للمنضم الجديد: 'all' كل السابق (الافتراضي) أو 'join' من لحظة انضمامه
 *  w من يرسل: 'all' كل الأعضاء أو 'admins' المسؤولون وحدهم
 *  ad من يضيف أعضاء: 'admins' المسؤولون وحدهم (الافتراضي) أو 'all' كل الأعضاء
 * والمسؤولون: المالك دائماً، ومنشئ المجموعة، ومن يعيّنه أحدهما من أعضائها.
 */
export interface GroupSettings { h?: 'all' | 'join'; w?: 'all' | 'admins'; ad?: 'admins' | 'all' }
export const GROUP_DEFAULTS: Required<GroupSettings> = { h: 'all', w: 'all', ad: 'admins' };
export const groupSettings = (s?: GroupSettings): Required<GroupSettings> => ({ ...GROUP_DEFAULTS, ...(s ?? {}) });

/** مسؤول المجموعة: المالك دائماً، ومنشئها، ومن عُيِّن · له الاسم والإعدادات */
export function isGroupAdmin(me: ChatMe, g: { createdBy: string; admins: string[] }): boolean {
  return me.owner || me.uid === g.createdBy || g.admins.includes(me.uid);
}
/** تعيين المسؤولين للمالك والمنشئ وحدهما */
export function canAppointAdmins(me: ChatMe, g: { createdBy: string }): boolean {
  return me.owner || me.uid === g.createdBy;
}
/** من يضيف: المسؤولون، وكل الأعضاء إن أُذن */
export function canAddMembers(me: ChatMe, g: { createdBy: string; admins: string[]; settings: Required<GroupSettings>; members: string[] }): boolean {
  return isGroupAdmin(me, g) || (g.settings.ad === 'all' && g.members.includes(me.uid));
}
/** من يرسل: كل الأعضاء، أو المسؤولون وحدهم إن قُيِّد */
export function canSendIn(me: ChatMe, g: { kind: ChatKind; createdBy: string; admins: string[]; settings: Required<GroupSettings> }): boolean {
  return g.kind !== 'group' || g.settings.w === 'all' || isGroupAdmin(me, g);
}

/** من يعدّل المجموعة: المالك ومنشئها (#19) */
export function canEditGroup(me: ChatMe, createdBy: string): boolean {
  return me.owner || me.uid === createdBy;
}

/** أقصى طول للرسالة · مطابق لقواعد الخادم */
export const CHAT_BODY_MAX = 4000;
export const CHAT_NAME_MAX = 80;
export const CHAT_GROUP_MAX = 100;

/** المحادثة الفردية برقم ثابت من رقمي الطرفين · فلا تتكرر بينهما */
export function directId(a: string, b: string): string {
  return 'd_' + [a, b].sort().join('_');
}

/** من ينشئ المجموعات: المالك والمشرفون */
export function canCreateGroup(me: ChatMe, mySup: string[]): boolean {
  return me.owner || mySup.length > 0;
}

/**
 * وقت الخادم بصيغة واحدة (تسعة أجزاء من الثانية) · فالخادم يكتب «…:00Z» و«…:00.5Z»، ومقارنتهما نصاً تخطئ
 */
export function normTs(v: unknown): string {
  const s = String(v ?? '');
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(s);
  return m ? m[1] + '.' + (m[2] ?? '').padEnd(9, '0') + 'Z' : s;
}

/**
 * مقارنة وقتين من الخادم بلا تحليل تاريخ على الجهاز (محرّك الجوال قد لا يقرأ أكثر من ثلاثة أجزاء من الثانية) ·
 * بالصيغة الواحدة نصاً، ودقتها جزء من المليار
 */
export function tsGte(a: string, b: string): boolean {
  return normTs(a) >= normTs(b);
}

/** تاريخ للعرض من وقت الخادم · بالمللي ثانية، فمحرّك الجوال قد لا يقرأ أكثر من ثلاثة أجزاء من الثانية */
export function tsDate(s: string): Date {
  return new Date(s.replace(/\.(\d{3})\d*Z$/, '.$1Z'));
}
