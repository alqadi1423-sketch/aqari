/**
 * خطوات مسح السحابة في موضعٍ واحد بلا خدمات الجهاز، فيختبرها المحاكي كما تجري (المراجعات الخارجية «ثالثاً أ ٨» · قرارا
 * المالك #2 و#28): «مسح كل البيانات» يحذف الصفوف والمحادثات ورسائلها ومجموعاتها الفرعية وملفات التخزين، ويبقى الحساب
 * والأعضاء والدعوات والدليل · و«حذف حسابي» للمالك يحذف ذلك كله ومعه المنشأة وأعضاؤها ودعواتها والمسار القديم
 */
import type { FirestoreRemote } from '../cloud/firestore';
import { listObjects, deleteObject, filesPrefix, type StorageIO, type StorageTarget } from '../cloud/storage';
import { chatPurgeOrg, chatForgetMe, chatLeaveOrg, type ChatSession } from '../chat';
import { wipeOrgCloud, leaveOrg } from './org';
import { t } from '../i18n';

export interface CloudFiles { io: StorageIO; t: StorageTarget }

/** ملفات المنشأة في التخزين كلها · يعيد عددها */
export async function deleteAllOrgFiles(files: CloudFiles, org: string, onProgress?: (m: string) => void): Promise<number> {
  const names = await listObjects(files.io, files.t, filesPrefix(org));
  let n = 0;
  for (const name of names) {
    await deleteObject(files.io, files.t, name);
    n++;
    onProgress?.(t('wipe.deletingFiles', { n, total: names.length }));
  }
  return n;
}

/** «مسح كل البيانات» في السحابة · يعيد العهد الجديد */
export async function wipeCloud(
  d: { remote: FirestoreRemote; chat: ChatSession; org: string; files: CloudFiles | null }, onProgress?: (m: string) => void,
): Promise<number> {
  const epoch = await wipeOrgCloud(d.remote, d.org, onProgress);
  // المسح يشمل المحادثة (قرار المالك 2026-10-07: #28) · والأعضاء والدعوات باقون فيبقى الدليل والإشراف (التحقق ق٢)
  await chatPurgeOrg(d.chat, d.org, { keepDirectory: true });
  if (d.files) await deleteAllOrgFiles(d.files, d.org, onProgress);
  return epoch;
}

/** «حذف حسابي» للمالك في السحابة: الملفات، ثم المحادثات كلها، ثم المنشأة والمسار القديم */
export async function deleteOwnerCloud(
  d: { remotes: FirestoreRemote[]; chat: ChatSession; org: string; files: CloudFiles | null }, onProgress?: (m: string) => void,
): Promise<void> {
  if (d.files) await deleteAllOrgFiles(d.files, d.org, onProgress);
  await chatPurgeOrg(d.chat, d.org);
  for (const remote of d.remotes) {
    await remote.deleteAllData((n) => onProgress?.(t('wipe.deletingCloud', { n })));
  }
}

/**
 * «حذف حسابي» في السحابة لكل مستخدم (المراجعة الخارجية ٧ · النتيجة ١٥ · قرار المالك «رابعاً ٨» 2026-10-10: «من هو مالك منشأة
 * وعضو في أخرى معاً، يحذف حسابه كمالك فتُحذف منشأته كاملة»): عضويته في منشأة غيره إن كانت (اسمه في رسائلها «عضو سابق» ومستند
 * عضويته · محاولةٌ لا تمنع الحذف)، ثم منشأته هو كاملة بملفاتها ومحادثاتها والمسار القديم · كان فرع العضو يحذف الصفوف وحدها فتبقى
 * ملفات منشأته ومحادثاتها بعد حذف الحساب ولا يصلها أحد · وخطوات المنشأة لا أثر لها على منشأة فارغة
 */
export async function deleteAccountCloud(
  d: {
    remotes: FirestoreRemote[]; chat: ChatSession; org: string; files: CloudFiles | null;
    member: { org: string; uid: string; remote: FirestoreRemote } | null;
  },
  onProgress?: (m: string) => void,
): Promise<void> {
  if (d.member) {
    // يخرج من مجموعاتها أولاً كالمغادرة (المراجعة الخارجية ٧ · النتيجة ٢٩ (ب): كان معرّفه يبقى في أطرافها ومسؤوليها)
    await chatLeaveOrg(d.chat, d.member.org).catch(() => {});
    await chatForgetMe(d.chat, d.member.org).catch(() => {});
    await leaveOrg(d.member.remote, d.member.org, d.member.uid).catch(() => {});
  }
  await deleteOwnerCloud(d, onProgress);
}
