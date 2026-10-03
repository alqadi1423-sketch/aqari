/**
 * قاعدة فيها بيانات بلا علامة الزرع ولا هوية جهاز (نسخة مولَّدة خارج التطبيق مثلاً):
 *  - الزرع يأخذ ما ينقصها من حسابات النظام والإعدادات ولا يمسّ ما فيها · وكان يرمي UNIQUE فلا يفتح التطبيق.
 *  - هوية الجهاز تخصّ التثبيت لا البيانات: لا تأتي مع نسخة مستعادة، وتُنشأ إن غابت.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import { memDb, tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { migrate, currentSchemaVersion } from '@/db/migrations';
import { MIGRATIONS, SCHEMA_VERSION } from '@/db/schema';
import { seed, isSeeded, SEED_ACCOUNTS, MIGRATED_SYSTEM_ACCOUNTS } from '@/db/seed';
import { createBackup, tableCounts } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { nodeHasher } from '@/files/nodeFs';
import { getMeta } from '@/repos/settings';

const dirs: string[] = [];
const newDir = () => { const d = tempDir('aq-seedid-'); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmrf(d); });

/** أرشيف صحيح البنية والبصمات · قاعدته بلا علامة زرع ولا هوية جهاز وتنقصها حسابات نظام */
async function bareArchive(): Promise<string> {
  const src = makeBackupEnv(newDir());
  const base = path.join(src.root, 'base.aqbk');
  await createBackup(src, base);
  src.db.run(`DELETE FROM meta WHERE key IN ('seeded', 'device_id')`);
  src.db.run(`DELETE FROM accounts WHERE code IN ('2410', '5900', '4900')`);
  const counts = tableCounts(src.db);
  src.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  src.closeLive();
  const bytes = new Uint8Array(fs.readFileSync(src.dbPath));
  const entries: Record<string, Uint8Array> = unzipSync(new Uint8Array(fs.readFileSync(base)));
  const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  manifest.db_sha256 = await nodeHasher(bytes);
  manifest.table_counts = counts;
  manifest.device_id = '';
  entries['data.db'] = bytes;
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
  const out = path.join(src.root, 'bare.aqbk');
  fs.writeFileSync(out, zipSync(entries));
  return out;
}

test('الزرع على قاعدة فيها بيانات بلا علامته: يأخذ ما ينقص ولا يمسّ ما فيها · وكان يرمي UNIQUE', () => {
  const db = memDb();
  db.run(`UPDATE accounts SET name = 'النقدية والبنوك' WHERE code = '1100'`);
  db.run(`DELETE FROM accounts WHERE code IN ('2410', '5900', '1400', '4900')`);
  db.run(`DELETE FROM meta WHERE key IN ('seeded', 'device_id')`);
  expect(() => seed(db)).not.toThrow();
  expect(db.get<{ name: string }>(`SELECT name FROM accounts WHERE code = '1100'`)!.name).toBe('النقدية والبنوك');
  for (const code of ['2410', '5900', '1400', '4900']) expect(db.get(`SELECT code FROM accounts WHERE code = ?`, [code])).toBeTruthy();
  expect(db.get(`SELECT name, type FROM accounts WHERE code = '4900'`)).toEqual({ name: 'خصومات ممنوحة', type: 'مصروف' });
  expect(isSeeded(db)).toBe(true);
  expect(getMeta(db, 'device_id')).toMatch(/^b[0-9a-z]{10}$/);
  db.close();
});

test('استعادة نسخة بلا علامة زرع ولا هوية: هوية هذا الجهاز تبقى له · وحسابات النظام تكتمل · والتشغيل التالي لا ينهار', async () => {
  const archive = await bareArchive();
  const target = makeBackupEnv(newDir());
  const mine = getMeta(target.db, 'device_id');
  expect(mine).toBeTruthy();
  const plan = await prepareRestore(target, archive);
  const res = await commitRestore(target, plan);
  const db = res.db;
  expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(getMeta(db, 'device_id')).toBe(mine);
  expect(isSeeded(db)).toBe(true);
  for (const code of ['2410', '5900', '4900']) expect(db.get(`SELECT code FROM accounts WHERE code = ?`, [code])).toBeTruthy();
  expect(() => { migrate(db); seed(db); }).not.toThrow();
  target.closeLive();
});

test('حسابات النظام في الزرع تطابق ما تضيفه الهجرات حرفاً · ومنها 4900 «خصومات ممنوحة» بنوع مصروف', () => {
  const sql = MIGRATIONS.join('\n');
  const fromMigrations = [...sql.matchAll(/INSERT OR IGNORE INTO accounts \(code, name, type, grp, opening_halalas, is_system, created_at\)\s*VALUES \('(\d+)', '([^']+)', '([^']+)', (NULL|'[^']+'), 0, 1/g)]
    .map((x) => ({ code: x[1], name: x[2], type: x[3], grp: x[4] === 'NULL' ? null : x[4].slice(1, -1) }));
  expect(fromMigrations.map((a) => a.code)).toContain('4900');
  const listed = new Map(MIGRATED_SYSTEM_ACCOUNTS.map((a) => [a.code, a]));
  for (const a of fromMigrations) {
    if (SEED_ACCOUNTS.some((s) => s.code === a.code)) continue;
    expect(listed.get(a.code)).toEqual(a);
  }
  expect(listed.get('4900')).toEqual({ code: '4900', name: 'خصومات ممنوحة', type: 'مصروف', grp: null });
});

test('أجهزة تُزرع في اللحظة نفسها تأخذ هويات مختلفة · وكانت تأخذ هوية واحدة من ساعة الإنشاء', () => {
  const dbs = Array.from({ length: 20 }, () => memDb());
  const ids = dbs.map((d) => getMeta(d, 'device_id'));
  expect(new Set(ids).size).toBe(20);
  for (const d of dbs) d.close();
});
