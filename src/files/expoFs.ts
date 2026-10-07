/**
 * تنفيذ واجهة الملفات على expo-file-system (الواجهة المتزامنة الجديدة).
 * يُستورد من كود التطبيق فقط.
 */
import { File, Directory, Paths } from 'expo-file-system';
import { getFreeDiskStorageAsync } from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { toBase64 } from './fsAdapter';
import type { FS, Hasher } from './fsAdapter';

/** توحيد المسار إلى صيغة file:// URI التي تتوقعها الواجهة الجديدة */
const norm = (p: string): string => (p.startsWith('file://') ? p : 'file://' + p);

export const expoFs: FS = {
  read: (p) => new File(norm(p)).bytesSync(),
  write: (p, bytes) => {
    const f = new File(norm(p));
    const dir = new Directory(f.parentDirectory.uri);
    if (!dir.exists) dir.create({ intermediates: true });
    f.write(bytes);
  },
  exists: (p) => new File(norm(p)).exists || new Directory(norm(p)).exists,
  remove: (p) => {
    const f = new File(norm(p));
    if (f.exists) { f.delete(); return; }
    const d = new Directory(norm(p));
    if (d.exists) d.delete();
  },
  mkdirp: (d) => {
    const dir = new Directory(norm(d));
    if (!dir.exists) dir.create({ intermediates: true });
  },
  list: (d) => {
    const dir = new Directory(norm(d));
    if (!dir.exists) return [];
    return dir.list().map((e) => e.name);
  },
  rename: (from, to) => {
    const f = new File(norm(from));
    if (f.exists) { f.moveSync(new File(norm(to))); return; }
    new Directory(norm(from)).moveSync(new Directory(norm(to)));
  },
  size: (p) => new File(norm(p)).size ?? 0,
  // الواجهة الجديدة تُبلّغ `File.freeSpace` وهي تعدّ كتل الجذر المحجوزة · القديمة تُبلّغ
  // `StatFs.availableBlocks` وهي ما يبلغه التطبيق فعلاً · قِيس الفرق ١٤٥ م.ب على جهاز واحد
  usableSpace: async () => {
    try { return await getFreeDiskStorageAsync(); }
    catch { return Number.MAX_SAFE_INTEGER; } // لا يبلّغ · لا نمنع عملية بسببه
  },
};

export const expoHasher: Hasher = async (bytes) => {
  // طبقة التحويل الأصلية على أندرويد تقبل مصفوفة بايتات منمّطة لا ArrayBuffer خاماً
  // («Cannot convert ArrayBuffer to a Kotlin type») · ننسخ نسخة مضبوطة الطول ونمررها هي
  const view = new Uint8Array(bytes);
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, view);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

/** جذر بيانات التطبيق */
export const appDataRoot = (): string => Paths.document.uri.replace(/\/$/, '');

/** md5 بترميز base64 · يطابق md5Hash الذي يحسبه Storage للملف المرفوع */
export async function expoMd5Base64(bytes: Uint8Array): Promise<string> {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.MD5, new Uint8Array(bytes));
  return toBase64(new Uint8Array(digest));
}
