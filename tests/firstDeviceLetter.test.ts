/**
 * أول جهاز على الحساب يبقى بلا حرف في الترقيم (طلب المالك ٢٠٢٦-١٠-٠٤) · ولو استعاد نسخةً من التطبيق القديم
 * (لا حرف فيها ولا تسجيل) قبل الدخول أو بعده · ونسخةٌ تحمل حرف جهاز آخر لا تنقله · بيانات مصطنعة.
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty } from './helpers/fixtures';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { enableSync, syncOnce } from '@/sync/engine';
import { deviceLetter, deviceLetterAssigned, setDeviceLetter } from '@/domain/numbering';
import { nextJournalNo } from '@/domain/accounting/post';
import { getMeta } from '@/repos/settings';

const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-letter-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });
const UID = 'U';

/** نسخة كالتي يصنعها التطبيق القديم: بيانات بلا تسجيل جهاز ولا حرف */
async function oldAppBackup(): Promise<string> {
  const old = newEnv();
  addProperty(old.db, { name: 'عقار من التطبيق القديم' });
  expect(deviceLetterAssigned(old.db)).toBe(false);
  const file = path.join(old.root, 'old-app.aqbk');
  await createBackup(old, file);
  old.closeLive();
  return file;
}
const sync = (env: TestBackupEnv, r: MemoryRemote) => syncOnce(env.db, r, getMeta(env.db, 'device_id')!);

test('استعادة نسخة التطبيق القديم قبل الدخول · ثم الدخول: الجهاز الأول بلا حرف، والثاني B', async () => {
  const r = new MemoryRemote();
  const phone = newEnv();
  const plan = await prepareRestore(phone, await oldAppBackup());
  const db = (await commitRestore(phone, plan)).db;
  expect(deviceLetterAssigned(db)).toBe(false);
  enableSync(db, UID);
  await sync(phone, r);
  expect(deviceLetterAssigned(db)).toBe(true);
  expect(deviceLetter(db)).toBe('');
  expect(nextJournalNo(db)).toMatch(/^JE-\d{4}$/);
  // جهاز ثانٍ على الحساب
  const second = newEnv();
  enableSync(second.db, UID);
  await sync(second, r);
  expect(deviceLetter(second.db)).toBe('B');
  phone.closeLive(); second.closeLive();
});

test('الدخول أولاً ثم استعادة نسخة التطبيق القديم: يبقى بلا حرف ولا يُعاد تسجيله', async () => {
  const r = new MemoryRemote();
  const phone = newEnv();
  enableSync(phone.db, UID);
  await sync(phone, r);
  expect(deviceLetter(phone.db)).toBe('');
  const plan = await prepareRestore(phone, await oldAppBackup());
  const db = (await commitRestore(phone, plan)).db;
  expect(deviceLetterAssigned(db)).toBe(true);
  expect(deviceLetter(db)).toBe('');
  expect(Object.values(r.letters)).toEqual(['']);
  phone.closeLive();
});

test('نسخةٌ من جهاز آخر بحرف B لا تنقل حرفها إلى جهاز لم يُسجَّل بعد', async () => {
  const other = newEnv();
  setDeviceLetter(other.db, 'B');
  const file = path.join(other.root, 'b.aqbk');
  await createBackup(other, file);
  other.closeLive();
  const phone = newEnv();
  const db = (await commitRestore(phone, await prepareRestore(phone, file))).db;
  expect(deviceLetterAssigned(db)).toBe(false);
  phone.closeLive();
});
