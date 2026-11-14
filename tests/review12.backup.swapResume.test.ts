/**
 * المراجعة ١٢ · R12-BAK-4 · انقطاع الاستعادة بعد التبديل: مرفقات النسخة ما زالت في مجلد التجهيز داخل tmp، والإقلاع يكنس tmp ·
 * finishInterruptedRestore (يُستدعى عند الإقلاع قبل الكنس) ينقلها إلى مجلد المرفقات · بيانات مصطنعة.
 *
 * الاختبار يأخذ لقطة القرص كله لحظة صارت المجهَّزة data.db (كما لو قُتل التطبيق بعدها مباشرةً)، ثم يفتحها كما يفتحها التشغيل التالي.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore, finishInterruptedRestore } from '@/domain/backup/restore';
import { putAttachment } from '@/files/store';
import { nodeFs } from '@/files/nodeFs';
import type { FS } from '@/files/fsAdapter';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
const dir = (p: string) => { const d = tempDir(p); dirs.push(d); return d; };

test('انقطاعٌ بعد التبديل: الإقلاع التالي ينقل مرفقات النسخة من مجلد التجهيز قبل كنسه، وهوية القاعدة هوية هذا الجهاز', async () => {
  const oldPhone = makeBackupEnv(dir('aq-r12-resume-old-'));
  const a = await putAttachment(oldPhone.filesEnv, new Uint8Array([7, 7, 7, 1, 2, 3]), { entityType: 'library', kind: 'other', originalName: 'عقد مصطنع.bin' });
  const archive = path.join(oldPhone.root, 'old.aqbk');
  await createBackup(oldPhone, archive);
  oldPhone.closeLive();

  const newDir = dir('aq-r12-resume-new-');
  const newPhone = makeBackupEnv(newDir);
  const newId = newPhone.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'device_id'`)!.value;
  const plan = await prepareRestore(newPhone, archive);

  // لقطة القرص كله لحظة التبديل
  const crashDir = dir('aq-r12-resume-crash-');
  const watched: FS = {
    ...nodeFs,
    rename: (from, to) => {
      nodeFs.rename(from, to);
      if (from === plan.stagedDbPath && to === newPhone.dbPath) fs.cpSync(newDir, crashDir, { recursive: true });
    },
  };
  await commitRestore({ ...newPhone, fs: watched }, plan);
  newPhone.closeLive();

  // التشغيل التالي على اللقطة: القاعدة المستعادة بهوية هذا الجهاز، والملف في مجلد التجهيز لا في مجلد المرفقات
  const file = `${a.sha256}.${a.ext}`;
  expect(fs.existsSync(path.join(crashDir, 'data.db.pre-restore'))).toBe(true);
  expect(fs.existsSync(path.join(crashDir, 'attachments', file))).toBe(false);
  const booted = makeBackupEnv(crashDir);
  expect(booted.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'device_id'`)!.value).toBe(newId);

  expect(finishInterruptedRestore(booted)).toBe(1);
  expect(fs.existsSync(path.join(crashDir, 'attachments', file))).toBe(true);
  // ومرةً ثانية لا شيء يُنقل
  expect(finishInterruptedRestore(booted)).toBe(0);
  booted.closeLive();
});

test('مجلد تجهيزٍ لم يقع تبديله (المجهَّزة فيه) لا يُمسّ', async () => {
  const src = makeBackupEnv(dir('aq-r12-resume-src-'));
  await putAttachment(src.filesEnv, new Uint8Array([9, 9, 9, 4, 5, 6]), { entityType: 'library', kind: 'other', originalName: 'ملف مصطنع.bin' });
  const archive = path.join(src.root, 's.aqbk');
  await createBackup(src, archive);
  src.closeLive();

  const env = makeBackupEnv(dir('aq-r12-resume-prep-'));
  const plan = await prepareRestore(env, archive);
  fs.writeFileSync(env.dbPath + '.pre-restore', 'سابقة مصطنعة');
  expect(finishInterruptedRestore(env)).toBe(0);
  expect(fs.readdirSync(path.join(plan.stagingDir, 'attachments'))).toHaveLength(1);
  env.closeLive();
});
