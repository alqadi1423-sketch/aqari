/**
 * C-2 (الإصلاح المرحلي) · قرار المالك س٣ 2026-11-13: «نسخة ما قبل الترقية تكون للبيانات وقائمة الملفات وبصماتها، بلا الملفات نفسها».
 *
 * السيناريو (بيانات مصطنعة): قاعدة ببنية الإصدار ١٦ فيها بيانات، ومكتبة من ١٦ ملفاً كلٌّ ١٫٥ ميغا (٢٤ ميغا). بوابة الترقية
 * كانت تنسخ المكتبة كلها في الذاكرة (tests/review9.C.backupMemory.test.ts) فيُقتل التطبيق عند كل فتح بعد التحديث.
 * الهجرات لا تمسّ ملفات المرفقات، فالنسخة تحفظ القاعدة وتذكر كل ملف ببصمته وحجمه في local_files ولا تنسخه ·
 * يُقرأ كل ملف وحده لبصمته ثم يُترك (فالتالف يُسمّى قبل الترقية · C2-R11-1)، فأكبر مصفوفة ملفٌ واحد لا المكتبة ·
 * والاستعادة تعيد البيانات وتُبقي الملفات في مكانها مطابَقةً ببصماتها، وما غاب منها يُسمّى قبل التأكيد.
 * والتصدير ونسخة الأمان قبل الاستعادة كاملةٌ بملفاتها كما هي.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { openNodeDb } from '@/db/nodeAdapter';
import { SCHEMA_VERSION } from '@/db/schema';
import { currentSchemaVersion } from '@/db/migrations';
import { nodeFs, nodeHasher } from '@/files/nodeFs';
import type { DB } from '@/db/adapter';
import type { FS } from '@/files/fsAdapter';
import { NotEnoughSpaceError, RestoreError, type BackupEnv } from '@/domain/backup/types';
import { createBackup, verifyArchiveAt, ensureFreeSpace } from '@/domain/backup/create';
import { guardedUpgrade, makePreUpgradeBackup } from '@/domain/backup/upgrade';
import { prepareRestore, commitRestore, assertSafeManifestFiles } from '@/domain/backup/restore';
import { tempDir, rmrf } from './helpers/testDb';
import { schemaAt, fill, snapshot, ins } from './helpers/oldSchema';

const MB = 1 << 20;
const FILES = 16;
/** ١٫٥ ميغا = ١٬٥٧٢٬٨٦٤ بايت · والمكتبة ١٦ × ١٬٥٧٢٬٨٦٤ = ٢٥٬١٦٥٬٨٢٤ بايت (٢٤ ميغا) */
const FILE_SIZE = 1572864;
const LIBRARY = 25165824;

/** بايتات عشوائية حتمية لا تنضغط (كالصور) */
function noise(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 255; }
  return b;
}

type Env = BackupEnv & { live(): DB };

/** بيئة فوق قاعدة ببنية الإصدار ١٦ كما يجدها التطبيق الجديد عند أول فتح · ونظام الملفات قابلٌ للمراقبة */
function oldEnv(root: string, fsImpl: FS = nodeFs): Env {
  const dbPath = path.join(root, 'data.db').replace(/\\/g, '/');
  let db = schemaAt(dbPath, 16);
  fill(db);
  return {
    get db() { return db; },
    dbPath,
    fs: fsImpl,
    hasher: nodeHasher,
    attachmentsDir: path.join(root, 'attachments').replace(/\\/g, '/'),
    tmpDir: path.join(root, 'tmp').replace(/\\/g, '/'),
    appVersion: '1.0.0-test',
    openDb: (p) => openNodeDb(p),
    closeLive: () => { try { db.close(); } catch { /* مغلقة */ } },
    reopenLive: () => { db = openNodeDb(dbPath); return db; },
    live: () => db,
  };
}

/** المكتبة على القرص بصفوفها · والبصمة تُحسب هنا مستقلةً عن مسار النسخ */
async function library(env: Env): Promise<Array<{ sha256: string; name: string }>> {
  fs.mkdirSync(env.attachmentsDir, { recursive: true });
  const out: Array<{ sha256: string; name: string }> = [];
  for (let i = 0; i < FILES; i++) {
    const bytes = noise(FILE_SIZE, i + 1);
    const sha = await nodeHasher(bytes);
    fs.writeFileSync(path.join(env.attachmentsDir, `${sha}.jpg`), bytes);
    ins(env.db, 'blobs', { sha256: sha, ext: 'jpg', size_bytes: FILE_SIZE, created_at: '2026-01-01' });
    ins(env.db, 'attachments', {
      id: `A${i}`, sha256: sha, entity_type: 'contract', entity_id: 'C1', kind: 'عقد', original_name: `صورة-${i}.jpg`, created_at: '2026-01-01',
    });
    out.push({ sha256: sha, name: `صورة-${i}.jpg` });
  }
  return out;
}

/** قراءات نظام الملفات: أكبرها، وما قُرئ من مجلد المرفقات */
function watchedFs(attachmentsDir: () => string) {
  const seen = { maxRead: 0, attachmentReads: 0 };
  const impl: FS = {
    ...nodeFs,
    read: (p: string) => {
      const b = nodeFs.read(p);
      seen.maxRead = Math.max(seen.maxRead, b.byteLength);
      if (p.replace(/\\/g, '/').startsWith(attachmentsDir() + '/')) seen.attachmentReads += 1;
      return b;
    },
  };
  return { impl, seen };
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
function root(prefix: string): string { const d = tempDir(prefix); dirs.push(d); return d; }

test('C-2 نسخة ما قبل الترقية لمكتبة ٢٤ ميغا: لا ملف فيها، وكل ملف يُقرأ وحده مرةً لبصمته، صغيرة، وتذكر كل ملف ببصمته وحجمه', async () => {
  const d = root('aq-r10c2-a-');
  let attDir = '';
  const w = watchedFs(() => attDir);
  const env = oldEnv(d, w.impl);
  attDir = env.attachmentsDir;
  const lib = await library(env);
  const before = snapshot(env.db);
  expect(lib.length * FILE_SIZE).toBe(LIBRARY);

  const { from, backupPath } = await guardedUpgrade(env);
  expect(from).toBe(16);
  expect(currentSchemaVersion(env.live())).toBe(SCHEMA_VERSION);
  expect(snapshot(env.live())).toEqual(before);

  // البوابة قرأت كل ملف مرةً واحدة لبصمته (C2-R11-1: التالف يُسمّى قبل الترقية)، ولم تمرّ بها مصفوفةٌ أكبر من ملفٍ واحد ·
  // لا المكتبة (٢٤ ميغا) كما كانت قبل قرار س٣
  expect(w.seen.attachmentReads).toBe(FILES);
  expect(w.seen.maxRead).toBeLessThanOrEqual(FILE_SIZE);

  // صغيرة: دون ميغا واحدة لمكتبة ٢٤ ميغا (كانت فوق حجم المكتبة)
  const archiveBytes = nodeFs.size(backupPath!);
  expect(archiveBytes).toBeLessThan(1 * MB);

  // الأرشيف يُعاد فتحه بالتحقق الكامل: القاعدة والبيان وحدهما، ولا مدخل مرفقات
  const { manifest, entries } = await verifyArchiveAt(env, backupPath!);
  expect(Object.keys(entries).sort()).toEqual(['data.db', 'manifest.json']);
  expect(manifest.schema_version).toBe(16);
  expect(manifest.files).toEqual([]);
  expect(manifest.missing_files).toEqual([]);
  expect(manifest.complete).toBe(true);
  // كل ملفٍ ببصمته وحجمه · والبصمات محسوبة في الاختبار من البايتات نفسها
  expect(manifest.local_files).toEqual(
    lib.map((f) => ({ sha256: f.sha256, ext: 'jpg', size: FILE_SIZE })).sort((a, b) => a.sha256.localeCompare(b.sha256)));
  expect(manifest.local_files!.reduce((s, f) => s + f.size, 0)).toBe(LIBRARY);
  env.live().close();
});

test('C-2 استعادتها تعيد البيانات والملفات باقية في مكانها ببصماتها · ونسخة الأمان قبلها كاملةٌ بملفاتها', async () => {
  const d = root('aq-r10c2-b-');
  const env = oldEnv(d);
  const lib = await library(env);
  const before = snapshot(env.db);
  const { backupPath } = await guardedUpgrade(env);
  // بعد الترقية تغيّرت البيانات · ثم استُعيدت نسخة ما قبلها
  env.live().run(`UPDATE contracts SET tenant_name = 'تغيّر بعد الترقية' WHERE id = 'C1'`);
  env.live().run(`UPDATE contract_installments SET paid_halalas = 0 WHERE id = 'I2'`);

  const plan = await prepareRestore(env, backupPath!);
  expect(plan.migrated).toBe(true);
  expect(plan.localMissing).toEqual([]);
  const res = await commitRestore(env, plan);
  expect(currentSchemaVersion(res.db)).toBe(SCHEMA_VERSION);
  expect(snapshot(res.db)).toEqual(before);
  // القسط الثاني: ٣٬٠٠٠ ريال مستحقة سُدّد منها ١٬٠٠٠ (١٠٠٬٠٠٠ هللة) كما في النسخة
  expect(res.db.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = 'I2'`)!.p).toBe(100000);

  // الملفات الستة عشر في مكانها بالبصمة نفسها، وصفوفها في النسخة المستعادة، ومعروفةٌ على الجهاز
  for (const f of lib) {
    const p = path.join(env.attachmentsDir, `${f.sha256}.jpg`);
    expect(await nodeHasher(new Uint8Array(fs.readFileSync(p)))).toBe(f.sha256);
  }
  expect(res.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments WHERE deleted_at IS NULL`)!.n).toBe(FILES);
  expect(res.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM file_cache`)!.n).toBe(FILES);

  // نسخة الأمان قبل الاستعادة ليست ما قبل الترقية: كاملةٌ بملفاتها الستة عشر
  const safety = await verifyArchiveAt(env, res.safetyBackupPath);
  expect(safety.manifest.files.map((f) => f.sha256).sort()).toEqual(lib.map((f) => f.sha256).sort());
  expect(safety.manifest.local_files).toBeUndefined();
  expect(safety.manifest.files.reduce((s, f) => s + f.size, 0)).toBe(LIBRARY);
  res.db.close();
});

test('C-2 ملفٌ مذكور غاب عن الجهاز أو تغيّر يُسمّى باسمه قبل التأكيد · والبيانات تعود والباقي سليم', async () => {
  const d = root('aq-r10c2-c-');
  const env = oldEnv(d);
  const lib = await library(env);
  const before = snapshot(env.db);
  const { backupPath } = await guardedUpgrade(env);
  // بعد الترقية: ملفٌ حُذف من القرص، وآخر تغيّر محتواه بالحجم نفسه
  fs.rmSync(path.join(env.attachmentsDir, `${lib[3].sha256}.jpg`));
  fs.writeFileSync(path.join(env.attachmentsDir, `${lib[7].sha256}.jpg`), noise(FILE_SIZE, 999));

  const plan = await prepareRestore(env, backupPath!);
  expect([...plan.localMissing].sort()).toEqual(['صورة-3.jpg', 'صورة-7.jpg']);
  const res = await commitRestore(env, plan);
  expect(snapshot(res.db)).toEqual(before);
  // الأربعة عشر الباقية سليمة · والمحذوف لا يعود من نسخةٍ لا تحمله
  for (const [i, f] of lib.entries()) {
    const p = path.join(env.attachmentsDir, `${f.sha256}.jpg`);
    if (i === 3) { expect(fs.existsSync(p)).toBe(false); continue; }
    if (i === 7) continue;
    expect(await nodeHasher(new Uint8Array(fs.readFileSync(p)))).toBe(f.sha256);
  }
  res.db.close();
});

test('C-2 البوابة لا تطلب مساحة المكتبة لنسخةٍ لا تنسخها · والتصدير يطلبها ويبقى كاملاً بملفاته', async () => {
  const d = root('aq-r10c2-d-');
  const base = oldEnv(d);
  const lib = await library(base);
  // ١٠ ميغا متاحة: تسع ثلاثة أضعاف القاعدة، ولا تسع ثلاثة أضعاف مكتبة ٢٤ ميغا (٧٢ ميغا)
  const tight: Env = { ...base, get db() { return base.live(); }, fs: { ...nodeFs, usableSpace: async () => 10 * MB } };
  await expect(ensureFreeSpace(tight)).rejects.toBeInstanceOf(NotEnoughSpaceError);
  const { path: pre, manifest } = await makePreUpgradeBackup(tight);
  expect(manifest.local_files).toHaveLength(FILES);
  expect(fs.existsSync(pre)).toBe(true);

  // التصدير (createBackup بلا preUpgrade) كاملٌ بملفاته كما كان، ولا local_files فيه
  const out = path.join(base.tmpDir, 'export.aqbk').replace(/\\/g, '/');
  const full = await createBackup(base, out);
  expect(full.local_files).toBeUndefined();
  expect(full.files.map((f) => f.sha256).sort()).toEqual(lib.map((f) => f.sha256).sort());
  expect(nodeFs.size(out)).toBeGreaterThan(LIBRARY);
  base.live().close();
});

test('C-2 قائمة ملفات الجهاز في البيان تُفحص قبل أن يُبنى منها مسار', () => {
  const ok = 'a'.repeat(64);
  const m = (local: unknown) => ({ files: [], local_files: local }) as unknown as Parameters<typeof assertSafeManifestFiles>[0];
  expect(() => assertSafeManifestFiles(m([{ sha256: ok, ext: 'jpg', size: 1 }]))).not.toThrow();
  expect(() => assertSafeManifestFiles(m(undefined))).not.toThrow();
  expect(() => assertSafeManifestFiles(m([{ sha256: '../../data', ext: 'db', size: 1 }]))).toThrow(RestoreError);
  expect(() => assertSafeManifestFiles(m([{ sha256: ok, ext: 'jpg', size: 1 }, { sha256: ok, ext: 'jpg', size: 1 }]))).toThrow(RestoreError);
  expect(() => assertSafeManifestFiles(m('x'))).toThrow(RestoreError);
});
