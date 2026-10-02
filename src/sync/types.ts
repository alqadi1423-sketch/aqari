/**
 * أنواع المزامنة · مستقلة عن Firestore نفسه، فالمحرّك يُختبر بمخزن في الذاكرة
 * ويعمل على الجهاز بعميل REST لـ Firestore.
 */
import type { SqlValue } from '../db/adapter';

export type RowData = Record<string, SqlValue>;

/** مستند صف واحد في users/{uid}/rows/{id} */
export interface RemoteDoc {
  /** معرّف المستند: الجدول__المفتاح */
  id: string;
  /** الجدول */
  t: string;
  /** المفتاح الأساسي (المركّب يُضمّ بـ «|») */
  k: string;
  /** أعمدة الصف · null في شاهد الحذف */
  d: RowData | null;
  /** سطور القيد · لمستندات journal_entries وحدها */
  lines?: RowData[];
  /** وقت التغيير على الجهاز الذي كتبه (ISO) · أساس حلّ التعارض */
  u: string;
  /** هوية الجهاز الذي كتبه */
  dev: string;
  /** شاهد حذف */
  del: boolean;
  /** وقت الخادم · يملؤه الخادم عند الكتابة ويُقرأ عند السحب */
  ts?: string;
}

export interface Cursor { ts: string; id: string }

export interface WriteResult {
  ok: boolean;
  /** PERMISSION_DENIED لما ترفضه قواعد الأمان (كتعديل قيد مرحّل) */
  code?: string;
  message?: string;
}

export interface RemoteStore {
  /** المستندات التي كُتبت بعد المؤشر بترتيب وقت الخادم ثم المعرّف */
  pull(cursor: Cursor | null, limit: number): Promise<{ docs: RemoteDoc[]; next: Cursor | null }>;
  /** كتابة غير ذرية · نتيجة لكل مستند */
  write(docs: RemoteDoc[]): Promise<WriteResult[]>;
}

export interface SyncReport {
  pulled: number;
  applied: number;
  conflicts: number;
  rejected: number;
  pushed: number;
  pending: number;
  waiting: number;
}

export class SyncError extends Error {
  constructor(detail: string) {
    super('تعذّرت المزامنة: ' + detail);
    this.name = 'SyncError';
  }
}
