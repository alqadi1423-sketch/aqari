/**
 * المراجعة الشاملة 2026-11-13 · C-11 · منخفض · src/files/store.ts (putAttachment) · تتمة اختبار review9.C.lowFindings:
 * «ومثله إن رمت المعاملة بعد الكتابة» · كُتب الملف ثم رُفض تسجيله فبقي في مجلد المرفقات بلا صفٍّ في blobs.
 * قرار المالك 2026-09-02 «لا يبقى بعد أي فشل ملفٌ في attachments بلا صفّ في blobs» · بيانات مصطنعة.
 */
import * as fs from 'node:fs';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { putAttachment } from '@/files/store';
import { orphanAttachments } from '@/domain/backup/create';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

test('C-11 · معاملة التسجيل ترمي بعد كتابة ملفٍ لبصمةٍ جديدة: لا يبقى الملف يتيماً', async () => {
  const d = tempDir('aq-r14c11-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  env.db.exec(`CREATE TRIGGER t_fail_att BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'محاكاة فشل التسجيل'); END`);
  const bytes = new Uint8Array(2048).map((_, i) => (i * 13) & 255);
  await expect(putAttachment(env.filesEnv, bytes, { entityType: 'library', kind: 'other', originalName: 'ملف.pdf' })).rejects.toThrow();
  expect(orphanAttachments(env)).toEqual([]);
  expect(fs.existsSync(env.attachmentsDir) ? fs.readdirSync(env.attachmentsDir) : []).toEqual([]);
  env.closeLive();
});

test('C-11 · بصمةٌ مسجّلة من قبل لا يُحذف ملفها إن فشل تسجيل مرفقٍ ثانٍ لها', async () => {
  const d = tempDir('aq-r14c11b-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  const bytes = new Uint8Array(2048).map((_, i) => (i * 17) & 255);
  const first = await putAttachment(env.filesEnv, bytes, { entityType: 'library', kind: 'other', originalName: 'أول.pdf' });
  env.db.exec(`CREATE TRIGGER t_fail_att BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'محاكاة فشل التسجيل'); END`);
  await expect(putAttachment(env.filesEnv, bytes, { entityType: 'library', kind: 'other', originalName: 'ثان.pdf' })).rejects.toThrow();
  expect(fs.existsSync(`${env.attachmentsDir}/${first.sha256}.${first.ext}`)).toBe(true);
  expect(fs.readdirSync(env.attachmentsDir).filter((n) => n.endsWith('.part'))).toEqual([]);
  env.closeLive();
});
