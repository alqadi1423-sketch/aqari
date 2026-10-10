/**
 * إصدار الفاتورة الضريبية بلا فجوات (قرار المالك ٢٠٢٦-١٠-٠٥):
 *  - رقمها من عدّاد السحابة لحظة إصدارها، والعدّاد يتقدم واحداً فلا يأخذ جهازان الرقم نفسه ولا يُترك رقم.
 *  - بلا اتصال تبقى «مسودة» برقم مؤقت لا يُطبع، وتُسجَّل بانتظار الإصدار، وتصدر برقمها عند عودة الاتصال.
 *  - الرقم المأخوذ يُحفظ محجوزاً قبل الكتابة المحلية ويُمسح بعدها · فإن تعذّرت الكتابة أخذته الفاتورة التالية ولا فجوة.
 *  - جهازٌ لا يزامن (لا مصدر) يُرقِّم من تسلسله كما كان.
 * والحالتان (المحجوز وما ينتظر الإصدار) تخصّان التثبيت: تبقيان مع المسح ولا تأتيان مع نسخة مستعادة.
 */
import type { DB } from '../db/adapter';
import { localMaxNumber, FirstIssueByOwnerError } from './numbering';
import {
  saveInvoice, setInvoiceStatus, needsIssueNumber, invoiceNoFor, isTempInvoiceNo, saveCreditNote, type InvoiceInput, type CreditNoteInput,
} from './invoices';
import { t } from '../i18n';
import { isFiledDate } from './vatFilings';

export interface InvoiceNumberSource { takeInvoiceSeq(floor: number): Promise<number> }

export const INV_RESERVED_KEY = 'inv_reserved';
export const INV_PENDING_KEY = 'inv_issue_pending';

const getMetaVal = (db: DB, k: string) => db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [k])?.value ?? null;
const setMetaVal = (db: DB, k: string, v: string | null) => {
  if (v === null) db.run(`DELETE FROM meta WHERE key = ?`, [k]);
  else db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [k, v]);
};

/** الفواتير المنتظِرة إصدارها على هذا الجهاز · بترتيب طلبها */
export function pendingIssues(db: DB): string[] {
  try { return JSON.parse(getMetaVal(db, INV_PENDING_KEY) ?? '[]') as string[]; } catch { return []; }
}
const setPending = (db: DB, ids: string[]) => setMetaVal(db, INV_PENDING_KEY, ids.length ? JSON.stringify(ids) : null);
export const isIssuePending = (db: DB, id: string): boolean => pendingIssues(db).includes(id);

/** الرقم: المحجوز من محاولة سابقة إن بقي، وإلا من العدّاد · ويُحفظ محجوزاً حتى تُكتب الفاتورة */
async function reserveSeq(db: DB, src: InvoiceNumberSource): Promise<number> {
  const kept = Number(getMetaVal(db, INV_RESERVED_KEY));
  if (Number.isInteger(kept) && kept > 0) return kept;
  const n = await src.takeInvoiceSeq(localMaxNumber(db, 'INV'));
  setMetaVal(db, INV_RESERVED_KEY, String(n));
  return n;
}
const releaseSeq = (db: DB) => setMetaVal(db, INV_RESERVED_KEY, null);

export interface IssueResult { id: string; pending: boolean }

/** حفظ فاتورة · والإصدار برقم العدّاد، وبلا اتصال مسودةٌ بانتظار الإصدار */
export async function saveInvoiceIssued(
  db: DB, src: InvoiceNumberSource | null, input: InvoiceInput, status: 'مسودة' | 'مستحقة', existingId?: string,
): Promise<IssueResult> {
  if (!src || !needsIssueNumber(db, existingId, status)) return { id: saveInvoice(db, input, status, existingId), pending: false };
  let seq: number;
  try {
    seq = await reserveSeq(db, src);
  } catch (e) {
    const id = saveInvoice(db, input, 'مسودة', existingId);
    // أول فاتورة بعد التفعيل للمالك: تُحفظ مسودة بلا انتظار، ويصل العضوَ السببُ (قرار المالك على #55)
    if (e instanceof FirstIssueByOwnerError) throw e;
    setPending(db, [...pendingIssues(db).filter((x) => x !== id), id]);
    return { id, pending: true };
  }
  const id = saveInvoice(db, input, status, existingId, invoiceNoFor(seq, input.issue));
  releaseSeq(db);
  setPending(db, pendingIssues(db).filter((x) => x !== id));
  return { id, pending: false };
}

/** تغيير الحالة · الخروج من المسودة برقمٍ مؤقت يأخذ رقم العدّاد، وبلا اتصال تبقى بانتظار الإصدار */
export async function setInvoiceStatusIssued(
  db: DB, src: InvoiceNumberSource | null, id: string, status: 'مسودة' | 'مستحقة' | 'متأخرة',
): Promise<IssueResult> {
  if (!src || !needsIssueNumber(db, id, status)) {
    setInvoiceStatus(db, id, status);
    if (status === 'مسودة') setPending(db, pendingIssues(db).filter((x) => x !== id));
    return { id, pending: false };
  }
  let seq: number;
  try {
    seq = await reserveSeq(db, src);
  } catch (e) {
    if (e instanceof FirstIssueByOwnerError) throw e;
    setPending(db, [...pendingIssues(db).filter((x) => x !== id), id]);
    return { id, pending: true };
  }
  const issue = db.get<{ issue: string }>(`SELECT issue FROM invoices WHERE id = ?`, [id])?.issue;
  setInvoiceStatus(db, id, status, invoiceNoFor(seq, issue));
  releaseSeq(db);
  setPending(db, pendingIssues(db).filter((x) => x !== id));
  return { id, pending: false };
}

/**
 * عند عودة الاتصال (بعد كل مزامنة ناجحة): تصدر المنتظِرة بترتيبها · وما حُذف أو صدر أو أُعيد مسودةً بيد
 * المستخدم يخرج من القائمة. يتوقف عند أول تعذّر ويبقى الباقي لدورةٍ تالية. يعيد عدد ما صدر.
 */
export async function issuePendingInvoices(db: DB, src: InvoiceNumberSource): Promise<number> {
  let issued = 0;
  for (const id of pendingIssues(db)) {
    const v = db.get<{ no: string; status: string; deleted_at: string | null }>(`SELECT no, status, deleted_at FROM invoices WHERE id = ?`, [id]);
    if (!v || v.deleted_at || v.status !== 'مسودة' || !isTempInvoiceNo(v.no)) {
      setPending(db, pendingIssues(db).filter((x) => x !== id));
      continue;
    }
    // تاريخها في ربعٍ قُدِّم إقراره بعد حفظها: لا تصدر فيه، وتبقى ظاهرةً للمستخدم يغيّر تاريخها، ولا توقف ما بعدها (التحقق المستقل)
    const issue = db.get<{ issue: string }>(`SELECT issue FROM invoices WHERE id = ?`, [id])?.issue;
    if (issue && isFiledDate(db, issue)) continue;
    let r: IssueResult;
    try {
      r = await setInvoiceStatusIssued(db, src, id, 'مستحقة');
    } catch (e) {
      // أول فاتورة بعد التفعيل للمالك: تبقى منتظرةً حتى يصدرها، ولا توقف ما بعدها
      if (e instanceof FirstIssueByOwnerError) break;
      throw e;
    }
    if (r.pending) break;
    issued++;
  }
  return issued;
}

/**
 * إصدار إشعار دائن (#30) برقمٍ من تسلسل الفواتير نفسه · من العدّاد على جهازٍ يزامن، فإن تعذّر الاتصال لم يصدر
 * (لا مسودة للإشعار) · وجهازٌ لا يزامن من تسلسله
 */
export async function issueCreditNote(db: DB, src: InvoiceNumberSource | null, invoiceId: string, input: CreditNoteInput): Promise<string> {
  if (!src) return saveCreditNote(db, invoiceId, input);
  let seq: number;
  try {
    seq = await reserveSeq(db, src);
  } catch {
    throw new Error(t('invoice.creditNeedsConnection'));
  }
  const id = saveCreditNote(db, invoiceId, input, invoiceNoFor(seq, input.date));
  releaseSeq(db);
  return id;
}

/** يلغي انتظار الإصدار · حين يُبقيها المستخدم مسودةً بقصد */
export function cancelPendingIssue(db: DB, id: string): void {
  setPending(db, pendingIssues(db).filter((x) => x !== id));
}
