/**
 * المراجعة الشاملة 2026-11-13 · C-8 · منخفض · src/db/migrations.ts (fk_violations_after_migrate) · src/domain/backup/restore.ts
 *
 * ما يحدث (بيانات مصطنعة):
 *  - migrate يعدّ مخالفات PRAGMA foreign_key_check ويكتبها في meta.fk_violations_after_migrate ولا يقرؤها أحد: لا فحص المطابقة ولا
 *    تقرير العطل.
 *  - الاستعادة تفحص integrity_check وحده، فارتباطٌ مكسور في النسخة يمرّ صامتاً ويظهر بعدها «FOREIGN KEY constraint failed» بالإنجليزية.
 *  - ولا تفحص manifest.format_version: نسخةٌ بصيغة أحدث تُقرأ بالصيغة الأولى.
 *
 * الإصلاح (التوصية، «موافق على التوصيات» 2026-11-13): العدد في «فحص المطابقة» وفي تقرير العطل · وملاحظةٌ بعدده في تجهيز الاستعادة
 * كالفروق المحاسبية · و format_version أحدث من التطبيق يُرفض بأدب كما يُرفض schema_version الأحدث.
 * وقرار 2026-09-09 «أصلح القيد، ولا تُخفِ الخطأ».
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { tempDir, rmrf, memDb } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import type { DB } from '@/db/adapter';
import { migrate } from '@/db/migrations';
import { schemaAt } from './helpers/oldSchema';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, abortRestore } from '@/domain/backup/restore';
import { RestoreError } from '@/domain/backup/types';
import { fkIntegrityCheck } from '@/domain/fkCheck';
import { recordCrashReport, crashReports } from '@/domain/crashReport';
import { t } from '@/i18n';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

/** صفٌّ ابنٌ لعقارٍ لا وجود له · كما تتركه هجرةٌ بفحصٍ معطّل */
function breakLink(db: DB) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.run(`INSERT INTO property_floor_categories (property_id, floor_label, category) VALUES ('no-such-property', 'الأرضي', 'سكني')`);
  db.exec('PRAGMA foreign_keys = ON');
}

test('C-8 · فحص المطابقة يعدّ الارتباطات المكسورة', () => {
  const db = memDb();
  const ok = fkIntegrityCheck(db);
  expect(ok.ok).toBe(true);
  expect(ok.name).toBe(t('fk.integrityName'));
  breakLink(db);
  const bad = fkIntegrityCheck(db);
  expect(bad.ok).toBe(false);
  expect(bad.value).toBe(t('fk.integrityValue', { n: 1 }));
  db.close();
  const screen = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'integrity.tsx'), 'utf8');
  expect(screen).toMatch(/fkIntegrityCheck\(db\)/);
});

test('C-8 · تقرير العطل يحمل عدد المخالفات بعد آخر ترقية', () => {
  const d = tempDir('aq-r14c8-crash-');
  dirs.push(d);
  const db = schemaAt(path.join(d, 'v45.db'), 45);
  db.exec('PRAGMA foreign_keys = OFF');
  db.run(`INSERT INTO property_floor_categories (property_id, floor_label, category) VALUES ('no-such-property', 'الأرضي', 'سكني')`);
  migrate(db);
  expect(db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'fk_violations_after_migrate'`)?.value).toBe('1');
  expect(recordCrashReport(db, { where: 'اختبار', e: new Error('boom'), platform: 'android' })).toBe(true);
  const [r] = crashReports(db);
  expect(r.stack).toContain('fk_violations_after_migrate=1');
  db.close();
});

test('C-8 · تجهيز الاستعادة يذكر الارتباطات المكسورة في النسخة ملاحظةً كالفروق المحاسبية', async () => {
  const d = tempDir('aq-r14c8-restore-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  breakLink(env.db);
  const archive = path.join(d, 'broken.aqbk');
  await createBackup(env, archive);
  const plan = await prepareRestore(env, archive);
  expect(plan.notes).toContain(t('fk.restoreNote', { n: 1 }));
  abortRestore(env, plan.stagingDir);
  env.closeLive();
});

test('C-8 · نسخةٌ بصيغة أحدث من التطبيق تُرفض بأدب', async () => {
  const d = tempDir('aq-r14c8-format-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  const archive = path.join(d, 'ok.aqbk');
  await createBackup(env, archive);
  const entries = unzipSync(env.fs.read(archive));
  const m = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  m.format_version = 2;
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(m));
  const newer = path.join(d, 'newer.aqbk');
  env.fs.write(newer, zipSync(entries));
  const err = await prepareRestore(env, newer).catch((e: Error) => e);
  expect(err).toBeInstanceOf(RestoreError);
  expect((err as Error).message).toContain(t('restore.newerFormat', { found: 2, supported: 1 }));
  // ولم يبقَ من التجهيز شيء
  expect(fs.existsSync(env.tmpDir) ? fs.readdirSync(env.tmpDir).filter((n) => n.startsWith('restore-staging')) : []).toEqual([]);
  env.closeLive();
});
