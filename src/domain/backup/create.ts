import { joinPath } from '../../files/fsAdapter';
import { zipYielding, unzipYielding, yieldUi, archiveFailureText, type ZipEntry } from './zipStream';
import { liveBlobs } from '../../files/store';
import { integrityChecks } from '../accounting/integrity';
import { allAccounts, accountBalance } from '../accounting/ledger';
import { currentSchemaVersion } from '../../db/migrations';
import { libSizeLabel } from '../library';
import type { DB } from '../../db/adapter';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupVerificationError,
  HashingUnavailableError,
  NotEnoughSpaceError,
  type BackupEnv,
  type BackupManifest,
} from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** ضعفُ ما تشغله البيانات · القاعدة تُنسخ ثم تُضغط ثم يُفكّ بعضها، فالثلاثة هي الحدّ الآمن */
const SPACE_FACTOR = 3;

/** مجلد نسخ الأمان · دائم بجوار المؤقت لا داخله فلا يُكنس عند الإقلاع */
export function safetyBackupsDir(env: BackupEnv): string {
  return joinPath(env.tmpDir, '..', 'backups');
}

/**
 * نسخة أمان واحدة تبقى · وكل ما قبلها يُحذف.
 * فقد كانت كل محاولةٍ تترك ملفاً بحجم بياناتك كاملة في مجلدٍ لا تعدّه شاشة المساحة
 * ولا تكنسه مكنسة · فتتراكم بلا سقف. والحذف بعد نجاح الجديدة لا قبله، فلا تمرّ
 * لحظة واحدة والقرص بلا نسخة أمان.
 */
export async function makeSafetyBackup(
  env: BackupEnv,
  prefix: 'pre-restore' | 'pre-wipe',
  onProgress?: (msg: string) => void
): Promise<string> {
  const dir = safetyBackupsDir(env);
  env.fs.mkdirp(dir);
  const keep = `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.aqbk`;
  const outPath = joinPath(dir, keep);
  await createBackup(env, outPath, onProgress);
  for (const name of env.fs.list(dir)) {
    if (name === keep || !name.endsWith('.aqbk')) continue;
    try { env.fs.remove(joinPath(dir, name)); } catch { /* التالي · لا يعطّل */ }
  }
  return outPath;
}

/** بصمة حالة البيانات · تُؤخذ قبل العملية وتُقارن بعد فشلها */
export interface DataFingerprint {
  counts: Record<string, number>;
  attachmentFiles: number;
}

export function fingerprintData(env: BackupEnv): DataFingerprint {
  let attachmentFiles = 0;
  try { attachmentFiles = env.fs.list(env.attachmentsDir).length; } catch { attachmentFiles = 0; }
  return { counts: tableCounts(env.db), attachmentFiles };
}

/** المرفقات اليتيمة الآن · ملفٌ في المجلد لا صفَّ لبصمته في blobs */
export function orphanAttachments(env: BackupEnv): string[] {
  let names: string[];
  try { names = env.fs.list(env.attachmentsDir); } catch { return []; }
  const known = new Set(env.db.all<{ sha256: string }>(`SELECT sha256 FROM blobs`).map((r) => r.sha256));
  return names.filter((n) => !known.has(n.split('.')[0]));
}

/**
 * ما بقي من أثرٍ بعد فشل عملية · نصٌّ فارغ يعني أن شيئاً لم يتغيّر فعلاً.
 *
 * ولهذا وُجدت: كانت الرسالة تقول «بياناتك الحالية سليمة ولم يتغيّر شيء» في كل
 * فشل بلا استثناء، وفيها موضعٌ تكون فيه كاذبة — فتُقال الآن عن فحص لا عن ظنّ.
 */
export function describeResidue(env: BackupEnv, before: DataFingerprint): string {
  const parts: string[] = [];
  const now = tableCounts(env.db);
  const changed: string[] = [];
  for (const [t, n] of Object.entries(before.counts)) {
    // سجلّ العمليات يُلحَق به سطرُ الفشل نفسه قبل هذه المقارنة · فنموّه ليس أثراً
    if (t === 'audit_log') continue;
    if (now[t] !== undefined && now[t] !== n) changed.push(`${t}: ${n} ← ${now[t]}`);
  }
  if (changed.length) parts.push('تغيّرت أعداد جداول · ' + changed.slice(0, 4).join(' · '));
  const orphans = orphanAttachments(env);
  if (orphans.length) parts.push(`بقي ${orphans.length} ملف مرفق بلا سجل · يُزال من «سلة المحذوفات» بزر «حذف الكل نهائياً»`);
  return parts.join('. ');
}

/** ما تشغله بياناتك على القرص الآن · القاعدة بملفّيها الملحقين ومرفقاتها */
export function dataFootprintBytes(env: BackupEnv): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { if (env.fs.exists(env.dbPath + suffix)) total += env.fs.size(env.dbPath + suffix); } catch { /* التالي */ }
  }
  try {
    for (const name of env.fs.list(env.attachmentsDir)) {
      try { total += env.fs.size(joinPath(env.attachmentsDir, name)); } catch { /* التالي */ }
    }
  } catch { /* لا مجلد مرفقات بعد */ }
  return total;
}

/**
 * لا تبدأ عمليةً لا يسعها القرص · فالبدء ثم الفشل في المنتصف أسوأ من الامتناع.
 * والحدّ ثلاثة أضعاف ما تشغله البيانات: لقطة القاعدة، ثم الأرشيف، ثم ما يُفكّ منه.
 */
export async function ensureFreeSpace(env: BackupEnv): Promise<void> {
  const needed = dataFootprintBytes(env) * SPACE_FACTOR;
  const usable = await env.fs.usableSpace();
  if (usable >= needed) return;
  throw new NotEnoughSpaceError(
    `المساحة المتاحة ${libSizeLabel(usable)} ولا تكفي · العملية تحتاج ${libSizeLabel(needed)}. `
    + 'فرّغ مساحة ثم أعد المحاولة.'
  );
}

export function userTables(db: DB): string[] {
  return db
    .all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    )
    .map((r) => r.name);
}

export function tableCounts(db: DB): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of userTables(db)) {
    const row = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t}"`);
    out[t] = row ? Number(row.n) : 0;
  }
  return out;
}

function ledgerTotals(db: DB): BackupManifest['ledger'] {
  const tot = db.get<{ d: number; c: number }>(
    `SELECT COALESCE(SUM(l.debit_halalas),0) AS d, COALESCE(SUM(l.credit_halalas),0) AS c
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.status='مرحّل' AND e.deleted_at IS NULL`
  )!;
  const balances: Record<string, number> = {};
  for (const a of allAccounts(db)) balances[a.code] = accountBalance(db, a.code);
  return {
    total_debit_halalas: Number(tot.d),
    total_credit_halalas: Number(tot.c),
    balances,
  };
}

/**
 * إنشاء النسخة الاحتياطية · لا تُسمّى ناجحة قبل إعادة فتح الأرشيف
 * والتحقق من كل بصمة و integrity_check ومطابقة الأعداد.
 * تتنفس بين الملفات وتبلّغ تقدمها فلا يتجمد التطبيق ولا يقتله النظام.
 */
export async function createBackup(
  env: BackupEnv,
  outPath: string,
  onProgress?: (msg: string) => void
): Promise<BackupManifest> {
  if (!env.hasher) throw new HashingUnavailableError();
  const hasher = env.hasher;

  // ١) الفحوص الستة تُشغَّل قبل كل نسخة ومجاميعها تُكتب في البيان
  onProgress?.('جاري فحص سلامة الدفاتر');
  const integrity = integrityChecks(env.db);
  const counts = tableCounts(env.db);
  const ledger = ledgerTotals(env.db);
  const schemaVersion = currentSchemaVersion(env.db);
  const deviceRow = env.db.get<{ value: string }>(`SELECT value FROM meta WHERE key='device_id'`);
  await yieldUi();

  // ٢) لقطة القاعدة
  onProgress?.('جاري أخذ لقطة قاعدة البيانات');
  env.fs.mkdirp(env.tmpDir);
  if (!env.fs.exists(env.tmpDir)) throw new Error('تعذّر إنشاء المجلد المؤقت للنسخة');
  const tmpDb = joinPath(env.tmpDir, `backup-db-${Date.now()}.db`);
  if (env.fs.exists(tmpDb)) env.fs.remove(tmpDb);
  env.db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
  // SQLite يرفض المسار حاملاً scheme داخل SQL · يُنزع file:// قبل التضمين
  const sqlPath = (p: string): string =>
    p.startsWith('file://') ? decodeURIComponent(p.slice('file://'.length)) : p;
  const vacuumSql = `VACUUM INTO '${sqlPath(tmpDb).replace(/'/g, "''")}'`;
  try {
    // على خيط القاعدة الأصلي حيث يتوفر · فلا يُحتجز خيط الواجهة طوال النسخ
    if (env.db.execAsync) await env.db.execAsync(vacuumSql);
    else env.db.exec(vacuumSql);
  } catch {
    // البديل الذي لا يفشل: دمج WAL ثم إغلاق القاعدة ونسخ ملفها بايتاً ببايت ثم إعادة فتحها
    try { env.db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`); } catch { /* أُغلقت للتو */ }
    env.closeLive();
    try {
      env.fs.write(tmpDb, env.fs.read(env.dbPath));
    } finally {
      env.reopenLive();
    }
  }
  await yieldUi();

  let manifest: BackupManifest;
  const tmpArchive = joinPath(env.tmpDir, `backup-arch-${Date.now()}.aqbk`);
  try {
    const dbBytes = env.fs.read(tmpDb);
    const dbSha = await hasher(dbBytes);

    // ٣) المرفقات الحية · التحقق من بصمة كل ملف أثناء جمعه · تنفّس بعد كل ملف
    const zipEntries: ZipEntry[] = [{ name: 'data.db', bytes: dbBytes, level: 6 }];
    const files: BackupManifest['files'] = [];
    const missing: string[] = [];
    const blobs = liveBlobs(env.db);
    let bi = 0;
    for (const b of blobs) {
      bi += 1;
      onProgress?.(`جاري نسخ المرفقات · ${bi} من ${blobs.length}`);
      const p = joinPath(env.attachmentsDir, `${b.sha256}.${b.ext}`);
      if (!env.fs.exists(p)) { missing.push(b.sha256); continue; }
      const bytes = env.fs.read(p);
      const actual = await hasher(bytes);
      if (actual !== b.sha256) { missing.push(b.sha256); continue; }
      // المرفقات تُخزَّن بلا إعادة ضغط · صورها وملفاتها مضغوطة أصلاً
      zipEntries.push({ name: `attachments/${b.sha256}.${b.ext}`, bytes, level: 0 });
      files.push({ sha256: b.sha256, ext: b.ext, size: bytes.byteLength });
      if (bi % 8 === 0) await yieldUi();
    }

    manifest = {
      format: BACKUP_FORMAT,
      format_version: BACKUP_FORMAT_VERSION,
      app_version: env.appVersion,
      schema_version: schemaVersion,
      created_at: new Date().toISOString(),
      device_id: deviceRow ? deviceRow.value : '',
      db_sha256: dbSha,
      files,
      missing_files: missing,
      table_counts: counts,
      ledger,
      integrity,
      complete: missing.length === 0,
    };
    zipEntries.push({ name: 'manifest.json', bytes: enc.encode(JSON.stringify(manifest, null, 1)), level: 6 });

    // ٤) الضغط المتنفس والكتابة إلى ملف مؤقت
    const zipped = await zipYielding(zipEntries, (done, total) =>
      onProgress?.(`جاري ضغط الأرشيف · ${done} من ${total}`));
    env.fs.write(tmpArchive, zipped);

    // ٥) التحقق الإلزامي بإعادة فتح الأرشيف الناتج من القرص
    onProgress?.('جاري التحقق من الأرشيف الناتج');
    await verifyArchiveAt(env, tmpArchive, manifest, onProgress);

    // ٦) النقل الذرّي إلى الوجهة
    if (env.fs.exists(outPath)) env.fs.remove(outPath);
    env.fs.rename(tmpArchive, outPath);
  } catch (e) {
    // فشل نظيف: لا أرشيف جزئي يبقى
    try { if (env.fs.exists(tmpArchive)) env.fs.remove(tmpArchive); } catch { /* تجاهل */ }
    throw e;
  } finally {
    try { if (env.fs.exists(tmpDb)) env.fs.remove(tmpDb); } catch { /* تجاهل */ }
  }
  return manifest;
}

/** التحقق من أرشيف على القرص مقابل بيانه (يُستخدم بعد الإنشاء وقبل الاستعادة) */
export async function verifyArchiveAt(
  env: BackupEnv,
  archivePath: string,
  expected?: BackupManifest,
  onProgress?: (msg: string) => void
): Promise<{ manifest: BackupManifest; entries: Record<string, Uint8Array> }> {
  if (!env.hasher) throw new HashingUnavailableError();
  const hasher = env.hasher;
  const bytes = env.fs.read(archivePath);
  let entries: Record<string, Uint8Array>;
  try {
    entries = await unzipYielding(bytes);
  } catch (e) {
    // المسار كاملاً إلى السجل · ولا تُنسب العلّة إلى ملف لم يثبت تلفه
    console.error('[عقاري] تعذّر فكّ الأرشيف أثناء التحقق · ' + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
    throw new BackupVerificationError(archiveFailureText(e));
  }
  if (!entries['manifest.json'] || !entries['data.db'])
    throw new BackupVerificationError('الأرشيف ناقص (manifest.json أو data.db)');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(dec.decode(entries['manifest.json']));
  } catch {
    throw new BackupVerificationError('بيان غير قابل للقراءة');
  }
  if (manifest.format !== BACKUP_FORMAT)
    throw new BackupVerificationError('صيغة غير معروفة');
  if (expected && manifest.db_sha256 !== expected.db_sha256)
    throw new BackupVerificationError('بصمة البيان لا تطابق المتوقع');

  // بصمة القاعدة
  const dbSha = await hasher(entries['data.db']);
  if (dbSha !== manifest.db_sha256)
    throw new BackupVerificationError('بصمة قاعدة البيانات لا تطابق البيان');

  // بصمة كل مرفق · تنفّس بعد كل ملف
  let vi = 0;
  for (const f of manifest.files) {
    vi += 1;
    onProgress?.(`جاري التحقق من المرفقات · ${vi} من ${manifest.files.length}`);
    const name = `attachments/${f.sha256}.${f.ext}`;
    const fileBytes = entries[name];
    if (!fileBytes) throw new BackupVerificationError('مرفق مفقود من الأرشيف: ' + f.sha256);
    const actual = await hasher(fileBytes);
    if (actual !== f.sha256) throw new BackupVerificationError('بصمة مرفق لا تطابق: ' + f.sha256);
    if (vi % 8 === 0) await yieldUi();
  }

  // integrity_check على القاعدة المنسوخة + مطابقة الأعداد
  const tmpCheckDb = joinPath(env.tmpDir, `verify-${Date.now()}.db`);
  env.fs.mkdirp(env.tmpDir);
  env.fs.write(tmpCheckDb, entries['data.db']);
  let check: DB | null = null;
  try {
    check = env.openDb(tmpCheckDb);
    const ic = check.get<{ integrity_check: string }>(`PRAGMA integrity_check`);
    if (!ic || String(Object.values(ic)[0]) !== 'ok')
      throw new BackupVerificationError('integrity_check فشل على القاعدة المنسوخة');
    const counts = tableCounts(check);
    for (const [t, n] of Object.entries(manifest.table_counts)) {
      if (counts[t] !== undefined && counts[t] !== n)
        throw new BackupVerificationError(`عدد صفوف «${t}» لا يطابق البيان (${counts[t]} ≠ ${n})`);
    }
  } finally {
    try { check?.close(); } catch { /* تجاهل */ }
    try { env.fs.remove(tmpCheckDb); } catch { /* تجاهل */ }
    // ملفات wal/shm المؤقتة إن وُجدت
    for (const suffix of ['-wal', '-shm']) {
      try { if (env.fs.exists(tmpCheckDb + suffix)) env.fs.remove(tmpCheckDb + suffix); } catch { /* تجاهل */ }
    }
  }
  return { manifest, entries };
}
