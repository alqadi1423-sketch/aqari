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
  /** المنشأة وحدها (sync/acl.ts): قسم العملية التي تجيز كتابة العضو */
  op?: string;
  /** رموز الرؤية «قسم|عقار» */
  g?: string[];
  /** عقارات الصف · '*' للعام */
  pids?: string[];
  /** كاتب المسودة الأول */
  by?: string;
  /** مستندات تُكتب معه في الدفعة نفسها ولا تُرفع وحدها (إسقاطه بلا مبالغ) · لا تُحفظ في السحابة حقلاً */
  companions?: RemoteDoc[];
}

export interface PullPage { docs: RemoteDoc[]; next: Cursor | null; more?: boolean }

export interface Cursor {
  ts: string;
  id: string;
  /** سحب العضو: مؤشر لكل دفعة رموز (cloud/firestore.ts) */
  parts?: Record<string, { ts: string; id: string }>;
}

export interface WriteResult {
  ok: boolean;
  /** PERMISSION_DENIED لما ترفضه قواعد الأمان (كتعديل قيد مرحّل) */
  code?: string;
  message?: string;
}

export interface RemoteStore {
  /** المستندات التي كُتبت بعد المؤشر بترتيب وقت الخادم ثم المعرّف */
  /**
   * المستندات التي كُتبت بعد المؤشر بترتيب وقت الخادم ثم المعرّف · more: بقي بعدها ما يُسحب
   * (الصفحة قد تقصر عن الحد وقد بقي شيء حين يُهمل منها ما ليس للجهاز، كالإسقاط عند المالك)
   */
  pull(cursor: Cursor | null, limit: number): Promise<PullPage>;
  /** كتابة غير ذرية · نتيجة لكل مستند */
  write(docs: RemoteDoc[]): Promise<WriteResult[]>;
  /** المنشأة: يزيّن المستند الخارج بحقول الرؤية وإسقاطه قبل الكتابة (sync/acl.ts) */
  annotate?(db: import('../db/adapter').DB, doc: RemoteDoc): RemoteDoc;
  /**
   * جهاز عضو في منشأة: ما لا يجيزه قسمٌ له (op غائب) لا يُرفع، والمرفوض من القواعد يخرج من الطابور
   * إلى سجل المرفوض · فالحالة المشتقة محلياً (عقد انتهى، حجز سقط) لا تحبس الطابور، ويكتبها جهاز المالك
   */
  memberMode?: boolean;
  /** حرف الجهاز في ترقيم الحساب · يُسجَّل مرة ويبقى (numbering.ts) */
  registerDevice?(deviceId: string): Promise<string>;
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
