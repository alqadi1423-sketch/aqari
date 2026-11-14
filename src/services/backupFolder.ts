/**
 * «احفظ في مجلد» (ق٠-١ · F-الاستقلال-عن-قوقل ٥.٣ أ · قرار المالك «مابي التطبيق يرتبط بقوقل»): يختار المستخدم مجلداً مرة واحدة بإطار
 * تخزين أندرويد (مجلدٌ في الجوال، أو بطاقة ذاكرة، أو ذاكرة USB، أو ما يعرضه النظام) · ويحفظ التطبيق عنوانه وإذنه الدائم، فتُكتب فيه
 * النسخة المشفّرة .aqbk ثم تُقرأ منه وتُطابق بصمتها قبل أن تُعتمد.
 *
 * العنوان في ملفٍ صغير بمجلد التطبيق لا في القاعدة: الإذن لهذا الجهاز وحده، فلا يسافر مع النسخة ولا يعود قديماً بالاستعادة ولا يُمسح بالمسح.
 * وضياع الإذن (نُقل المجلد أو حُذف أو نُزعت البطاقة أو سُحب الإذن) يُقال بالعربية ويُطلب اختيار المجلد من جديد.
 * بلا وحدة أصلية جديدة: expo-file-system/legacy (StorageAccessFramework) المستعمل أصلاً.
 */
import * as LegacyFS from 'expo-file-system/legacy';
import { File, Paths } from 'expo-file-system';
import { whilePrompting } from './appLockService';
import { fromBase64, type Hasher } from '../files/fsAdapter';
import { throwIfCancelled, type CancelSignal, type ProgressFn } from '../domain/progress';
import { t } from '../i18n';

const SAF = LegacyFS.StorageAccessFramework;
const STORE = 'backup-folder.json';
const MIME = 'application/octet-stream';
/** قطعة القراءة والكتابة · مضاعفٌ لثلاثة فلا حشو في وسط base64 */
export const FOLDER_CHUNK = 3 * 1024 * 1024;

/** لم يُختر مجلدٌ بعد */
export class FolderMissingError extends Error {
  constructor() { super(t('folder.missing')); this.name = 'FolderMissingError'; }
}

/** المجلد المختار لا يُوصل إليه: يُختار من جديد */
export class FolderAccessError extends Error {
  constructor() { super(t('folder.lost')); this.name = 'FolderAccessError'; }
}

const storeFile = () => new File(Paths.document, STORE);

/** عنوان المجلد المختار على هذا الجهاز، أو null */
export function backupFolder(): string | null {
  try {
    const f = storeFile();
    if (!f.exists) return null;
    const j = JSON.parse(f.textSync()) as { uri?: unknown };
    return typeof j.uri === 'string' && j.uri ? j.uri : null;
  } catch { return null; }
}

function saveFolder(uri: string): void {
  const f = storeFile();
  if (!f.exists) f.create();
  f.write(JSON.stringify({ uri, at: new Date().toISOString() }));
}

/** اسمٌ يقرؤه المستخدم من عنوان المجلد: «Documents/Aqari» من …/tree/primary%3ADocuments%2FAqari */
export function folderLabel(uri: string | null): string {
  if (!uri) return '';
  try {
    const tail = decodeURIComponent(uri.split('/tree/')[1] ?? uri);
    const doc = tail.split('/document/')[0];
    const afterColon = doc.includes(':') ? doc.slice(doc.indexOf(':') + 1) : doc;
    return afterColon || doc;
  } catch { return uri; }
}

/** نافذة النظام لاختيار المجلد · يُحفظ عنوانه ويعاد · والإلغاء يعيد null ويُبقي المختار من قبل */
export async function pickBackupFolder(): Promise<string | null> {
  const r = await whilePrompting(() => SAF.requestDirectoryPermissionsAsync(backupFolder()));
  if (!r.granted || !r.directoryUri) return null;
  saveFolder(r.directoryUri);
  return r.directoryUri;
}

/** يصل التطبيق إلى المجلد ويقرؤه، وإلا FolderAccessError · يُفحص قبل بناء النسخة فلا تُبنى لتُرمى */
export async function checkFolderAccess(uri: string): Promise<void> {
  try { await SAF.readDirectoryAsync(uri); } catch { throw new FolderAccessError(); }
}

const fileUri = (p: string) => (/^[a-z]+:\/\//i.test(p) ? p : 'file://' + p);

/**
 * ملفٌ محلي إلى المجلد المختار باسمه (اسمٌ موجود يزيد عليه النظام رقماً فلا يُكتب فوق نسخةٍ سابقة) ·
 * قطعةً قطعة، ثم يُقرأ ما كُتب وتُطابق بصمته بصمة الأصل · واختلافها أو الإلغاء أو الخطأ يحذف ما كُتب.
 * يعيد عنوان الملف في المجلد واسمه.
 */
export async function writeToBackupFolder(
  localPath: string, name: string,
  o: { size: number; sha256: string; hasher: Hasher; folder?: string | null; onProgress?: ProgressFn; signal?: CancelSignal; chunk?: number },
): Promise<{ uri: string; name: string }> {
  const folder = o.folder ?? backupFolder();
  if (!folder) throw new FolderMissingError();
  await checkFolderAccess(folder);
  const chunk = o.chunk ?? FOLDER_CHUNK;
  let target: string;
  try { target = await SAF.createFileAsync(folder, name, MIME); } catch { throw new FolderAccessError(); }
  const src = fileUri(localPath);
  try {
    const label = t('folder.writing');
    o.onProgress?.(label, { done: 0, total: o.size, unit: 'bytes' });
    if (o.size === 0) await SAF.writeAsStringAsync(target, '', { encoding: LegacyFS.EncodingType.Base64 });
    for (let pos = 0; pos < o.size; pos += chunk) {
      throwIfCancelled(o.signal);
      const len = Math.min(chunk, o.size - pos);
      const b64 = await LegacyFS.readAsStringAsync(src, { encoding: LegacyFS.EncodingType.Base64, position: pos, length: len });
      try {
        await SAF.writeAsStringAsync(target, b64, { encoding: LegacyFS.EncodingType.Base64, append: pos > 0 });
      } catch { throw new FolderAccessError(); }
      o.onProgress?.(label, { done: pos + len, total: o.size, unit: 'bytes' });
    }
    throwIfCancelled(o.signal);
    // ما في المجلد هو ما كُتب: يُقرأ ويُطابق قبل أن يُعتمد
    o.onProgress?.(t('folder.verifying'));
    const back = new Uint8Array(o.size);
    let got = 0;
    for (let pos = 0; ; pos += chunk) {
      const b64 = await SAF.readAsStringAsync(target, { encoding: LegacyFS.EncodingType.Base64, position: pos, length: chunk });
      const part = fromBase64(b64);
      if (!part.length) break;
      if (got + part.length > o.size) { got += part.length; break; }
      back.set(part, got);
      got += part.length;
      if (part.length < chunk) break;
    }
    if (got !== o.size || (await o.hasher(back)).toLowerCase() !== o.sha256.toLowerCase()) {
      throw new Error(t('folder.mismatch', { name }));
    }
    return { uri: target, name: nameOf(target, name) };
  } catch (e) {
    try { await SAF.deleteAsync(target, { idempotent: true }); } catch { /* يبقى ملفاً ناقصاً يعرفه المستخدم باسمه */ }
    throw e;
  }
}

/** الاسم الذي سمّاه النظام (قد يزيد رقماً على المطلوب) من عنوان الملف · وإلا المطلوب */
function nameOf(uri: string, fallback: string): string {
  try {
    const doc = decodeURIComponent(uri.split('/document/')[1] ?? '');
    const last = doc.split(/[/:]/).pop();
    return last && last.endsWith('.aqbk') ? last : fallback;
  } catch { return fallback; }
}
