/**
 * تحقق الدمج ف٦: المحادثة كاتبٌ متزامن جديد (سحب كل ثوانٍ والشاشة مفتوحة) · كتابةٌ تقع أثناء النسخ
 * بين عدّ الصفوف ولقطة القاعدة كانت تُفشل التحقق بـ«عدد صفوف … لا يطابق البيان» · العدّ واللقطة الآن بلا انتظار بينهما.
 * بيانات مصطنعة.
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { createBackup, verifyArchiveAt } from '@/domain/backup/create';

let dir: string;
beforeAll(() => { dir = tempDir('aqari-bk-conc-'); });
afterAll(() => rmrf(dir));

test('رسائل محادثة تصل أثناء النسخ لا تُفشل النسخة ولا تحققها', async () => {
  const env = makeBackupEnv(dir);
  env.db.run(`INSERT INTO chat_threads (id,kind,members,created_by) VALUES ('d_u-a_u-b','direct','["u-a","u-b"]','u-a')`);
  let n = 0;
  // كاتبٌ متزامن كسحب المحادثة: رسالة كل دورة مؤقّت طوال النسخ
  const timer = setInterval(() => {
    n++;
    env.db.run(`INSERT INTO chat_messages (id,thread_id,sender,body,local_at,sent) VALUES (?,?,?,?,?,1)`,
      ['m' + n, 'd_u-a_u-b', 'u-b', 'رسالة مصطنعة ' + n, new Date().toISOString()]);
  }, 0);
  try {
    const out = path.join(dir, 'conc.aqbk');
    const manifest = await createBackup(env, out);
    expect(n).toBeGreaterThan(0);
    await verifyArchiveAt(env, out);
    // البيان يعدّ ما في اللقطة نفسها
    expect(manifest.table_counts.chat_messages).toBeLessThanOrEqual(n);
  } finally {
    clearInterval(timer);
  }
});
