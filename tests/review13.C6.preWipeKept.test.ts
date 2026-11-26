/**
 * C-6 · متوسط · src/domain/backup/create.ts (makeSafetyBackup: «تبقى الأخيرة وحدها»)
 *
 * السيناريو (بيانات مصطنعة):
 *  ١) «امسح كل البيانات»: تُصنع pre-wipe وفيها كل البيانات، وتُمسح السحابة معها.
 *  ٢) يُدخل المالك عقاراً واحداً، فلم يعد الجهاز فارغاً.
 *  ٣) يستعيد ملفاً مصدَّراً قبل المسح بشهر: commitRestore يصنع pre-restore من الحال الحالية (غير فارغة)، وحلقة الحذف تحذف pre-wipe.
 *  النتيجة: ما أُدخل بين التصدير ويوم المسح ضاع نهائياً، لا في السحابة (مُسحت) ولا على الجهاز.
 *
 * قرار المالك س٢٣ («موافق على التوصيات» 2026-11-13): تبقى آخر نسخة أمانٍ قبل المسح طوال مدة السلة (٣٠ أو ٦٠ أو ٩٠ يوماً من الإعدادات)
 * فلا تحذفها استعادةٌ بعدها، ثم تُحذف · ويقول حوار الاستعادة إنها باقية.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addProperty } from './helpers/fixtures';
import { createBackup, safetyBackupsDir, keptPreWipe, sweepSafetyBackups } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { wipeAllData } from '@/domain/wipe';
import { setSetting } from '@/repos/settings';
import { t } from '@/i18n';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

const DAY = 86400000;
const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, '-');
const backupsOf = (env: ReturnType<typeof makeBackupEnv>) =>
  fs.readdirSync(safetyBackupsDir(env)).filter((n) => n.endsWith('.aqbk')).sort();

/** تصديرٌ قديم، ثم بياناتٌ بعده، ثم المسح (pre-wipe فيها كل شيء)، ثم عقارٌ جديد · يعيد البيئة ومسار التصدير */
async function wipedThenNewData(prefix: string) {
  const d = tempDir(prefix);
  dirs.push(d);
  const env = makeBackupEnv(d);
  addProperty(env.db, { name: 'عقار في التصدير القديم' });
  const exported = path.join(d, 'exported-month-ago.aqbk');
  await createBackup(env, exported);
  addProperty(env.db, { name: 'عقار بعد التصدير وقبل المسح' });
  const wipe = await wipeAllData(env);
  addProperty(env.live(), { name: 'عقار بعد المسح' });
  return { env, exported, wipe: path.basename(wipe) };
}

test('C-6 · استعادةٌ بعد المسح لا تحذف نسخة الأمان قبل المسح ما دامت في مدة السلة', async () => {
  const { env, exported, wipe } = await wipedThenNewData('aq-r13c6-keep-');
  expect(wipe).toMatch(/^pre-wipe-.*\.aqbk$/);
  const plan = await prepareRestore(env, exported);
  await commitRestore(env, plan);
  const names = backupsOf(env);
  // pre-wipe باقية ومعها pre-restore الجديدة
  expect(names).toContain(wipe);
  expect(names.filter((n) => n.startsWith('pre-restore-'))).toHaveLength(1);
  // وفيها ما أُدخل بين التصدير والمسح: تُستعاد منها
  const back = await prepareRestore(env, path.join(safetyBackupsDir(env), wipe));
  await commitRestore(env, back);
  const props = env.live().all<{ name: string }>(`SELECT name FROM properties ORDER BY name`).map((r) => r.name);
  expect(props).toContain('عقار بعد التصدير وقبل المسح');
});

test('C-6 · استعادةٌ ثانية في المدة: تُستبدل pre-restore وتبقى pre-wipe', async () => {
  const { env, exported, wipe } = await wipedThenNewData('aq-r13c6-twice-');
  await commitRestore(env, await prepareRestore(env, exported));
  addProperty(env.live(), { name: 'عقار بين الاستعادتين' });
  await commitRestore(env, await prepareRestore(env, exported));
  const names = backupsOf(env);
  expect(names).toContain(wipe);
  expect(names.filter((n) => n.startsWith('pre-restore-'))).toHaveLength(1);
});

test('C-6 · بعد انقضاء مدة السلة: أول استعادةٍ تحذفها، وكنس الإقلاع يحذفها إن سبقتها نسخةٌ أحدث', async () => {
  const { env, exported, wipe } = await wipedThenNewData('aq-r13c6-expire-');
  setSetting(env.live(), 'trashRetention', 60);
  const dir = safetyBackupsDir(env);
  // نسخة أمانٍ قبل مسحٍ صُنعت قبل ٦١ يوماً (المدة ٦٠): انقضت
  const old = `pre-wipe-${stamp(new Date(Date.now() - 61 * DAY))}.aqbk`;
  fs.renameSync(path.join(dir, wipe), path.join(dir, old));
  expect(keptPreWipe(env)).toBeNull();
  await commitRestore(env, await prepareRestore(env, exported));
  expect(backupsOf(env).filter((n) => n.startsWith('pre-wipe-'))).toEqual([]);

  // وكنس الإقلاع: pre-wipe انقضت مدتها وبعدها pre-restore أحدث ← تُحذف · وفي المدة ← تبقى · والمدة من القاعدة الحية (المستعادة)
  setSetting(env.live(), 'trashRetention', 60);
  const fresh = `pre-wipe-${stamp(new Date(Date.now() - 59 * DAY))}.aqbk`;
  fs.writeFileSync(path.join(dir, fresh), 'نسخة مصطنعة');
  sweepSafetyBackups(env);
  expect(backupsOf(env)).toContain(fresh);
  const kept = keptPreWipe(env)!;
  expect(kept.name).toBe(fresh);
  expect(Date.parse(kept.until) - Date.parse(kept.at)).toBe(60 * DAY);
  sweepSafetyBackups(env, new Date(Date.now() + 2 * DAY));
  expect(backupsOf(env).filter((n) => n.startsWith('pre-wipe-'))).toEqual([]);
});

test('C-6 · pre-wipe الوحيدة تبقى بعد المدة كما كانت (لا نسخة أحدث منها)', async () => {
  const d = tempDir('aq-r13c6-alone-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  addProperty(env.db, { name: 'عقار قبل المسح' });
  const wipe = path.basename(await wipeAllData(env));
  sweepSafetyBackups(env, new Date(Date.now() + 120 * DAY));
  expect(backupsOf(env)).toEqual([wipe]);
});

test('C-6 · حوار الاستعادة يقول إن نسخة ما قبل المسح باقية حتى تاريخها', () => {
  const ar = t('restore.preWipeKept', { lng: 'ar', at: '2026-11-01', until: '2026-12-01' });
  const en = t('restore.preWipeKept', { lng: 'en', at: '2026-11-01', until: '2026-12-01' });
  expect(ar).toContain('2026-12-01');
  expect(ar).not.toBe('restore.preWipeKept');
  expect(en).toContain('2026-12-01');
  expect(en).not.toBe('restore.preWipeKept');
});
