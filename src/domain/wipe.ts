/**
 * «امسح كل البيانات» (توجيه المالك ٢٠٢٦-١٠-٠٤): بعده يكون التطبيق كأنه مثبَّت جديداً في كل شاشة وتقرير ·
 * لا حركات ولا أرقام ولا دفعات ولا أسماء. فالمسح لا يعكس القيود ولا ينقل إلى السلة (ما يبقى في السلة يبقى
 * أثره في الدفتر)، بل:
 *  ١) نسخة أمان إلزامية في مجلد النسخ الدائم · فشلُها يلغي المسح قبل أن يُمسّ شيء، وهي طريق الاسترجاع.
 *  ٢) القاعدة تُغلق ويُحذف ملفها والمرفقات، ثم تُفتح قاعدة جديدة بالهجرات والزرع.
 *  ٣) يبقى ما يخص الجهاز والحساب وحده: هوية الجهاز وحرفه، والحساب والمنشأة وعهد المسح.
 * والسحابة تُمسح قبله بمسار المنشأة (services/org.ts wipeOrgCloud) فلا يرجع شيء على جهاز آخر أو تثبيت جديد.
 */
import { makeSafetyBackup, ensureFreeSpace } from './backup/create';
import { logAudit } from './audit';
import type { BackupEnv } from './backup/types';
import { migrate } from '../db/migrations';
import { seed } from '../db/seed';

/** ما يبقى بعد المسح: هوية الجهاز في meta، والحساب والمنشأة في sync_state */
const KEEP_META = ['device_id', 'device_letter'];
const KEEP_SYNC = ['uid', 'email', 'org', 'org_name', 'membership', 'wipe_epoch'];

/**
 * يعيد مسار نسخة الأمان بعد نجاح المسح · وأي فشل في النسخة يوقف كل شيء والبيانات كما هي.
 * قاعدة الجهاز بعدها جديدة: الاستدعاء يعيد قراءة env.db (القاعدة الحية تبدّلت).
 */
export async function wipeAllData(env: BackupEnv, onProgress?: (msg: string) => void, madeSafety?: string, reason?: string): Promise<string> {
  let safetyPath = madeSafety ?? '';
  if (!safetyPath) {
    await ensureFreeSpace(env); // القرص يسع النسخة · وإلا فلا يبدأ المسح أصلاً
    safetyPath = await makeSafetyBackup(env, 'pre-wipe', onProgress);
  }

  onProgress?.('جاري مسح البيانات');
  const old = env.db;
  const meta = old.all<{ key: string; value: string }>(
    `SELECT key, value FROM meta WHERE key IN (${KEEP_META.map(() => '?').join(',')})`, KEEP_META);
  const hasSync = !!old.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'`);
  const sync = hasSync ? old.all<{ k: string; v: string | null }>(
    `SELECT k, v FROM sync_state WHERE k IN (${KEEP_SYNC.map(() => '?').join(',')})`, KEEP_SYNC) : [];
  const capture = hasSync ? Number(old.get<{ v: number }>(`SELECT v FROM sync_ctl WHERE k = 'capture'`)?.v ?? 0) : 0;

  env.closeLive();
  for (const s of ['', '-wal', '-shm']) {
    try { if (env.fs.exists(env.dbPath + s)) env.fs.remove(env.dbPath + s); } catch { /* التالي */ }
  }
  try { if (env.fs.exists(env.attachmentsDir)) env.fs.remove(env.attachmentsDir); } catch { /* يكنسه الإقلاع */ }
  const db = env.reopenLive();
  migrate(db);
  seed(db);
  db.transaction(() => {
    for (const m of meta) db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [m.key, m.value]);
    for (const r of sync) db.run(`INSERT INTO sync_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [r.k, r.v]);
    db.run(`UPDATE sync_ctl SET v = ? WHERE k = 'capture'`, [capture]);
    // كل تفريغ في سجل العمليات بسببه ونسخة أمانه (قاعدة المالك ٢٠٢٦-١٠-٠٥)
    logAudit(db, 'الإعدادات', 'delete', 'تفريغ الجهاز', (reason ? reason + ' · ' : 'بأمر المستخدم · ') + 'نسخة الأمان: ' + safetyPath.split('/').pop());
  });
  return safetyPath;
}
