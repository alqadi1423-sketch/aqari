/**
 * الاستعادة على القاعدة الحاكمة: لا تُمسّ البيانات القائمة حتى يثبت أن البديل صالح كاملاً.
 * مرحلتان: تجهيز (فك إلى staging على القرص وتحرير الذاكرة فوراً ثم تحقق كامل من القرص
 * وملخص «ما سيحدث») ثم تنفيذ (نسخة أمان في مجلد دائم لا يُكنس، تبديل ذرّي برجوع فوري).
 * الذاكرة لا تحمل الأرشيف والمرفقات معاً أثناء نسخة الأمان · هذا ما كان يقتل التطبيق.
 */
import { joinPath } from '../../files/fsAdapter';
import { liveBlobs } from '../../files/store';
import { unzipYielding, yieldUi, archiveFailureText } from './zipStream';
import { currentSchemaVersion, migrate, NewerSchemaError } from '../../db/migrations';
import { SCHEMA_VERSION } from '../../db/schema';
import type { DB } from '../../db/adapter';
import { tableCounts, makeSafetyBackup, ensureFreeSpace } from './create';
import { semanticIssues } from './semantic';
import { BACKUP_FORMAT, RestoreError, type BackupEnv, type BackupManifest } from './types';

const dec = new TextDecoder();

export interface RestorePlan {
  manifest: BackupManifest;
  /** مجلد التجهيز · يُمرَّر للتنفيذ أو للإلغاء */
  stagingDir: string;
  stagedDbPath: string;
  migrated: boolean;
  /** ملخص «ما سيحدث»: أعداد النسخة مقابل أعداد البيانات الحالية */
  incoming: Record<string, number>;
  current: Record<string, number>;
  attachmentsBytes: number;
  /** مرفقات البيانات الحالية · الجانبان يُعرضان بالبنود نفسها */
  currentAttachments: { count: number; bytes: number };
}

export interface RestoreResult {
  manifest: BackupManifest;
  safetyBackupPath: string;
  db: DB;
  migrated: boolean;
}

/**
 * المراحل ١-٤: فحص الملف، قراءة البيان، الاستخراج إلى staging، التشغيل التجريبي كاملاً.
 * لا يلمس البيانات الحية بشيء · وعند أي فشل يُكنس staging وتُرمى رسالة عربية.
 */
export async function prepareRestore(
  env: BackupEnv,
  archivePath: string,
  onProgress?: (msg: string) => void
): Promise<RestorePlan> {
  if (!env.hasher) throw new RestoreError('التحقق يحتاج مكوّن البصمات وهو غير متاح');
  const hasher = env.hasher;

  // ٠) القرص يسع العملية · قبل أن يُكتب بايت واحد
  await ensureFreeSpace(env);

  // ١) الملف موجود ويُقرأ
  if (!env.fs.exists(archivePath)) throw new RestoreError('الملف غير موجود');
  const stagingDir = joinPath(env.tmpDir, `restore-staging-${Date.now()}`);
  env.fs.mkdirp(stagingDir);

  let manifest: BackupManifest;
  const stagedDbPath = joinPath(stagingDir, 'data.db');
  try {
    // ٢) الفك المتنفس والبيان · ثم الكتابة للقرص وتحرير الذاكرة قبل أي خطوة ثقيلة
    onProgress?.('جاري فكّ الأرشيف');
    let entries: Record<string, Uint8Array> | null;
    try {
      entries = await unzipYielding(env.fs.read(archivePath));
    } catch (e) {
      console.error('[عقاري] تعذّر فكّ أرشيف الاستعادة · ' + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
      throw new RestoreError(archiveFailureText(e, 'هذا الملف ليس نسخة احتياطية من عقاري'));
    }
    if (!entries['manifest.json'] || !entries['data.db'])
      throw new RestoreError('هذا الملف ليس نسخة احتياطية من عقاري (البيان أو القاعدة مفقودان)');
    try {
      manifest = JSON.parse(dec.decode(entries['manifest.json']));
    } catch {
      throw new RestoreError('بيان النسخة غير قابل للقراءة');
    }
    if (manifest.format !== BACKUP_FORMAT)
      throw new RestoreError('هذا الملف ليس نسخة احتياطية من عقاري');
    if (manifest.schema_version > SCHEMA_VERSION)
      throw new NewerSchemaError(manifest.schema_version, SCHEMA_VERSION);

    // ٣) الاستخراج إلى staging · البيانات الحالية لم تُمسّ · تنفّس بعد كل ملف
    env.fs.write(stagedDbPath, entries['data.db']);
    env.fs.mkdirp(joinPath(stagingDir, 'attachments'));
    let ei = 0;
    for (const f of manifest.files) {
      ei += 1;
      onProgress?.(`جاري استخراج المرفقات · ${ei} من ${manifest.files.length}`);
      const name = `attachments/${f.sha256}.${f.ext}`;
      const bytes = entries[name];
      if (!bytes) throw new RestoreError('النسخة ينقصها مرفق مذكور في بيانها: ' + f.sha256.slice(0, 12));
      env.fs.write(joinPath(stagingDir, name), bytes);
      delete entries[name]; // تحرير فوري · الذاكرة لا تحمل المرفقات كلها
      if (ei % 8 === 0) await yieldUi();
    }
    entries = null; // الأرشيف كله خرج من الذاكرة قبل التشغيل التجريبي ونسخة الأمان

    // ٤) التشغيل التجريبي من القرص · بصمات وقاعدة وأعداد · تنفّس بعد كل بصمة
    onProgress?.('جاري التحقق من بصمة القاعدة');
    const dbSha = await hasher(env.fs.read(stagedDbPath));
    if (dbSha !== manifest.db_sha256)
      throw new RestoreError('بصمة قاعدة النسخة لا تطابق بيانها (الملف عُدّل أو تلف)');
    let hi = 0;
    for (const f of manifest.files) {
      hi += 1;
      onProgress?.(`جاري التحقق من المرفقات · ${hi} من ${manifest.files.length}`);
      const p = joinPath(stagingDir, `attachments/${f.sha256}.${f.ext}`);
      const actual = await hasher(env.fs.read(p));
      if (actual !== f.sha256)
        throw new RestoreError('بصمة مرفق لا تطابق بيانها: ' + f.sha256.slice(0, 12));
      if (hi % 8 === 0) await yieldUi();
    }
    onProgress?.('جاري التشغيل التجريبي للنسخة');

    let migrated = false;
    let incoming: Record<string, number> = {};
    {
      let probe: DB | null = null;
      try {
        probe = env.openDb(stagedDbPath);
        const found = currentSchemaVersion(probe);
        if (found > SCHEMA_VERSION) throw new NewerSchemaError(found, SCHEMA_VERSION);
        if (found < SCHEMA_VERSION) { migrate(probe); migrated = true; }
        const ic = probe.get<Record<string, string>>(`PRAGMA integrity_check`);
        if (!ic || String(Object.values(ic)[0]) !== 'ok')
          throw new RestoreError('قاعدة النسخة تالفة (integrity_check)');
        // الفحص الدلالي: قيد مرحّل غير متوازن أو قسط يتجاوزه مسدَّده مع خصمه يرفض الاستعادة كاملة
        const issues = semanticIssues(probe);
        if (issues.length) throw new RestoreError('النسخة مرفوضة · ' + issues.join(' · '));
        // قراءة من كل جدول أساسي + مطابقة الأعداد بالبيان
        incoming = tableCounts(probe);
        // حزام: فتحٌ أنشأ قاعدة فارغة بدل المجهَّزة يُرفض ولا يمرّ صامتاً
        if (!('properties' in incoming) || !('journal_entries' in incoming))
          throw new RestoreError('تعذّر فتح قاعدة النسخة للفحص · لم يُقرأ منها جدول واحد');
        for (const [t, expected] of Object.entries(manifest.table_counts)) {
          if (incoming[t] !== undefined && !migrated && incoming[t] !== expected)
            throw new RestoreError(`عدد سجلات «${t}» لا يطابق البيان (${incoming[t]} بدل ${expected})`);
        }
        probe.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
      } finally {
        try { probe?.close(); } catch { /* مغلقة */ }
      }
    }

    const attachmentsBytes = manifest.files.reduce((s, f) => s + f.size, 0);
    // مرفقات البيانات الحالية بالبنود نفسها · فيُرى ما سيُخسر من الجانبين لا من جانب واحد
    const live = liveBlobs(env.db);
    return {
      manifest, stagingDir, stagedDbPath, migrated, incoming,
      current: tableCounts(env.db),
      attachmentsBytes,
      currentAttachments: { count: live.length, bytes: live.reduce((s, b) => s + Number(b.size_bytes), 0) },
    };
  } catch (e) {
    abortRestore(env, stagingDir);
    throw e;
  }
}

/** إلغاء التجهيز · يكنس staging والبيانات الحية كما هي بالضبط */
export function abortRestore(env: BackupEnv, stagingDir: string): void {
  try {
    if (!env.fs.exists(stagingDir)) return;
    for (const name of env.fs.list(joinPath(stagingDir, 'attachments'))) {
      try { env.fs.remove(joinPath(stagingDir, 'attachments', name)); } catch { /* التالي */ }
    }
    for (const name of env.fs.list(stagingDir)) {
      try { env.fs.remove(joinPath(stagingDir, name)); } catch { /* التالي */ }
    }
    env.fs.remove(stagingDir);
  } catch { /* لا يعطّل */ }
}

/**
 * المراحل ٥-٧: نسخة أمان (في مجلد دائم لا يُكنس عند الإقلاع، وفشلها يلغي كل شيء)،
 * تبديل ذرّي برجوع فوري، ثم التنظيف.
 */
export async function commitRestore(
  env: BackupEnv,
  plan: RestorePlan,
  onProgress?: (msg: string) => void
): Promise<RestoreResult> {
  // ٥) نسخة الأمان · بعد نجاح التجريبي لا قبله · واحدة تبقى وما قبلها يُحذف
  onProgress?.('جاري تأمين بياناتك الحالية بنسخة أمان');
  let safetyBackupPath: string;
  try {
    safetyBackupPath = await makeSafetyBackup(env, 'pre-restore', onProgress);
  } catch (e) {
    abortRestore(env, plan.stagingDir);
    throw new RestoreError('تعذّر تأمين بياناتك الحالية بنسخة أمان، فأُلغيت الاستعادة. '
      + (e instanceof Error ? e.message : ''));
  }

  // ٦) التبديل الذرّي
  onProgress?.('جاري التبديل إلى النسخة');
  const preSwap = env.dbPath + '.pre-restore';
  env.closeLive();
  for (const suffix of ['-wal', '-shm']) {
    try { if (env.fs.exists(env.dbPath + suffix)) env.fs.remove(env.dbPath + suffix); } catch { /* تجاهل */ }
  }
  try { if (env.fs.exists(preSwap)) env.fs.remove(preSwap); } catch { /* تجاهل */ }
  env.fs.rename(env.dbPath, preSwap);
  // ما نُقل فعلاً إلى مجلد المرفقات · يُعكس حرفياً إن فشل ما بعده
  const moved: Array<{ src: string; dest: string }> = [];
  try {
    env.fs.rename(plan.stagedDbPath, env.dbPath);

    // الفحص النهائي **قبل** نقل المرفقات · وهذا ترتيبٌ مقصود:
    // الفحص لا يحتاج المرفقات أصلاً، ونقلُها قبله كان يترك — إن فشل — ملفاتٍ في
    // مجلد المرفقات بلا صفٍّ في blobs بعد رجوع القاعدة، ولا مكنسة في التطبيق تراها.
    // فتأخير النقل يُلغي نافذة اليُتم كلها بدل أن يعالجها بعد وقوعها.
    onProgress?.('جاري الفحص النهائي');
    const fresh = env.reopenLive();
    const ic = fresh.get<Record<string, string>>(`PRAGMA integrity_check`);
    if (!ic || String(Object.values(ic)[0]) !== 'ok')
      throw new RestoreError('فشل الفحص بعد التبديل');

    // دمج المرفقات من staging بالنقل لا بالقراءة · الذاكرة لا تُحمَّل
    env.fs.mkdirp(env.attachmentsDir);
    let mi = 0;
    for (const f of plan.manifest.files) {
      mi += 1;
      onProgress?.(`جاري نقل المرفقات · ${mi} من ${plan.manifest.files.length}`);
      const src = joinPath(plan.stagingDir, `attachments/${f.sha256}.${f.ext}`);
      const dest = joinPath(env.attachmentsDir, `${f.sha256}.${f.ext}`);
      // وما بقي من نافذة — أن يفشل النقل في منتصفه — يُعكس بالسجل أدناه
      if (!env.fs.exists(dest)) { env.fs.rename(src, dest); moved.push({ src, dest }); }
    }
    try { env.fs.remove(preSwap); } catch { /* تجاهل */ }
    // ٧) التنظيف
    abortRestore(env, plan.stagingDir);
    return { manifest: plan.manifest, safetyBackupPath, db: fresh, migrated: plan.migrated };
  } catch (e) {
    // رجوع فوري · بياناتك السابقة ترجع كما كانت، وملفاتها كذلك
    for (let i = moved.length - 1; i >= 0; i--) {
      try { if (env.fs.exists(moved[i].dest)) env.fs.rename(moved[i].dest, moved[i].src); } catch { /* التالي */ }
    }
    try { env.closeLive(); } catch { /* مغلقة */ }
    try { if (env.fs.exists(env.dbPath)) env.fs.remove(env.dbPath); } catch { /* تجاهل */ }
    env.fs.rename(preSwap, env.dbPath);
    env.reopenLive();
    abortRestore(env, plan.stagingDir);
    throw e instanceof RestoreError ? e
      : new RestoreError('تعذّرت الاستعادة ورجعت بياناتك السابقة كما كانت. '
        + (e instanceof Error ? e.message : ''));
  }
}

/** المسار المركّب (تجهيز ثم تنفيذ مباشرة) · تستعمله الاختبارات والاستدعاءات غير التفاعلية */
export async function restoreBackup(env: BackupEnv, archivePath: string): Promise<RestoreResult> {
  const plan = await prepareRestore(env, archivePath);
  return commitRestore(env, plan);
}
