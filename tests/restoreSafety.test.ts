/**
 * الاستعادة ذرّية: تتم كاملة أو لا تتم إطلاقاً · جدول تحقق المالك:
 * ملف ليس نسخة، أرشيف عُدّل بايت، إصدار أحدث، مرفق ناقص، قطع عند التبديل،
 * فشل نسخة الأمان · وفي كل حالة البيانات السابقة كاملة وintegrity_check = ok.
 */
import * as path from 'node:path';
import * as fsNode from 'node:fs';
import * as os from 'node:os';
import { makeBackupEnv } from './helpers/backupEnv';
import { createBackup, orphanAttachments } from '@/domain/backup/create';
import { prepareRestore, commitRestore, restoreBackup } from '@/domain/backup/restore';
import { putAttachment } from '@/files/store';
import type { BackupEnv } from '@/domain/backup/types';
import type { FS } from '@/files/fsAdapter';

const mkroot = () => fsNode.mkdtempSync(path.join(os.tmpdir(), 'aq-restore-')).replace(/\\/g, '/');

async function seededEnvWithBackup() {
  const env = makeBackupEnv(mkroot());
  env.db.run(`INSERT INTO properties (id, name, created_at) VALUES ('P1','عقار الاختبار',datetime('now'))`);
  await putAttachment(env.filesEnv, new Uint8Array(2048).fill(7), {
    entityType: 'property', entityId: 'P1', kind: 'deed', originalName: 'صك.pdf', mime: 'application/pdf',
  });
  const archive = path.posix.join(env.root, 'نسخة.aqbk');
  await createBackup(env, archive);
  return { env, archive };
}

const intactCheck = (env: ReturnType<typeof makeBackupEnv>) => {
  const ic = env.live().get<Record<string, string>>(`PRAGMA integrity_check`)!;
  expect(String(Object.values(ic)[0])).toBe('ok');
  expect(env.live().get<{ name: string }>(`SELECT name FROM properties WHERE id='P1'`)!.name).toBe('عقار الاختبار');
};

describe('الاستعادة لا تمسّ القائم حتى يثبت البديل · وكل فشل يرجع بالبيانات كما كانت', () => {
  test('ملف ليس نسخة احتياطية: رسالة عربية والبيانات كما هي', async () => {
    const { env } = await seededEnvWithBackup();
    const junk = path.posix.join(env.root, 'ليس-نسخة.aqbk');
    env.fs.write(junk, new Uint8Array([1, 2, 3, 4, 5]));
    await expect(prepareRestore(env, junk)).rejects.toThrow(/ليس نسخة احتياطية/);
    intactCheck(env);
    env.closeLive();
  });

  test('أرشيف عُدّل بايت واحد: يُرفض في التشغيل التجريبي قبل أي مساس', async () => {
    const { env, archive } = await seededEnvWithBackup();
    const bytes = env.fs.read(archive);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    const tampered = path.posix.join(env.root, 'معدل.aqbk');
    env.fs.write(tampered, bytes);
    await expect(prepareRestore(env, tampered)).rejects.toThrow();
    intactCheck(env);
    env.closeLive();
  });

  test('نسخة من إصدار أحدث: «حدّث التطبيق أولاً» بلا انهيار', async () => {
    const { env, archive } = await seededEnvWithBackup();
    // نرفع إصدار البيان يدوياً داخل الأرشيف
    const { unzipSync, zipSync, strToU8, strFromU8 } = await import('fflate');
    const entries = unzipSync(env.fs.read(archive));
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    manifest.schema_version = 999;
    entries['manifest.json'] = strToU8(JSON.stringify(manifest));
    const newer = path.posix.join(env.root, 'أحدث.aqbk');
    env.fs.write(newer, zipSync(entries));
    await expect(prepareRestore(env, newer)).rejects.toThrow(/حدّث التطبيق أولاً/);
    intactCheck(env);
    env.closeLive();
  });

  test('نسخة ينقصها مرفق مذكور في بيانها: تُرفض قبل التبديل', async () => {
    const { env, archive } = await seededEnvWithBackup();
    const { unzipSync, zipSync } = await import('fflate');
    const entries = unzipSync(env.fs.read(archive));
    const attName = Object.keys(entries).find((k) => k.startsWith('attachments/'))!;
    delete entries[attName];
    const missing = path.posix.join(env.root, 'ناقصة.aqbk');
    env.fs.write(missing, zipSync(entries));
    await expect(prepareRestore(env, missing)).rejects.toThrow(/ينقصها مرفق/);
    intactCheck(env);
    env.closeLive();
  });

  test('قطع التبديل في منتصفه: رجوع فوري والبيانات السابقة كاملة والتطبيق حي', async () => {
    const { env, archive } = await seededEnvWithBackup();
    const plan = await prepareRestore(env, archive);
    // إفشال نقل القاعدة المجهزة إلى مكانها
    const failingFs: FS = {
      ...env.fs,
      rename: (a, b) => {
        if (a === plan.stagedDbPath) throw new Error('انقطاع مفتعل عند التبديل');
        env.fs.rename(a, b);
      },
    };
    const env2: BackupEnv = { ...env, get db() { return env.db; }, fs: failingFs, closeLive: env.closeLive, reopenLive: env.reopenLive };
    await expect(commitRestore(env2, plan)).rejects.toThrow();
    intactCheck(env);
    env.closeLive();
  });

  test('فشل نسخة الأمان يلغي الاستعادة كلها قبل أي تبديل', async () => {
    const { env, archive } = await seededEnvWithBackup();
    const plan = await prepareRestore(env, archive);
    // إفشال كتابة نسخة الأمان (كأن المساحة امتلأت)
    const failingFs: FS = {
      ...env.fs,
      rename: (a, b) => {
        if (b.includes('pre-restore-')) throw new Error('no space');
        env.fs.rename(a, b);
      },
    };
    const env2: BackupEnv = { ...env, get db() { return env.db; }, fs: failingFs, closeLive: env.closeLive, reopenLive: env.reopenLive };
    await expect(commitRestore(env2, plan)).rejects.toThrow(/تعذّر تأمين بياناتك/);
    intactCheck(env);
    env.closeLive();
  });

  test('الملخص قبل التبديل: أعداد النسخة وأعداد الحالية معاً', async () => {
    const { env, archive } = await seededEnvWithBackup();
    // نضيف عقاراً ثانياً بعد النسخة · الملخص يجب أن يظهر الفرق
    env.db.run(`INSERT INTO properties (id, name, created_at) VALUES ('P2','عقار لاحق',datetime('now'))`);
    const plan = await prepareRestore(env, archive);
    expect(plan.incoming.properties).toBe(1);
    expect(plan.current.properties).toBe(2);
    expect(plan.manifest.files.length).toBe(1);
    // الطرف الحالي يُعرض بالبنود نفسها التي يُعرض بها الوارد: عدد المرفقات وحجمها
    expect(plan.currentAttachments.count).toBe(1);
    expect(plan.currentAttachments.bytes).toBeGreaterThan(0);
    // ثم التنفيذ: يرجع لعقار واحد والمرفق موجود
    const res = await commitRestore(env, plan);
    expect(res.manifest.complete).toBe(true);
    const rows = env.live().all(`SELECT id FROM properties`);
    expect(rows).toHaveLength(1);
    env.closeLive();
  });
});

  test('فتحٌ يعيد قاعدة فارغة بدل المجهَّزة يُرفض · لا فحص صامتاً على غير المقصود', async () => {
    const { env, archive } = await seededEnvWithBackup();
    // محاكاة عطل الجهاز المصطاد: openDb ينشئ قاعدة فارغة في غير المكان
    const emptyOpen = { ...env, get db() { return env.db; }, openDb: () => {
      const { memDb } = require('./helpers/testDb') as typeof import('./helpers/testDb');
      const d = memDb();
      d.exec('DROP TABLE IF EXISTS properties');
      return d;
    } };
    await expect(prepareRestore(emptyOpen as never, archive)).rejects.toThrow(/تعذّر فتح قاعدة النسخة للفحص/);
    intactCheck(env);
    env.closeLive();
  });

/**
 * التراجع الناقص · العطل الذي أثبته القياس على الجهاز:
 * كان نقل المرفقات يسبق الفحص النهائي، فإن فشل ما بعده رجعت القاعدة ولم ترجع الملفات،
 * فتبقى في مجلد المرفقات بلا صفّ في blobs · ولا مكنسة في التطبيق تراها.
 * المعيار هنا هو معيار المالك حرفياً: عدد ملفات attachments = عدد صفوف blobs.
 */
describe('لا يبقى ملف مرفق بلا صفّ بعد أي فشل', () => {
  const countFiles = (env: ReturnType<typeof makeBackupEnv>) =>
    env.fs.list(env.attachmentsDir).length;
  const countRows = (env: ReturnType<typeof makeBackupEnv>) =>
    Number(env.live().get<{ n: number }>(`SELECT COUNT(*) AS n FROM blobs`)!.n);

  /** أرشيفٌ من جهاز، ثم جهازٌ آخر خالٍ يُستعاد إليه · فيقع النقل فعلاً لا متخطّى */
  async function donorArchiveAndFreshEnv() {
    const donor = makeBackupEnv(mkroot());
    donor.db.run(`INSERT INTO properties (id, name, created_at) VALUES ('P1','عقار المصدر',datetime('now'))`);
    for (const [i, name] of ['صك.pdf', 'عقد.pdf', 'فاتورة.pdf'].entries()) {
      await putAttachment(donor.filesEnv, new Uint8Array(1024 + i).fill(i + 1), {
        entityType: 'property', entityId: 'P1', kind: 'deed', originalName: name, mime: 'application/pdf',
      });
    }
    const archive = path.posix.join(donor.root, 'نسخة.aqbk');
    await createBackup(donor, archive);
    donor.closeLive();
    const env = makeBackupEnv(mkroot()); // خالٍ من المرفقات ومن صفوف blobs
    return { env, archive };
  }

  test('فشلٌ في منتصف نقل المرفقات: تُعاد المنقولة ويتساوى العددان', async () => {
    const { env, archive } = await donorArchiveAndFreshEnv();
    expect(countFiles(env)).toBe(0);
    expect(countRows(env)).toBe(0);
    const plan = await prepareRestore(env, archive);

    let moves = 0;
    const failingFs: FS = {
      ...env.fs,
      rename: (a, b) => {
        if (b.startsWith(env.attachmentsDir) && ++moves === 3) throw new Error('امتلأ القرص');
        env.fs.rename(a, b);
      },
    };
    const env2: BackupEnv = { ...env, get db() { return env.db; }, fs: failingFs, closeLive: env.closeLive, reopenLive: env.reopenLive };
    await expect(commitRestore(env2, plan)).rejects.toThrow();

    // القاعدة رجعت، والملفان اللذان نُقلا رجعا معها · فلا يتيم
    expect(moves).toBeGreaterThan(1);
    expect(countFiles(env)).toBe(countRows(env));
    expect(orphanAttachments(env)).toEqual([]);
    env.closeLive();
  });

  test('فشل الفحص النهائي بعد التبديل: لا مرفق نُقل أصلاً', async () => {
    const { env, archive } = await donorArchiveAndFreshEnv();
    const plan = await prepareRestore(env, archive);
    // الفحص النهائي يسبق النقل · فأيّ فشل فيه لا يترك ملفاً واحداً.
    // والفتح الأول وحده يفشل (القاعدة المبدَّلة) · وفتح الرجوع يعمل كما في الواقع
    let firstOpen = true;
    const env2: BackupEnv = {
      ...env, get db() { return env.db; }, closeLive: env.closeLive,
      reopenLive: () => {
        if (firstOpen) { firstOpen = false; throw new Error('تعذّر فتح القاعدة بعد التبديل'); }
        return env.reopenLive();
      },
    };
    await expect(commitRestore(env2, plan)).rejects.toThrow();
    expect(env.fs.list(env.attachmentsDir)).toHaveLength(0);
    expect(countFiles(env)).toBe(countRows(env));
    env.closeLive();
  });

  test('استعادة ناجحة: كل مرفقات النسخة انتقلت والعددان متساويان', async () => {
    const { env, archive } = await donorArchiveAndFreshEnv();
    const res = await restoreBackup(env, archive);
    expect(res.manifest.files).toHaveLength(3);
    expect(countFiles(env)).toBe(3);
    expect(countFiles(env)).toBe(countRows(env));
    expect(orphanAttachments(env)).toEqual([]);
    env.closeLive();
  });
});

/** لا تبدأ عمليةً لا يسعها القرص · وتُذكر المساحتان في الرسالة */
describe('فحص المساحة قبل البدء', () => {
  test('مساحة أقلّ من ثلاثة أضعاف البيانات: تُمنع الاستعادة قبل كتابة بايت', async () => {
    const { env, archive } = await seededEnvWithBackup();
    const tightFs: FS = { ...env.fs, usableSpace: async () => 1024 };
    const env2: BackupEnv = { ...env, get db() { return env.db; }, fs: tightFs, closeLive: env.closeLive, reopenLive: env.reopenLive };
    await expect(prepareRestore(env2, archive)).rejects.toThrow(/المساحة المتاحة .* ولا تكفي · العملية تحتاج/);
    intactCheck(env);
    env.closeLive();
  });

  test('مساحة كافية: لا تمنع شيئاً', async () => {
    const { env, archive } = await seededEnvWithBackup();
    const plan = await prepareRestore(env, archive);
    expect(plan.manifest.complete).toBe(true);
    env.closeLive();
  });
});
