/**
 * المراجعة ١٢ · مدقق المرحلة ١ المستقل · الاستعادة · C-3 (73a4666) · منخفض
 * src/domain/backup/restore.ts:487 (rename المجهَّزة مكان الحية) ثم :501 (ensureDeviceId بعد إعادة فتحها والفحص النهائي)
 *
 * السيناريو (بيانات مصطنعة): جوالٌ جديد يستعيد نسخةً من الجوال القديم (أكثر ما تُحتاج إليه الاستعادة) · هوية الجهاز في المزامنة
 * (meta.device_id) تخصّ التثبيت لا البيانات، والاستعادة تعيدها إلى القاعدة المستعادة بعد التبديل لا قبله: تُنقل المجهَّزة مكان الحية،
 * ثم تُفتح ويُجرى integrity_check عليها كلها، ثم seed، ثم ensureDeviceId · فإن قُتل التطبيق في هذه الثواني (أندرويد يقتل ما خرج من
 * الواجهة، أو أغلقه المستخدم أثناء «جاري الفحص النهائي») فتح عند التشغيل التالي القاعدة المستعادة بهوية الجوال القديم، ولا شيء عند
 * الإقلاع يعرف أن استعادةً انقطعت (data.db.pre-restore لا يقرؤه إلا الاستعادة التالية) · والمرفقات ما زالت في مجلد التجهيز داخل tmp
 * فيكنسها الإقلاع.
 *
 * لماذا يهم: جهازان بهوية واحدة يحسب كلٌّ منهما كتابة الآخر صداه فيتركها (seed.ts: ensureDeviceId) · فتفترق بيانات الجوالين بصمت ·
 * وقرار المالك 2026-08-20 «الاستعادة عملية ذرّية: تتمّ كاملة أو لا تتمّ إطلاقاً. ولا حالة ثالثة»، والخطة (C-3) طلبت أن يُحكم على
 * القرص بعد كل خطوة، وفُحص الفشل داخل العملية وحده لا ما على القرص لحظة التبديل.
 *
 * السلوك الصحيح: ما يصير data.db بالتبديل يحمل هوية هذا الجهاز من قبلُ (تُكتب في المجهَّزة قبل نقلها كما يُكتب حرف الجهاز وكتل أرقامه
 * في التجهيز · carryDeviceLetter)، فأي انقطاعٍ بعد التبديل لا يترك قاعدةً بهوية جهازٍ آخر.
 * والاختبار يأخذ لقطة القرص لحظة التبديل (كما يفعل upgradeMatrix لانقطاع الهجرة) ويفتحها كما يفتحها التشغيل التالي.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addProperty } from './helpers/fixtures';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { openNodeDb } from '@/db/nodeAdapter';
import { nodeFs } from '@/files/nodeFs';
import type { FS } from '@/files/fsAdapter';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

const deviceIdOf = (file: string): string | null => {
  const db = openNodeDb(file);
  try { return db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'device_id'`)?.value ?? null; } finally { db.close(); }
};

test('لحظة التبديل: القاعدة التي صارت data.db تحمل هوية هذا الجهاز لا هوية الجهاز الذي صنع النسخة', async () => {
  // الجوال القديم: عقارٌ ونسخة
  const oldDir = tempDir('aq-r12-swap-old-');
  dirs.push(oldDir);
  const oldPhone = makeBackupEnv(oldDir);
  addProperty(oldPhone.db, { name: 'عقار مصطنع في النسخة' });
  const oldId = oldPhone.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'device_id'`)!.value;
  const archive = path.join(oldDir, 'old-phone.aqbk');
  await createBackup(oldPhone, archive);
  oldPhone.closeLive();

  // الجوال الجديد يستعيدها
  const newDir = tempDir('aq-r12-swap-new-');
  dirs.push(newDir);
  const newPhone = makeBackupEnv(newDir);
  const newId = newPhone.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'device_id'`)!.value;
  expect(newId).not.toBe(oldId);
  const plan = await prepareRestore(newPhone, archive);

  // لقطة القرص لحظة صارت المجهَّزة data.db (كما لو قُتل التطبيق بعدها مباشرةً)
  const snap = path.join(newDir, 'crash-snapshot.db');
  let snapped = false;
  const watched: FS = {
    ...nodeFs,
    rename: (from, to) => {
      nodeFs.rename(from, to);
      if (from === plan.stagedDbPath && to === newPhone.dbPath) {
        for (const sfx of ['', '-wal']) if (fs.existsSync(to + sfx)) fs.copyFileSync(to + sfx, snap + sfx);
        snapped = true;
      }
    },
  };
  await commitRestore({ ...newPhone, fs: watched }, plan);
  expect(snapped).toBe(true);

  // بعد التمام هوية الجهاز الجديد (السلوك القائم) · ولحظة التبديل كذلك
  expect({ afterCommit: deviceIdOf(newPhone.dbPath), atSwap: deviceIdOf(snap) }).toEqual({ afterCommit: newId, atSwap: newId });
  newPhone.closeLive();
});
