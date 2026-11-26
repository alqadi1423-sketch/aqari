/**
 * C-3 · متوسط · src/domain/backup/restore.ts:418 ثم :420 و:430 و:435
 *
 * السيناريو (بيانات مصطنعة): استعادة نسخة فيها مرفق · يتمّ التبديل ونقل المرفقات، ثم يُحذف ملف القاعدة السابقة
 * (data.db.pre-restore · السطر ٤١٨) قبل خطوة reconcileCache (السطر ٤٢٠) · فإن فشلت تلك الخطوة (قرصٌ امتلأ أثناء كتابة file_cache،
 * أو قاعدة مشغولة، أو أي خطأ في نظام الملفات) دخل مسار «الرجوع الفوري»: يحذف القاعدة المستعادة (٤٣٠) ثم يحاول إعادة
 * pre-restore (٤٣٥) وقد حُذفت · فيرمي rename خطأً خاماً ولا يُعاد فتح أي قاعدة.
 * النتيجة: لا ملف قاعدة على الإطلاق · لا القديمة ولا المستعادة. والتطبيق عند الفتح التالي يُنشئ قاعدة فارغة.
 *
 * لماذا يهم: قرار المالك 2026-08-20 «الاستعادة عملية ذرّية: تتمّ كاملة أو لا تتمّ إطلاقاً. ولا حالة ثالثة.» وهذه حالة ثالثة:
 * البيانات لا تُسترجع إلا من نسخة الأمان يدوياً، والرسالة لا تقول ذلك.
 *
 * السلوك الصحيح: ملف القاعدة السابقة لا يُحذف إلا بعد آخر خطوة يمكن أن تفشل (أو تُعدّ reconcileCache خطوةً لا تُسقط الاستعادة) ·
 * وبعد أي فشل يبقى على القرص ملف قاعدة صالح يُفتح: إمّا السابقة كما كانت أو المستعادة كاملة.
 *
 * بعد الإصلاح: العطل يُسلَّح بدخول الخطوة الأخيرة نفسها (reconcileCache) لا بحذف ملف القاعدة السابقة · فالإصلاح أخّر الحذف
 * إلى ما بعدها، والتسليح بالحذف كان لا يبلغها أبداً · وفي الكود القديم الحذفُ يسبقها مباشرةً فالتسليحان سواء.
 * ومعه حقن فشلٍ في كل خطوة بعد إغلاق القاعدة الحية واحدةً واحدة (خطة الإصلاح · C-3).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addProperty } from './helpers/fixtures';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { putAttachment } from '@/files/store';
import { openNodeDb } from '@/db/nodeAdapter';
import { nodeFs } from '@/files/nodeFs';
import * as cloudFiles from '@/files/cloudFiles';
import { RestoreError, type BackupEnv } from '@/domain/backup/types';
import type { FS } from '@/files/fsAdapter';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

test('C-3 فشلٌ في آخر خطوة من التبديل لا يترك الجهاز بلا قاعدة', async () => {
  const d = tempDir('aq-r9c-last-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  addProperty(env.db, { name: 'عقار في النسخة' });
  await putAttachment(env.filesEnv, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { entityType: 'library', kind: 'other', originalName: 'x.bin' });
  const archive = path.join(d, 'b.aqbk');
  await createBackup(env, archive);
  addProperty(env.db, { name: 'عقار بعد النسخة' });

  const plan = await prepareRestore(env, archive);

  // عطلٌ في نظام الملفات في آخر خطوة (مثل امتلاء القرص) · يمسّ فحص وجود المرفق في reconcileCache وحده
  const real = cloudFiles.reconcileCache;
  let lastStep = false;
  const spy = jest.spyOn(cloudFiles, 'reconcileCache').mockImplementation((e) => {
    lastStep = true;
    try { return real(e); } finally { lastStep = false; }
  });
  const faulty = {
    ...nodeFs,
    exists: (p: string) => {
      if (lastStep && p.startsWith(env.attachmentsDir)) throw new Error('ENOSPC: no space left on device (محاكاة)');
      return nodeFs.exists(p);
    },
  };
  const err = await commitRestore({ ...env, fs: faulty }, plan).then(() => null, (e: unknown) => e);
  spy.mockRestore();
  expect(err).not.toBeNull();

  // بعد الفشل: ملف قاعدة صالح على القرص فيه بيانات (السابقة أو المستعادة)
  const dbFileExists = fs.existsSync(env.dbPath);
  let properties = -1;
  if (dbFileExists) {
    const check = openNodeDb(env.dbPath);
    try { properties = Number(check.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)?.n ?? -1); } finally { check.close(); }
  }
  expect({ dbFileExists, hasData: properties > 0 }).toEqual({ dbFileExists: true, hasData: true });
});

test('C-3 وفي الرجوع: إن غابت القاعدة السابقة عن القرص لا تُحذف المستعادة · تبقى مفتوحةً بمرفقها والرسالة لا تدّعي الرجوع', async () => {
  const d = tempDir('aq-r9c-gone-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  addProperty(env.db, { name: 'عقار في النسخة' });
  await putAttachment(env.filesEnv, new Uint8Array([1, 3, 5, 7]), { entityType: 'library', kind: 'other', originalName: 'z.bin' });
  const archive = path.join(d, 'b.aqbk');
  await createBackup(env, archive);
  addProperty(env.db, { name: 'عقار بعد النسخة' });
  const plan = await prepareRestore(env, archive);
  // الخطوة الأخيرة تفشل وقد اختفى ملف القاعدة السابقة (عطلٌ خارجي مصطنع)
  const spy = jest.spyOn(cloudFiles, 'reconcileCache').mockImplementation(() => {
    nodeFs.remove(env.dbPath + '.pre-restore');
    throw new Error('ENOSPC: no space left on device (محاكاة)');
  });
  const err = await commitRestore(env, plan).then(() => null, (e: unknown) => e);
  spy.mockRestore();
  expect(err).toBeInstanceOf(RestoreError);
  expect(String((err as Error).message)).not.toContain('رجعت بياناتك السابقة');
  const live = env.live();
  expect({
    onDisk: fs.existsSync(env.dbPath),
    properties: Number(live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n),
    files: nodeFs.list(env.attachmentsDir).length,
  }).toEqual({ onDisk: true, properties: 1, files: 1 });
  env.closeLive();
});

/**
 * حقن فشلٍ واحد في كل خطوة بعد إغلاق القاعدة الحية، واحدةً واحدة: كل عملية ملفات (نقل القاعدة جانباً، ونقل المجهَّزة مكانها،
 * ومجلد المرفقات، وفحص كل مرفق ونقله، والخطوة الأخيرة، والحذف والتنظيف)، وفتحُ المستعادة، وكتابةٌ فيها تفشل.
 * الحكم في كل حالة: ملف قاعدة صالح على القرص، والقاعدة الحية مفتوحة · فإن رُفض التنفيذ فبرسالة الاستعادة وبالبيانات السابقة
 * كما كانت بلا مرفقٍ يتيم، وإن تمّ فبالمستعادة كاملةً بمرفقها.
 */
test('C-3 فشلٌ واحد في أي خطوة بعد إغلاق القاعدة الحية: إمّا السابقة كما كانت وإمّا المستعادة كاملة', async () => {
  // نسخةٌ من جهازٍ آخر فيها عقار ومرفق · والجهاز المستعاد عليه فيه عقاران ولا مرفق، فيُنقل المرفق فعلاً
  const donorDir = tempDir('aq-r9c-sweep-donor-');
  dirs.push(donorDir);
  const donor = makeBackupEnv(donorDir);
  addProperty(donor.db, { name: 'عقار في النسخة' });
  await putAttachment(donor.filesEnv, new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]), { entityType: 'library', kind: 'other', originalName: 'y.bin' });
  const archive = path.join(donorDir, 'b.aqbk');
  await createBackup(donor, archive);
  donor.closeLive();

  type Fault = { op: number } | { reopen: 'open' | 'write' };
  const ops: string[] = [];
  async function attempt(fault: Fault | null) {
    const d = tempDir('aq-r9c-sweep-');
    dirs.push(d);
    const dst = makeBackupEnv(d);
    addProperty(dst.db, { name: 'عقار قبل الاستعادة ١' });
    addProperty(dst.db, { name: 'عقار قبل الاستعادة ٢' });
    const plan = await prepareRestore(dst, archive);
    let swapping = false;
    let n = 0;
    let reopened = 0;
    const step = (name: string, p: string) => {
      if (!swapping) return;
      n += 1;
      if (!fault) ops.push(name + ' ' + path.basename(p));
      if (fault && 'op' in fault && fault.op === n) throw new Error('عطل مصطنع في ' + name + ' ' + path.basename(p));
    };
    const fs2: FS = {
      ...nodeFs,
      read: (p) => { step('read', p); return nodeFs.read(p); },
      write: (p, b) => { step('write', p); nodeFs.write(p, b); },
      exists: (p) => { step('exists', p); return nodeFs.exists(p); },
      remove: (p) => { step('remove', p); nodeFs.remove(p); },
      mkdirp: (p) => { step('mkdirp', p); nodeFs.mkdirp(p); },
      list: (p) => { step('list', p); return nodeFs.list(p); },
      rename: (a, b) => { step('rename', a); nodeFs.rename(a, b); },
    };
    const failingWrites = (db: DB): DB => new Proxy(db, {
      get: (t, k) => (k === 'run' ? () => { throw new Error('SQLITE_FULL مصطنع'); } : Reflect.get(t, k)),
    });
    const env: BackupEnv = {
      ...dst, fs: fs2, get db() { return dst.live(); },
      closeLive: () => { swapping = true; dst.closeLive(); },
      reopenLive: () => {
        reopened += 1;
        if (fault && 'reopen' in fault && reopened === 1) {
          if (fault.reopen === 'open') throw new Error('تعذّر فتح المستعادة (مصطنع)');
          return failingWrites(dst.reopenLive());
        }
        return dst.reopenLive();
      },
    };
    const err = await commitRestore(env, plan).then(() => null, (e: unknown) => e);
    // الحكم من القرص ومن القاعدة الحية معاً
    const onDisk = fs.existsSync(dst.dbPath);
    let diskProps = -1;
    if (onDisk) {
      const check = openNodeDb(dst.dbPath);
      try { diskProps = Number(check.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n); } finally { check.close(); }
    }
    const live = dst.live();
    const ic = live.get<Record<string, string>>(`PRAGMA integrity_check`)!;
    const files = nodeFs.list(dst.attachmentsDir).length;
    const out = {
      fault: JSON.stringify(fault), failed: err !== null, restoreError: err === null || err instanceof RestoreError,
      onDisk, diskProps, liveProps: Number(live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n),
      integrity: String(Object.values(ic)[0]), files,
    };
    dst.closeLive();
    return out;
  }

  // تشغيلٌ سليم يعدّ العمليات بعد الإغلاق · ثم عطلٌ في كل واحدة منها وحدها
  const clean = await attempt(null);
  expect(clean).toEqual(expect.objectContaining({ failed: false, diskProps: 1, liveProps: 1, files: 1 }));
  expect(ops).toEqual(expect.arrayContaining(['rename data.db', 'rename data.db', 'mkdirp attachments', 'remove data.db.pre-restore']));
  const faults: Fault[] = [...ops.map((_, i) => ({ op: i + 1 })), { reopen: 'open' }, { reopen: 'write' }];
  for (const fault of faults) {
    const r = await attempt(fault);
    // المرفوض: البيانات السابقة كما كانت (عقاران) بلا مرفقٍ يتيم · والتامّ: المستعادة (عقار) بمرفقها
    const expected = r.failed ? { diskProps: 2, liveProps: 2, files: 0 } : { diskProps: 1, liveProps: 1, files: 1 };
    expect(r).toEqual({ ...r, onDisk: true, integrity: 'ok', restoreError: true, ...expected });
  }
});
