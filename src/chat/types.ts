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
 *  orgs/{org}/chats/{chatId}/msgs/{id}  { from, name, body, link, att, ts }  · إنشاء فقط
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
