/**
 * ناقل المحادثة (ق٠-٧ · F الاستقلال عن قوقل §٥.٢ · قرار المالك على السؤال ٣: (أ) المحادثة تنتقل مع المنشأة إلى الخادم الجديد):
 * واجهةٌ واحدة يمرّ بها كل ما تطلبه المحادثة من السحابة، فلا يعرف المزامن ولا القنوات ولا واجهة الوحدة (index.ts) من أين تأتي.
 *
 *  - اليوم: Firestore وحده (remote.ts · ChatRemote) بلا أي تغيير في السلوك.
 *  - بعد التحويل: خادم المنشأة (serverTransport.ts أمام server/chat) · ولا يُشغَّل قبل إذن المالك (setChatTransport بلا منادٍ).
 *
 * الأوقات (ts وat وjt) نصوصٌ بصيغة وقت الخادم ذات الأجزاء التسعة (normTs)، والمؤشرات منها · وكل ما يكتبه الناقل يُقبل أو يُرفض بقواعد
 * الخادم وحده (firestore.rules «<chat>» اليوم، وفحوص server/chat بعد التحويل).
 */
import type { ChannelRef, ChatKind, ChatLink, ChatPerson, ChatPoll, ChatTag, ChatTask, GroupSettings } from './types';

/**
 * المحادثة كما في الخادم · s إعدادات المجموعة، a مسؤولوها المعيَّنون، jt وقت انضمام من أُضيف بعد إنشائها
 * (قرار المالك 2026-10-08T05:31Z) · والأوائل وقت انضمامهم وقت إنشائها
 */
export interface RemoteThread {
  id: string; k: ChatKind; p: string[]; name: string; by: string; at: string | null;
  s?: GroupSettings; a?: string[]; jt?: Record<string, string>;
  /** القناة (الدفعة ٤) · null للمحادثة العادية */
  ch?: ChannelRef | null;
}
/** sys: سطر نظام لا رسالة · 'join' انضم المالك (قرار المالك 2026-10-08T04:11Z) */
export interface RemoteMessage {
  id: string; from: string; name: string; body: string; link: ChatLink | null; ts: string; sys?: string | null;
  /** الرد في سلسلة: رقم الرسالة الأصل · men الإشارات «u:رقم» و«s:قسم» (الدفعة ٢ · 2026-10-08T05:31Z) */
  re?: string | null; men?: string[];
  /** الدفعة ٣: الوسم، والإعلان المهم بتأكيد الاطلاع، وعدد تعديلاتها ووقت آخرها */
  tag?: ChatTag | null; ack?: boolean; ev?: number; et?: string | null;
  /** الدفعة ٥: الاستطلاع */
  poll?: ChatPoll | null;
}
/** ما قبل تعديلٍ برقمه */
export interface RemoteEdit { n: number; body: string; tag: ChatTag | null; at: string }

/** حال المحادثة (st): التثبيت p_رقم وقراءة كل عضو r_رقمه · بوقت الخادم ts فتُسحب بمؤشر واحد */
export interface RemoteState {
  id: string; k: string; ts: string; on?: boolean; by?: string; at?: string; m?: string; n?: number;
  /** الدفعة ٥: المهمة (عنوانها ومسؤولها وموعدها وإنجازها) والصوت (أرقام خياراته) */
  title?: string; as?: string; due?: string; done?: boolean; o?: number[];
  /** المهمة ملغاة (قرار المالك 2026-10-08T10:24Z) */
  cx?: boolean;
}

/** آخر ما أُخذ من صفحة: وقته في الخادم ورقمه (المراجعة الخارجية ٧ · النتيجة ٤٠) */
export interface PageAfter { ts: string; id: string }

/** صفحة «من لحظة انضمامه»: الرسائل وعدد الأرقام التي جاءت بها (فالصفحة تُعدّ بالأرقام) */
export interface JoinedPage { msgs: RemoteMessage[]; ids: number; lastTs: string | null; lastId: string | null }

/** عضو المنشأة بصلاحياته · يضبط بها جهاز المالك القنوات */
export interface ChatMemberPerm { uid: string; perm: Record<string, number>; all: boolean; props: string[] }

/** الرسالة كما يرسلها الجهاز · from ووقتها من الخادم */
export interface OutgoingMessage {
  id: string; name: string; body: string; link: ChatLink | null; re?: string | null; men?: string[]; tag?: ChatTag | null; ack?: boolean;
  poll?: ChatPoll | null;
}

export type CreateResult = 'created' | 'exists';

/**
 * ما تطلبه المحادثة من السحابة · طرائق ChatRemote (Firestore) التي يناديها المزامن والقنوات وواجهة الوحدة، بأسمائها ومعانيها كما هي ·
 * وطرائق نافذة الحذف خصائصُ دوال (لا طرائق) فيبقى حارس «لا تُفتح النافذة إلا من حذف الحساب أو المسح» على مناديها وحده.
 */
export interface ChatTransport {
  /* الدليل والإشراف */
  putMyDirectory(name: string, sup: string[]): Promise<void>;
  directory(): Promise<ChatPerson[]>;
  /** خروج عضوٍ من دليل المحادثة · لصاحبه والمالك */
  removeFromDirectory(uid: string): Promise<void>;
  role(email: string): Promise<string[]>;
  setRole(email: string, sup: string[]): Promise<void>;
  /** حذف إشراف عضوٍ بإيميله · للمالك */
  removeRole(email: string): Promise<void>;
  /** أعضاء المنشأة وصلاحياتهم · للمالك */
  members(): Promise<ChatMemberPerm[]>;

  /* المحادثات */
  createThread(t: { id: string; k: ChatKind; p: string[]; name: string; s?: GroupSettings; a?: string[] }): Promise<CreateResult>;
  createChannel(id: string, ch: ChannelRef, name: string): Promise<CreateResult>;
  getThread(threadId: string): Promise<RemoteThread>;
  myThreads(): Promise<RemoteThread[]>;
  orgThreads(): Promise<RemoteThread[]>;
  groupsOf(uid: string): Promise<Array<{ id: string; p: string[]; name: string }>>;
  addMember(threadId: string, uid: string): Promise<void>;
  removeMembers(threadId: string, uids: string[]): Promise<void>;
  leaveGroup(threadId: string): Promise<void>;
  setGroupMeta(threadId: string, m: { name?: string; s?: GroupSettings; a?: string[] }): Promise<void>;
  /** انضمام المالك إلى مجموعة ليس فيها ومعه سطر «انضم المالك» · يردّ رقم السطر */
  joinGroup(threadId: string, myName: string): Promise<string>;

  /* الرسائل */
  sendMessage(threadId: string, m: OutgoingMessage): Promise<CreateResult>;
  getMessage(threadId: string, msgId: string): Promise<RemoteMessage>;
  messagesSince(threadId: string, cursor: string | null, limit?: number, after?: PageAfter | null): Promise<RemoteMessage[]>;
  joinedPage(threadId: string, cursor: string, limit?: number, after?: PageAfter | null): Promise<JoinedPage>;
  editMessage(threadId: string, msgId: string, body: string, tag: ChatTag | null): Promise<number>;
  editsOf(threadId: string, msgId: string): Promise<RemoteEdit[]>;
  /** العضو يحذف حسابه: اسمه في رسائله «عضو سابق» · يردّ عددها */
  anonymizeMine(label: string): Promise<number>;

  /* حال المحادثة: القراءة والتثبيت وتأكيد الاطلاع والمهام والتصويت */
  stateSince(threadId: string, cursor: string | null, limit?: number, after?: PageAfter | null): Promise<RemoteState[]>;
  markReadUpTo(threadId: string, at: string): Promise<void>;
  setPin(threadId: string, msgId: string, on: boolean): Promise<void>;
  acknowledge(threadId: string, msgId: string): Promise<CreateResult>;
  setTask(threadId: string, msgId: string, task: ChatTask): Promise<void>;
  setTaskDone(threadId: string, msgId: string, done: boolean): Promise<void>;
  cancelTask(threadId: string, msgId: string): Promise<void>;
  vote(threadId: string, msgId: string, options: number[]): Promise<void>;

  /* مراجعة المالك محادثةً بسبب */
  openReview(chatId: string, reason: string): Promise<string>;
  closeReview(chatId: string): Promise<void>;
  allMessages(threadId: string): Promise<RemoteMessage[]>;

  /* نافذة الحذف والمسح (حذف الحساب والمسح الشامل وحدهما) */
  readonly openDeletionWindow: () => Promise<void>;
  readonly closeDeletionWindow: () => Promise<void>;
  readonly purgeAll: (o?: { keepDirectory?: boolean }) => Promise<number>;
}

/** رفضٌ أو خطأٌ من خادم المحادثة (غير Firestore) · status كرمز HTTP، وcode رمز السبب */
export class ChatTransportError extends Error {
  constructor(public status: number, public code: string) {
    super(`chat ${status}: ${code}`);
    this.name = 'ChatTransportError';
  }
}

/**
 * رفضته قواعد الخادم (403)، لا عارضٌ يُعاد · Firestore كما كان يُقرأ نصّاً («Firestore 403») حرفاً بحرف، وخادم المنشأة بخطئه ·
 * والحدّ (429) وغيره عارضٌ يُعاد في الدورة التالية
 */
export function isChatDenied(e: unknown): boolean {
  if (e instanceof ChatTransportError) return e.status === 403;
  return /Firestore 403/.test(String(e));
}
