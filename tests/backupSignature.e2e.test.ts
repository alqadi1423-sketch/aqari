/**
 * الثلاث معاً على أرشيف فيه مرفق يحمل التوقيع `50 4B 03 04`:
 * إنشاء نسخة · استيراد نسخة · حذف كل البيانات.
 *
 * وهذا هو الشرط الذي وضعه المالك قبل بناء أي حزمة · فمرفق واحد يحمل التوقيع
 * كان يكفي لإسقاط العمليات الثلاث معاً، لأن الثلاث تمرّ بإنشاء نسخة والتحقق منها.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { makeBackupEnv } from './helpers/backupEnv';
import { createBackup, verifyArchiveAt } from '@/domain/backup/create';
import { restoreBackup } from '@/domain/backup/restore';
import { wipeAllData } from '@/domain/wipe';
import { putAttachment } from '@/files/store';
import { unzipYielding } from '@/domain/backup/zipStream';

/** توقيع الترويسة المحلية · أول أربع بايتات في كل zip وdocx وxlsx وpptx */
const SIG = [0x50, 0x4B, 0x03, 0x04];

/** مرفق يحمل التوقيع وخلفه ترويسة كاذبة كاملة بطريقة ضغط مجهولة */
function trappedFile(size: number, at: number): Uint8Array {
  const a = new Uint8Array(size);
  for (let i = 0; i < size; i++) a[i] = (i * 31 + 7) & 255;
  a.set(SIG, at);
  a[at + 4] = 20; a[at + 6] = 0; a[at + 7] = 0;
  a[at + 8] = 12; a[at + 9] = 0;          // طريقة ضغط لا محلّل لها
  for (let k = 10; k < 26; k++) a[at + k] = 0;
  a[at + 18] = 8;
  a[at + 26] = 4; a[at + 28] = 0;
  a[at + 30] = 0x66; a[at + 31] = 0x61; a[at + 32] = 0x6B; a[at + 33] = 0x65;
  return a;
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqari-sig-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ويندوز قد يمسك مقبضاً */ } });

/** بيئة فيها مرفقات ملغومة كما في مكتبة المالك */
async function envWithTraps(root: string) {
  const env = makeBackupEnv(root);
  for (let i = 0; i < 6; i++) {
    await putAttachment(env.filesEnv, trappedFile(4096 + i * 100, 1024 + i * 7), {
      entityType: 'library', kind: 'other', originalName: 'ملغوم' + i + '.docx', mime: 'application/zip',
    });
  }
  // ومرفق نظيف بينها كي يُكشف أي انزياح
  await putAttachment(env.filesEnv, new Uint8Array(3000).fill(7), {
    entityType: 'library', kind: 'other', originalName: 'نظيف.bin', mime: 'application/octet-stream',
  });
  return env;
}

describe('الثلاث على أرشيف فيه مرفق يحمل التوقيع', () => {
  test('١ · إنشاء نسخة → ملف aqbk صالح يُفكّ كاملاً', async () => {
    const env = await envWithTraps(dir);
    const out = path.join(dir, 'نسخة.aqbk');
    const manifest = await createBackup(env, out);
    expect(manifest.files.length).toBe(7);
    expect(manifest.complete).toBe(true);
    expect(fs.existsSync(out)).toBe(true);

    const entries = await unzipYielding(env.fs.read(out));
    expect(entries['manifest.json']).toBeTruthy();
    expect(entries['data.db']).toBeTruthy();
    // كل مرفق في الأرشيف ببصمته ملفاً كاملاً
    for (const f of manifest.files) {
      expect(entries[`attachments/${f.sha256}.${f.ext}`]?.length).toBe(f.size);
    }
    expect(Object.keys(entries).length).toBe(9);
  });

  test('٢ · استيراد نسخة → بلا خطأ وبكل مرفقاتها', async () => {
    const src = await envWithTraps(dir);
    const arch = path.join(dir, 'للاستيراد.aqbk');
    const made = await createBackup(src, arch);

    // جهاز نظيف يستقبلها
    const destRoot = path.join(dir, 'جهاز-آخر');
    fs.mkdirSync(destRoot, { recursive: true });
    const dest = makeBackupEnv(destRoot);
    const res = await restoreBackup(dest, arch);
    expect(res.manifest.files.length).toBe(made.files.length);
    for (const f of made.files) {
      const p = path.join(dest.attachmentsDir, `${f.sha256}.${f.ext}`);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBe(f.size);
    }
  });

  test('٣ · حذف كل البيانات → بلا خطأ وبنسخة أمان صالحة', async () => {
    const env = await envWithTraps(dir);
    const before = Number(env.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM attachments WHERE deleted_at IS NULL`)!.n);
    expect(before).toBe(7);

    const safety = await wipeAllData(env);
    expect(fs.existsSync(safety)).toBe(true);

    // لا شيء على الجهاز بعد المسح · ولا في السلة
    const after = Number(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments`)!.n);
    expect(after).toBe(0);

    // ونسخة الأمان نفسها صالحة تُفكّ وتُتحقّق
    const v = await verifyArchiveAt(env, safety);
    expect(v.manifest.files.length).toBe(7);
  });
});
