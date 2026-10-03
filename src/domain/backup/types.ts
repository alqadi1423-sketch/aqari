import type { CipherProvider } from './encryption';
import type { DB } from '../../db/adapter';
import type { FS, Hasher } from '../../files/fsAdapter';
import type { IntegrityCheck } from '../accounting/integrity';

export const BACKUP_FORMAT = 'aqari-backup';
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  format_version: number;
  app_version: string;
  schema_version: number;
  created_at: string;
  device_id: string;
  db_sha256: string;
  files: Array<{ sha256: string; ext: string; size: number }>;
  missing_files: string[];
  table_counts: Record<string, number>;
  ledger: {
    total_debit_halalas: number;
    total_credit_halalas: number;
    balances: Record<string, number>;
  };
  integrity: IntegrityCheck[];
  complete: boolean;
}

export interface BackupEnv {
  db: DB;
  dbPath: string;
  fs: FS;
  /** null = وحدة التجزئة معطّلة → يُرفض إنشاء النسخة */
  hasher: Hasher | null;
  attachmentsDir: string;
  tmpDir: string;
  appVersion: string;
  /** فتح قاعدة على مسار (للتحقق من النسخ المستخرجة) */
  openDb(path: string): DB;
  /** إغلاق القاعدة الحية (يلزم للتبديل الذرّي أثناء الاستعادة) */
  closeLive(): void;
  /** إعادة فتح القاعدة الحية بعد التبديل */
  reopenLive(): DB;
  /** أوّليات التشفير القياسية · للنسخ بكلمة مرور (encryption.ts) · غيابها يمنع التشفير وفكّه */
  cipher?: CipherProvider;
}

export class HashingUnavailableError extends Error {
  constructor() {
    super('وحدة التجزئة غير متاحة · يُرفض إنشاء النسخة الاحتياطية بلا تحقق');
    this.name = 'HashingUnavailableError';
  }
}

export class BackupVerificationError extends Error {
  constructor(detail: string) {
    super('فشل التحقق من النسخة الاحتياطية: ' + detail);
    this.name = 'BackupVerificationError';
  }
}

/** فحص سلامة مختلّ يمنع إنشاء النسخة · الرسالة تسمّي كل فحص فشل وقيمته */
export class BackupIntegrityError extends Error {
  constructor(public failed: string[]) {
    super('يُرفض إنشاء النسخة · فحص السلامة مختلّ: ' + failed.join('، '));
    this.name = 'BackupIntegrityError';
  }
}

export class RestoreError extends Error {
  constructor(detail: string) {
    super('تعذّرت الاستعادة: ' + detail);
    this.name = 'RestoreError';
  }
}

/** القرص لا يسع العملية · تُمنع قبل أن تبدأ لا أن تفشل في منتصفها */
export class NotEnoughSpaceError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'NotEnoughSpaceError';
  }
}
