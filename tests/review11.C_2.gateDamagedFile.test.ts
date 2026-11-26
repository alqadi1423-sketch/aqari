/**
 * المدقق المستقل · C-2 (الإصلاح المرحلي) · ملفٌ تالفٌ بالحجم نفسه عند بوابة الترقية.
 *
 * ما يفعله الإصلاح: مع preUpgrade لا يُقرأ الملف، بل يُقرأ حجمه وحده. فملفٌ تغيّر محتواه وبقي حجمه كما هو
 * (تلفٌ في القرص، أو كتابةٌ جزئية فوق ملفٍ بحجمه) يُكتب في local_files ببصمته **المسجَّلة** لا بصمته الفعلية،
 * ولا يُسمّى في missing_files. فلا تعرض البوابة شاشة «missing»، مع أن نصّها نفسه يعِد بتسمية ما «كان تالفاً»
 * (upgrade.missingBody)، ومع أن ادّعاء الإصلاح أن التالف «يُسمّى في missing_files كما كان». وقبل الإصلاح كان يُسمّى
 * (create.ts كان يحسب البصمة ويقارنها، والمخالِف يُسمّى مفقوداً في النسخة المتسامحة).
 *
 * السلوك الصحيح: نسخة ما قبل الترقية تذكر الملف ببصمته الفعلية أو تسمّيه، فالملف التالف يُسمّى في missing_files
 * قبل الترقية (قرار البند ٣ · الخيار أ)، ولا يُذكر في local_files ببصمةٍ ليست له. والحساب ملفاً ملفاً لا يحمل المكتبة
 * في الذاكرة (أكبر مصفوفة = أكبر ملف لا المكتبة)، فلا يخالف قرار المالك س٣ «بلا الملفات نفسها».
 * بيانات مصطنعة · بنية الإصدار ١٦.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { openNodeDb } from '@/db/nodeAdapter';
import { nodeFs, nodeHasher } from '@/files/nodeFs';
import type { DB } from '@/db/adapter';
import type { BackupEnv } from '@/domain/backup/types';
import { verifyArchiveAt } from '@/domain/backup/create';
import { guardedUpgrade } from '@/domain/backup/upgrade';
import { tempDir, rmrf } from './helpers/testDb';
import { schemaAt, fill, ins } from './helpers/oldSchema';

function oldEnv(root: string): BackupEnv & { live(): DB } {
  const dbPath = path.join(root, 'data.db').replace(/\\/g, '/');
  let db = schemaAt(dbPath, 16);
  fill(db);
  return {
    get db() { return db; },
    dbPath, fs: nodeFs, hasher: nodeHasher,
    attachmentsDir: path.join(root, 'attachments').replace(/\\/g, '/'),
    tmpDir: path.join(root, 'tmp').replace(/\\/g, '/'),
    appVersion: '1.0.0-test',
    openDb: (p) => openNodeDb(p),
    closeLive: () => { try { db.close(); } catch { /* مغلقة */ } },
    reopenLive: () => { db = openNodeDb(dbPath); return db; },
    live: () => db,
  };
}

let root: string;
beforeEach(() => { root = tempDir('aqari-r11c2-dmg-'); });
afterEach(() => rmrf(root));

test('C-2 ملفٌ تالف بالحجم نفسه عند البوابة يُسمّى في missing_files ولا يُذكر ببصمةٍ ليست له', async () => {
  const env = oldEnv(root);
  fs.mkdirSync(env.attachmentsDir, { recursive: true });
  const good = new TextEncoder().encode('عقد إيجار مصطنع · سليم');
  const orig = new TextEncoder().encode('صورة هوية مصطنعة · ستتلف');
  const goodSha = await nodeHasher(good);
  const badSha = await nodeHasher(orig);
  for (const [sha, bytes, name] of [[goodSha, good, 'عقد.txt'], [badSha, orig, 'هوية.txt']] as const) {
    fs.writeFileSync(path.join(env.attachmentsDir, `${sha}.txt`), bytes);
    ins(env.db, 'blobs', { sha256: sha, ext: 'txt', size_bytes: bytes.byteLength, created_at: '2026-01-01' });
    ins(env.db, 'attachments', { id: 'A-' + sha.slice(0, 6), sha256: sha, entity_type: 'contract', entity_id: 'C1', kind: 'عقد', original_name: name, created_at: '2026-01-01' });
  }
  // تلفٌ بالحجم نفسه: كل بايت مقلوب
  const damaged = orig.map((b) => b ^ 0xff);
  expect(damaged.byteLength).toBe(orig.byteLength);
  fs.writeFileSync(path.join(env.attachmentsDir, `${badSha}.txt`), damaged);
  expect(await nodeHasher(damaged)).not.toBe(badSha);

  const { backupPath } = await guardedUpgrade(env);
  const { manifest } = await verifyArchiveAt(env, backupPath!);
  // البوابة تعرض شاشة «missing» من missing_files وحدها (UpgradeGate.tsx) · فالتالف يجب أن يكون فيها
  expect(manifest.missing_files).toEqual([`${badSha}.txt`]);
  expect(manifest.complete).toBe(false);
  // وقائمة الملفات ببصماتها لا تذكره ببصمةٍ لا تطابق ما على القرص
  expect((manifest.local_files ?? []).map((f) => f.sha256)).toEqual([goodSha]);
  env.live().close();
});
