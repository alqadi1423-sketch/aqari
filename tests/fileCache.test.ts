/**
 * الذاكرة المؤقتة للملفات (النموذج المختلط · قرار المالك ٢٠٢٦-١٠-٠٧): ما لم يُرفع لا يُحذف من الجهاز أبداً،
 * وما رُفع يُحذف منه الأقدم استعمالاً حين يتجاوز الحدّ، و«التفريغ» يحذف كل ما رُفع · ملفات مصطنعة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { putAttachment } from '@/files/store';
import {
  cacheUsage, clearCache, ensureLocal, evictCache, fileState, FileUnavailableError, pendingUploads, reconcileCache,
} from '@/files/cloudFiles';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
const newEnv = (): TestBackupEnv => { const d = tempDir('aq-cache-'); dirs.push(d); fs.mkdirSync(d, { recursive: true }); return makeBackupEnv(d); };
const fe = (e: TestBackupEnv) => ({ db: e.db, fs: e.fs, hasher: e.hasher!, attachmentsDir: e.attachmentsDir });
const bytesOf = (seed: number, n = 1000) => new Uint8Array(n).map((_, k) => (k * 13 + seed * 5) % 251);

async function files(env: TestBackupEnv, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = await putAttachment(fe(env), bytesOf(i), { entityType: 'library', kind: 'مستند', originalName: 'ملف' + i + '.pdf', mime: 'application/pdf' });
    out.push(a.sha256);
  }
  return out;
}
const onDisk = (env: TestBackupEnv, sha: string) => fs.existsSync(path.join(env.attachmentsDir, sha + '.pdf'));

test('الملف الجديد ينتظر الرفع ولا تمسّه الحدود ولا التفريغ', async () => {
  const env = newEnv();
  const shas = await files(env, 3);
  expect(pendingUploads(env.db).map((r) => r.sha256).sort()).toEqual([...shas].sort());
  expect(fileState(fe(env), shas[0], 'pdf')).toBe('uploading');
  expect(evictCache(fe(env), 0)).toBe(0);
  expect(clearCache(fe(env))).toBe(0);
  expect(shas.every((s) => onDisk(env, s))).toBe(true);
  expect(cacheUsage(env.db)).toEqual({ cachedBytes: 0, cachedCount: 0, pendingBytes: 3000, pendingCount: 3 });
  env.closeLive();
});

test('ما رُفع يُحذف الأقدم استعمالاً حتى الحدّ · والمفتوح للتو يبقى · والتفريغ يحذف كل ما رُفع', async () => {
  const env = newEnv();
  const shas = await files(env, 4);
  // رُفعت كلها · واستُعمل الأول أخيراً
  env.db.run(`UPDATE file_cache SET uploaded = 1`);
  shas.forEach((s, i) => env.db.run(`UPDATE file_cache SET last_used = ? WHERE sha256 = ?`, ['2026-01-0' + (i + 1), s]));
  env.db.run(`UPDATE file_cache SET last_used = '2026-02-01' WHERE sha256 = ?`, [shas[0]]);
  expect(evictCache(fe(env), 2000)).toBe(2);
  expect([onDisk(env, shas[0]), onDisk(env, shas[1]), onDisk(env, shas[2]), onDisk(env, shas[3])]).toEqual([true, false, false, true]);
  expect(fileState(fe(env), shas[1], 'pdf')).toBe('remote');
  // صفّ المرفق باقٍ · والملف يُنزَّل عند فتحه
  expect(env.db.get(`SELECT 1 FROM attachments WHERE sha256 = ?`, [shas[1]])).toBeTruthy();
  await expect(ensureLocal(fe(env), null, shas[1], 'pdf')).rejects.toBeInstanceOf(FileUnavailableError);
  // الموجود يُفتح بلا خادم ويُحدَّث استعماله
  expect(await ensureLocal(fe(env), null, shas[3], 'pdf')).toContain(shas[3]);
  expect(clearCache(fe(env))).toBe(2);
  expect(cacheUsage(env.db).cachedCount).toBe(0);
  env.closeLive();
});

test('بعد الاستعادة: كل ملفٍ هنا يُعامَل «لم يُرفع» حتى يطابقه الخادم · فلا يُفرَّغ ملفٌ ظُنّ أنه رُفع', async () => {
  const env = newEnv();
  const shas = await files(env, 3);
  env.db.run(`UPDATE file_cache SET uploaded = 1`);
  fs.rmSync(path.join(env.attachmentsDir, shas[2] + '.pdf'));
  expect(reconcileCache(fe(env))).toEqual({ present: 2, missing: 1 });
  expect(pendingUploads(env.db).length).toBe(2);
  expect(clearCache(fe(env))).toBe(0);
  env.closeLive();
});

test('نسخة «البيانات وحدها»: ما رُفع يُذكر ببصمته ولا يدخل الأرشيف، وما لم يُرفع يدخله · والاستعادة تُرجع الصفوف كلها وتترك ما في الخادم للتنزيل', async () => {
  const { createBackup } = await import('@/domain/backup/create');
  const { prepareRestore, commitRestore } = await import('@/domain/backup/restore');
  const src = newEnv();
  const shas = await files(src, 3);
  src.db.run(`UPDATE file_cache SET uploaded = 1 WHERE sha256 IN (?, ?)`, [shas[0], shas[1]]);
  const small = path.join(src.root, 'data-only.aqbk');
  const m = await createBackup(src, small, undefined, { dataOnly: true });
  expect(m.files.map((f) => f.sha256)).toEqual([shas[2]]);
  expect(m.remote_files!.map((f) => f.sha256).sort()).toEqual([shas[0], shas[1]].sort());
  const full = path.join(src.root, 'full.aqbk');
  const mf = await createBackup(src, full);
  expect(mf.files.length).toBe(3);
  expect(mf.remote_files).toBeUndefined();
  expect(fs.statSync(small).size).toBeLessThan(fs.statSync(full).size);
  src.closeLive();

  const dst = newEnv();
  const db = (await commitRestore(dst, await prepareRestore(dst, small))).db;
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments`)!.n)).toBe(3);
  const f2 = { db, fs: dst.fs, hasher: dst.hasher!, attachmentsDir: dst.attachmentsDir };
  expect([fileState(f2, shas[0], 'pdf'), fileState(f2, shas[1], 'pdf'), fileState(f2, shas[2], 'pdf')]).toEqual(['remote', 'remote', 'uploading']);
  expect(pendingUploads(db).map((r) => r.sha256)).toEqual([shas[2]]);
  dst.closeLive();
});

test('صفوف المرفقات لا تُلتقط للمزامنة قبل تفعيل التخزين · وأول تفعيل يرفعها كلها مرة', async () => {
  const { enableSync, setFilesSync, filesSyncOn, seedOutbox } = await import('@/sync/engine');
  const env = newEnv();
  enableSync(env.db, 'U-FILES-OFF');
  await files(env, 2);
  const queued = () => env.db.all<{ tbl: string }>(`SELECT tbl FROM sync_outbox WHERE tbl IN ('blobs','attachments')`).length;
  expect(filesSyncOn(env.db)).toBe(false);
  expect(queued()).toBe(0);
  seedOutbox(env.db);
  expect(queued()).toBe(0);
  expect(setFilesSync(env.db, true)).toBe(true);
  expect(queued()).toBe(4); // بصمتان ومرفقان
  expect(setFilesSync(env.db, true)).toBe(false);
  await files(env, 3); // ثلاثة مرفقات جديدة، وبصمة واحدة جديدة (الأوليان قائمتان)
  expect(queued()).toBe(8);
  env.closeLive();
});
