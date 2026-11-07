/**
 * التوجيه الرابع ٤ · ٣ ومعه بندا القرارات المعلّقة (قرار المالك 2026-11-07 «نغلقها» بالخيار أ):
 *  - البند ١٧: زر «استعادة» القائم يعرض نسخ هذا الجهاز كلها (الأمان وما قبل الترقية) بتاريخ كلٍّ ونوعها، والأحدث بوقته لا بحروف اسمه،
 *    ولا يُقرأ ملفٌ خارج مجلد النسخ باسمٍ مصنوع.
 *  - البند ٣: نسخة ما قبل الترقية تكمل حين يُفقد مرفق، ويُسمّى المفقود للمستخدم باسمه قبل الترقية · بيانات مصطنعة.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { openNodeDb } from '@/db/nodeAdapter';
import { nodeFs, nodeHasher } from '@/files/nodeFs';
import type { DB } from '@/db/adapter';
import type { BackupEnv } from '@/domain/backup/types';
import { verifyArchiveAt, safetyBackupsDir, missingFileLabels } from '@/domain/backup/create';
import { makePreUpgradeBackup } from '@/domain/backup/upgrade';
import { parseDeviceBackupName, deviceBackups, deviceBackupPath } from '@/domain/backup/deviceBackups';
import { tempDir, rmrf } from './helpers/testDb';
import { schemaAt, fill, ins } from './helpers/oldSchema';

function oldEnv(root: string, v: number): BackupEnv & { live(): DB } {
  const dbPath = path.join(root, 'data.db').replace(/\\/g, '/');
  let db = schemaAt(dbPath, v);
  fill(db);
  return {
    get db() { return db; },
    dbPath,
    fs: nodeFs,
    hasher: nodeHasher,
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
beforeEach(() => { root = tempDir('aqari-devbk-'); });
afterEach(() => rmrf(root));

const put = (env: BackupEnv, name: string) => {
  const dir = safetyBackupsDir(env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), 'x');
};

describe('البند ١٧ · نسخ هذا الجهاز', () => {
  test('الاسم يحمل النوع والوقت وإصدار البنية · وما لا يطابق الشكل لا يُعدّ نسخة', () => {
    expect(parseDeviceBackupName('pre-upgrade-2026-11-07T08-05-09-120Z-v16.aqbk'))
      .toEqual({ name: 'pre-upgrade-2026-11-07T08-05-09-120Z-v16.aqbk', kind: 'pre-upgrade', at: '2026-11-07T08:05:09.120Z', fromSchema: 16 });
    expect(parseDeviceBackupName('pre-wipe-2026-11-07T08-05-09-120Z.aqbk')?.kind).toBe('pre-wipe');
    expect(parseDeviceBackupName('pre-restore-2026-11-07T08-05-09-120Z.aqbk')?.kind).toBe('pre-restore');
    for (const bad of ['../data.db', 'pre-wipe-x.aqbk', 'notes.aqbk', 'pre-wipe-2026-11-07T08-05-09-120Z.aqbk.tmp', 'pre-upgrade-2026-13-40T99-99-99-999Z-v3.aqbk']) {
      expect(parseDeviceBackupName(bad)).toBeNull();
    }
  });

  test('الأحدث أولاً بوقته · فنسخة أمانٍ قبل استعادةٍ أحدث تسبق «pre-wipe» الأقدم، ونسخ الترقية معها', () => {
    const env = oldEnv(root, 16);
    put(env, 'pre-wipe-2026-11-07T10-00-00-000Z.aqbk');
    put(env, 'pre-restore-2026-11-07T11-00-00-000Z.aqbk');
    put(env, 'pre-upgrade-2026-11-07T09-00-00-000Z-v16.aqbk');
    put(env, 'pre-upgrade-2026-11-06T09-00-00-000Z-v15.aqbk');
    put(env, 'ملف غريب.txt');
    expect(deviceBackups(env).map((b) => b.kind + '@' + b.at.slice(0, 13))).toEqual([
      'pre-restore@2026-11-07T11', 'pre-wipe@2026-11-07T10', 'pre-upgrade@2026-11-07T09', 'pre-upgrade@2026-11-06T09',
    ]);
    // بلا اسمٍ: الأحدث بوقته (كان الترتيب بحروف الاسم يختار «pre-wipe» الأقدم)
    expect(path.basename(deviceBackupPath(env)!)).toBe('pre-restore-2026-11-07T11-00-00-000Z.aqbk');
    expect(path.basename(deviceBackupPath(env, 'pre-upgrade-2026-11-06T09-00-00-000Z-v15.aqbk')!)).toBe('pre-upgrade-2026-11-06T09-00-00-000Z-v15.aqbk');
    env.live().close();
  });

  test('اسمٌ ليس في القائمة يُرفض ولا يُقرأ ملفٌ خارج المجلد · ولا نسخ فـnull', () => {
    const env = oldEnv(root, 16);
    expect(deviceBackupPath(env)).toBeNull();
    put(env, 'pre-wipe-2026-11-07T10-00-00-000Z.aqbk');
    expect(() => deviceBackupPath(env, '../data.db')).toThrow(/لم تعد على هذا الجهاز/);
    expect(() => deviceBackupPath(env, 'pre-wipe-2026-11-01T10-00-00-000Z.aqbk')).toThrow(/لم تعد على هذا الجهاز/);
    env.live().close();
  });

  test('نسخة ما قبل الترقية الحقيقية تظهر في القائمة بنوعها وإصدارها، وتُفتح بالتحقق الكامل', async () => {
    const env = oldEnv(root, 16);
    await makePreUpgradeBackup(env);
    const [b] = deviceBackups(env);
    expect(b.kind).toBe('pre-upgrade');
    expect(b.fromSchema).toBe(16);
    const { manifest } = await verifyArchiveAt(env, deviceBackupPath(env, b.name)!);
    expect(manifest.schema_version).toBe(16);
    env.live().close();
  });
});

describe('البند ٣ · المفقود يُسمّى باسمه قبل الترقية', () => {
  test('مرفقٌ حُذف ملفه: النسخة تكمل، واسمه الذي يعرفه المستخدم يُعرض · وبلا اسمٍ أول البصمة', async () => {
    const env = oldEnv(root, 16);
    const bytes = new TextEncoder().encode('مرفق مصطنع سيُحذف من القرص');
    const sha = await nodeHasher(bytes);
    fs.mkdirSync(env.attachmentsDir, { recursive: true });
    ins(env.db, 'blobs', { sha256: sha, ext: 'txt', size_bytes: bytes.byteLength, created_at: '2026-01-01' });
    ins(env.db, 'attachments', { id: 'A1', sha256: sha, entity_type: 'contract', entity_id: 'C1', kind: 'عقد', original_name: 'صورة العقد.txt', created_at: '2026-01-01' });
    const { manifest } = await makePreUpgradeBackup(env);
    expect(manifest.missing_files).toEqual([`${sha}.txt`]);
    expect(missingFileLabels(env.db, manifest.missing_files)).toEqual(['صورة العقد.txt']);
    expect(missingFileLabels(env.db, ['f'.repeat(64) + '.pdf'])).toEqual(['ffffffffffff.pdf']);
    env.live().close();
  });

  test('البوابة تعرض الأسماء ولا تُرقّي قبل «متابعة»', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/ui/UpgradeGate.tsx'), 'utf8');
    expect(src).toMatch(/if \(lost\.length\) \{[\s\S]*?missingFileLabels\(rawAppDb\(\), lost\)[\s\S]*?setPhase\('missing'\);\s*return;\s*\}\s*finish\(\);/);
    expect(src).toMatch(/<Btn primary title=\{t\('upgrade\.continue'\)\} onPress=\{finish\} \/>/);
    // clearUpgrade (إذن الهجرة) في finish وحدها
    expect(src.match(/clearUpgrade\(\)/g)).toHaveLength(1);
  });

  test('زر «استعادة» القائم يعرض القائمة حين تكون أكثر من نسخة، ويستعيد المختارة باسمها', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app/settings.tsx'), 'utf8');
    expect(src).toMatch(/if \(list\.length > 1\) \{ setDeviceList\(list\); return; \}/);
    expect(src).toMatch(/prepareRestoreFromSafety\(db, setProgress, opts, name\)/);
    expect(src).toMatch(/onPress=\{doRestoreSafety\}/);
  });
});
