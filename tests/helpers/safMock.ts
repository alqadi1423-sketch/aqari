/**
 * إطار تخزين أندرويد (SAF) مصطنع فوق مجلدٍ مؤقت · لـ expo-file-system/legacy (StorageAccessFramework) ومعه File وPaths من
 * expo-file-system للملفات الصغيرة في مجلد التطبيق · بيانات مصطنعة.
 *
 * عناوين المجلد والملف بصيغة أندرويد (content://…/tree/… و…/document/…)، والإذن يُسحب بـ saf.revoked،
 * والكتابة التالفة (مزوّدٌ يقطع الملف) بـ saf.corrupt.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const saf = {
  /** المجلد الذي «يختاره» المستخدم في نافذة النظام · null = ألغى */
  pickDir: null as string | null,
  /** سُحب الإذن أو حُذف المجلد أو نُزعت البطاقة */
  revoked: false,
  /** المزوّد يكتب أقل مما أُعطي (آخر قطعة تُقطع) */
  corrupt: false,
  /** جذر مجلد التطبيق (Paths.document) */
  docRoot: '',
  /** ما طُلب من الإطار بالترتيب */
  calls: [] as string[],
  reset() { this.pickDir = null; this.revoked = false; this.corrupt = false; this.calls = []; },
};

const TREE = 'content://com.android.externalstorage.documents/tree/';
export const treeUri = (dir: string) => TREE + encodeURIComponent(dir);
const docUri = (tree: string, file: string) => tree + '/document/' + encodeURIComponent(file);

/** المسار على القرص لعنوانٍ من أي صيغة */
export function pathOf(uri: string): string {
  if (uri.startsWith('file://')) return uri.slice('file://'.length);
  if (uri.startsWith(TREE)) {
    const i = uri.indexOf('/document/');
    return decodeURIComponent(i >= 0 ? uri.slice(i + '/document/'.length) : uri.slice(TREE.length));
  }
  return uri;
}

const denied = (uri: string) => new Error(`Location '${uri}' isn't readable.`);
const isContent = (uri: string) => uri.startsWith('content://');

async function readAsStringAsync(uri: string, o: { encoding?: string; position?: number; length?: number } = {}) {
  if (isContent(uri) && saf.revoked) throw denied(uri);
  let buf = fs.readFileSync(pathOf(uri));
  if (o.position !== undefined || o.length !== undefined) {
    const start = o.position ?? 0;
    buf = buf.subarray(start, o.length !== undefined ? start + o.length : undefined);
  }
  return o.encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8');
}

export const legacyMock = {
  EncodingType: { UTF8: 'utf8', Base64: 'base64' },
  readAsStringAsync,
  StorageAccessFramework: {
    async requestDirectoryPermissionsAsync() {
      saf.calls.push('pick');
      if (!saf.pickDir) return { granted: false };
      fs.mkdirSync(saf.pickDir, { recursive: true });
      saf.revoked = false;
      return { granted: true, directoryUri: treeUri(saf.pickDir) };
    },
    async readDirectoryAsync(uri: string) {
      saf.calls.push('list');
      const dir = pathOf(uri);
      if (saf.revoked || !fs.existsSync(dir)) throw denied(uri);
      return fs.readdirSync(dir).map((n) => docUri(uri, path.join(dir, n)));
    },
    async createFileAsync(uri: string, name: string, mime: string) {
      saf.calls.push('create:' + mime);
      const dir = pathOf(uri);
      if (saf.revoked || !fs.existsSync(dir)) throw denied(uri);
      // كما يفعل مزوّد التخزين: اسمٌ موجود يُضاف إليه رقم
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let n = 0;
      let full = path.join(dir, name);
      while (fs.existsSync(full)) full = path.join(dir, `${stem} (${++n})${ext}`);
      fs.writeFileSync(full, '');
      return docUri(uri, full);
    },
    async writeAsStringAsync(uri: string, data: string, o: { encoding?: string; append?: boolean } = {}) {
      saf.calls.push('write' + (o.append ? ':append' : ''));
      if (saf.revoked) throw denied(uri);
      let bytes = o.encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
      if (saf.corrupt && bytes.length > 1) bytes = bytes.subarray(0, bytes.length - 1);
      if (o.append) fs.appendFileSync(pathOf(uri), bytes);
      else fs.writeFileSync(pathOf(uri), bytes);
    },
    readAsStringAsync,
    async deleteAsync(uri: string) {
      saf.calls.push('delete');
      try { fs.rmSync(pathOf(uri)); } catch { /* غير موجود */ }
    },
  },
};

/** File وPaths (الواجهة الجديدة) للملفات الصغيرة في مجلد التطبيق، وقراءة الملف الذي يسلّمه منتقي الملفات */
class MockFile {
  p: string;
  constructor(dir: { root?: string } | string, name?: string) {
    const base = typeof dir === 'string' ? pathOf(dir) : saf.docRoot;
    this.p = name === undefined ? base : path.join(base, name);
  }
  get uri() { return 'file://' + this.p; }
  get exists() { return fs.existsSync(this.p); }
  get size() { return fs.statSync(this.p).size; }
  create() { fs.mkdirSync(path.dirname(this.p), { recursive: true }); fs.writeFileSync(this.p, ''); }
  write(s: string | Uint8Array) { fs.writeFileSync(this.p, s); }
  delete() { fs.rmSync(this.p); }
  textSync() { return fs.readFileSync(this.p, 'utf8'); }
  bytesSync() { return new Uint8Array(fs.readFileSync(this.p)); }
  async arrayBuffer() { const b = fs.readFileSync(this.p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
}
export const expoFsMock = { File: MockFile, Paths: { get document() { return { root: saf.docRoot, uri: 'file://' + saf.docRoot }; } } };
