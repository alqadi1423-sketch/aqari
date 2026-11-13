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

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

test.failing('C-3 فشلٌ في آخر خطوة من التبديل لا يترك الجهاز بلا قاعدة', async () => {
  const d = tempDir('aq-r9c-last-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  addProperty(env.db, { name: 'عقار في النسخة' });
  await putAttachment(env.filesEnv, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { entityType: 'library', kind: 'other', originalName: 'x.bin' });
  const archive = path.join(d, 'b.aqbk');
  await createBackup(env, archive);
  addProperty(env.db, { name: 'عقار بعد النسخة' });

  const plan = await prepareRestore(env, archive);

  // عطلٌ في نظام الملفات بعد حذف القاعدة السابقة (مثل امتلاء القرص) · يمسّ فحص وجود المرفق في reconcileCache وحده
  let preSwapGone = false;
  const faulty = {
    ...nodeFs,
    remove: (p: string) => { if (p.endsWith('.pre-restore')) preSwapGone = true; nodeFs.remove(p); },
    exists: (p: string) => {
      if (preSwapGone && p.startsWith(env.attachmentsDir)) throw new Error('ENOSPC: no space left on device (محاكاة)');
      return nodeFs.exists(p);
    },
  };
  const err = await commitRestore({ ...env, fs: faulty }, plan).then(() => null, (e: unknown) => e);
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
