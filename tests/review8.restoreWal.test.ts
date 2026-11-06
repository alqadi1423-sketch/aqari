/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ٢٠: الاستعادة كانت تحذف ملف WAL الحي بعد إغلاقٍ قد يفشل بصمت فيضيع ما لم يُدمج منه،
 * والتراجع بعد فشلها يُرجع القاعدة السابقة وبجانبها WAL القاعدة المستعادة · بيانات مصطنعة.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { tempDir } from './helpers/testDb';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { nodeFs } from '@/files/nodeFs';
import type { FS } from '@/files/fsAdapter';

const lateWrite = (env: TestBackupEnv) => env.live().run(`INSERT INTO tenants (id, name, created_at) VALUES ('T-LATE', 'مستأجر متأخر مصطنع', 'x')`);
const ok = (env: TestBackupEnv) => String(Object.values(env.live().get<Record<string, string>>(`PRAGMA integrity_check`)!)[0]);

async function archiveOf(): Promise<string> {
  const src = makeBackupEnv(tempDir('aq-wal-src-'));
  src.db.run(`INSERT INTO tenants (id, name, created_at) VALUES ('T-SRC', 'مستأجر النسخة المصطنع', 'x')`);
  const archive = path.join(src.root, 'r.aqbk');
  await createBackup(src, archive);
  src.closeLive();
  return archive;
}

test('٢٠ ما في WAL الحي يُدمج قبل الإغلاق: إغلاقٌ فشل بصمت ثم فشلت الاستعادة فلا يضيع آخر ما كُتب', async () => {
  const archive = await archiveOf();
  const dst = makeBackupEnv(tempDir('aq-wal-dst-'));
  dst.db.run(`INSERT INTO tenants (id, name, created_at) VALUES ('T-LIVE', 'مستأجر حيّ مصطنع', 'x')`);
  expect(fs.statSync(dst.dbPath + '-wal').size).toBeGreaterThan(0);
  const plan = await prepareRestore(dst, archive);
  let opens = 0;
  const env: TestBackupEnv = {
    ...dst, get db() { return dst.live(); },
    closeLive: () => { /* إغلاقٌ لم يتم (ابتلع خطأه) */ },
    reopenLive: () => { if (opens++ === 0) throw new Error('فشل فتح مصطنع'); return dst.reopenLive(); },
  };
  // كتابةٌ بعد نسخة الأمان (تُدمج WAL) وقبل التبديل: الاستعادة غير متزامنة فيكتب غيرها في انتظارها
  await expect(commitRestore(env, plan, (m) => { if (m === 'جاري التبديل إلى النسخة') lateWrite(dst); })).rejects.toThrow();
  expect(dst.live().get(`SELECT 1 FROM tenants WHERE id = 'T-LIVE'`)).toBeTruthy();
  expect(dst.live().get(`SELECT 1 FROM tenants WHERE id = 'T-LATE'`)).toBeTruthy();
  expect(ok(dst)).toBe('ok');
  dst.closeLive();
});

test('٢٠ والتراجع يحذف WAL القاعدة المستعادة وملف ذاكرتها قبل إرجاع السابقة', async () => {
  const archive = await archiveOf();
  const dst = makeBackupEnv(tempDir('aq-wal-dst2-'));
  dst.db.run(`INSERT INTO tenants (id, name, created_at) VALUES ('T-LIVE', 'مستأجر حيّ مصطنع', 'x')`);
  const plan = await prepareRestore(dst, archive);
  // فشلٌ بعد فتح المستعادة والكتابة فيها (نقل المرفقات) · وإغلاقها لم يتم فبقي WAL بجانبها
  plan.manifest.files.push({ sha256: 'a'.repeat(64), ext: 'bin', size: 1 } as never);
  const ops: string[] = [];
  const failingFs: FS = {
    ...nodeFs,
    rename: (a, b) => { ops.push('rename:' + a + '>' + b); if (a.includes('attachments')) throw new Error('انقطاع مصطنع'); nodeFs.rename(a, b); },
    remove: (p) => { ops.push('remove:' + p); nodeFs.remove(p); },
  };
  const opened: Array<ReturnType<TestBackupEnv['live']>> = [];
  const env: TestBackupEnv = {
    ...dst, fs: failingFs, get db() { return dst.live(); },
    closeLive: () => { /* إغلاقٌ لم يتم */ },
    reopenLive: () => { const d = dst.reopenLive(); opened.push(d); return d; },
  };
  await expect(commitRestore(env, plan, (m) => { if (m === 'جاري التبديل إلى النسخة') lateWrite(dst); })).rejects.toThrow();
  expect(dst.live().get(`SELECT 1 FROM tenants WHERE id = 'T-LIVE'`)).toBeTruthy();
  expect(dst.live().get(`SELECT 1 FROM tenants WHERE id = 'T-LATE'`)).toBeTruthy();
  expect(dst.live().get(`SELECT 1 FROM tenants WHERE id = 'T-SRC'`)).toBeFalsy();
  // بعد الفشل: حذف القاعدة المستعادة ثم WAL ها قبل إرجاع السابقة (بقي بجانبها لأن إغلاقها لم يتم)
  const back = ops.lastIndexOf('rename:' + dst.dbPath + '.pre-restore>' + dst.dbPath);
  const fail = ops.findIndex((o) => o.startsWith('rename:') && o.includes('attachments'));
  expect(back).toBeGreaterThan(fail);
  expect(ops.slice(fail, back)).toContain('remove:' + dst.dbPath + '-wal');
  expect(ok(dst)).toBe('ok');
  for (const d of opened) { try { d.close(); } catch { /* مغلقة */ } }
});

test('٢٠ وإغلاق القاعدة الحية في بيئة التطبيق لا يبتلع فشله فتتوقف الاستعادة قبل لمس الملفات', async () => {
  const svc = fs.readFileSync(path.resolve(__dirname, '..', 'src/services/backupService.ts'), 'utf8');
  const line = svc.split('\n').find((l) => l.includes('closeLive:'))!;
  expect(line).not.toMatch(/catch/);
  // والإغلاق الذي يرمي يوقفها قبل أن يُمسّ ملف: القاعدة الحية كما هي وبياناتها فيها
  const archive = await archiveOf();
  const dst = makeBackupEnv(tempDir('aq-wal-dst3-'));
  dst.db.run(`INSERT INTO tenants (id, name, created_at) VALUES ('T-LIVE', 'مستأجر حيّ مصطنع', 'x')`);
  const plan = await prepareRestore(dst, archive);
  const env: TestBackupEnv = { ...dst, get db() { return dst.live(); }, closeLive: () => { throw new Error('إغلاقٌ فاشل مصطنع'); } };
  await expect(commitRestore(env, plan)).rejects.toThrow(/إغلاق/);
  expect(fs.existsSync(dst.dbPath + '.pre-restore')).toBe(false);
  expect(dst.live().get(`SELECT 1 FROM tenants WHERE id = 'T-LIVE'`)).toBeTruthy();
  expect(ok(dst)).toBe('ok');
  dst.closeLive();
});
