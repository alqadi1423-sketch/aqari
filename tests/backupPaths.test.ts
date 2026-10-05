/**
 * ارتداد النسخ الاحتياطي على الجهاز · التقاط العلة نفسها:
 * المسارات على أندرويد تحمل file:// — وSQLite يرفضها داخل VACUUM INTO.
 * البيئة هنا تحاكي الجهاز حرفياً (مسارات بالـscheme ومحوّل ملفات ينزعها كما يفعل expoFs)،
 * ومعها: البديل الذي لا يفشل، والفشل النظيف بلا ملف نصفي.
 */
import * as path from 'node:path';
import * as fsNode from 'node:fs';
import * as os from 'node:os';
import { makeBackupEnv } from './helpers/backupEnv';
import { createBackup, verifyArchiveAt } from '@/domain/backup/create';
import type { BackupEnv } from '@/domain/backup/types';
import type { FS } from '@/files/fsAdapter';

const mkroot = () => fsNode.mkdtempSync(path.join(os.tmpdir(), 'aq-bkpath-')).replace(/\\/g, '/');

/** نزع file:// وحده كما يفعل الجهاز · فيبقى /tmp مطلقاً على لينكس وC:/ على ويندوز (المراجعة ٤.١٧) */
const strip = (p: string) => (p.startsWith('file://') ? p.slice('file://'.length) : p);

/** يحاكي expoFs: يقبل مسارات بـfile:// وينزعها قبل القرص */
const schemeFs = (inner: FS): FS => {
  return {
    read: (p) => inner.read(strip(p)),
    write: (p, b) => inner.write(strip(p), b),
    exists: (p) => inner.exists(strip(p)),
    remove: (p) => inner.remove(strip(p)),
    mkdirp: (d) => inner.mkdirp(strip(d)),
    list: (d) => inner.list(strip(d)),
    rename: (a, b) => inner.rename(strip(a), strip(b)),
    size: (p) => inner.size(strip(p)),
    usableSpace: () => inner.usableSpace(),
  };
};

/** بيئة جهاز: كل المسارات بالـscheme كما يبنيها التطبيق من Paths.document.uri */
function deviceLikeEnv() {
  const base = makeBackupEnv(mkroot());
  const env: BackupEnv = {
    ...base,
    get db() { return base.db; },
    dbPath: 'file://' + base.dbPath,
    tmpDir: 'file://' + (base as unknown as { tmpDir: string }).tmpDir,
    attachmentsDir: 'file://' + base.attachmentsDir,
    fs: schemeFs(base.fs),
    // فاتح القاعدة بالنزع نفسه
    openDb: (p) => base.openDb(strip(p)),
  };
  return { env, base };
}

describe('النسخ الاحتياطي بمسارات الجهاز (file://)', () => {
  test('علة الجهاز حرفياً: VACUUM INTO بمسار يحمل file:// — النسخة تنجح الآن وتتحقق', async () => {
    const { env, base } = deviceLikeEnv();
    const out = 'file://' + path.posix.join(base.root, 'نسخة.aqbk');
    const manifest = await createBackup(env, out);
    expect(manifest.complete).toBe(true);
    // التحقق بإعادة الفتح من القرص
    const v = await verifyArchiveAt(env, out, manifest);
    expect(v.manifest.db_sha256).toBe(manifest.db_sha256);
    base.closeLive();
  });

  test('نسخة ثانية بعد الأولى مباشرة: تنجح والهدف السابق يُستبدل', async () => {
    const { env, base } = deviceLikeEnv();
    const out = 'file://' + path.posix.join(base.root, 'نسخة.aqbk');
    await createBackup(env, out);
    const m2 = await createBackup(env, out);
    expect(m2.complete).toBe(true);
    base.closeLive();
  });

  test('البديل الذي لا يفشل: إن رُفض VACUUM INTO تُنسخ القاعدة بايتاً ببايت وتُعاد للحياة', async () => {
    const { env, base } = deviceLikeEnv();
    // نحاكي إصدار sqlite يرفض VACUUM INTO كلياً
    // مفوِّض حي: يقرأ القاعدة الحالية عند كل نداء فلا يمسك نسخة أُغلقت
    const rejecting = {
      exec: (sql: string) => {
        if (sql.startsWith('VACUUM INTO')) throw new Error('unable to open database');
        return base.live().exec(sql);
      },
      run: (sql: string, params?: unknown) => base.live().run(sql, params as never),
      get: (sql: string, params?: unknown) => base.live().get(sql, params as never),
      all: (sql: string, params?: unknown) => base.live().all(sql, params as never),
      transaction: <T,>(fn: () => T) => base.live().transaction(fn),
      close: () => base.live().close(),
    };
    const env2: BackupEnv = { ...env, get db() { return rejecting as unknown as BackupEnv['db']; }, closeLive: env.closeLive, reopenLive: env.reopenLive };
    const out = 'file://' + path.posix.join(base.root, 'نسخة-بديل.aqbk');
    const manifest = await createBackup(env2, out);
    expect(manifest.complete).toBe(true);
    // القاعدة الحية أُعيد فتحها وتعمل
    expect(base.live().get<{ n: number }>(`SELECT COUNT(*) AS n FROM accounts`)).toBeTruthy();
    base.closeLive();
  });

  test('قطع النسخ في منتصفه: لا ملف نصفي في tmp ولا أرشيف في الوجهة والقاعدة تعمل', async () => {
    const { env, base } = deviceLikeEnv();
    // الكتابة الأولى للأرشيف تفشل (امتلاء مساحة مثلاً)
    const failingFs: FS = {
      ...env.fs,
      write: (p, b) => {
        if (p.includes('backup-arch-')) throw new Error('no space left on device');
        env.fs.write(p, b);
      },
    };
    const env2: BackupEnv = { ...env, get db() { return env.db; }, fs: failingFs };
    const out = 'file://' + path.posix.join(base.root, 'نسخة-مقطوعة.aqbk');
    await expect(createBackup(env2, out)).rejects.toThrow();
    // لا مخلفات: tmp فارغ من ملفات النسخة، والوجهة غير موجودة
    const leftovers = env.fs.list(env.tmpDir).filter((n) => n.startsWith('backup-'));
    expect(leftovers).toHaveLength(0);
    expect(env.fs.exists(out)).toBe(false);
    expect(base.live().get<{ n: number }>(`SELECT COUNT(*) AS n FROM accounts`)).toBeTruthy();
    base.closeLive();
  });
});
