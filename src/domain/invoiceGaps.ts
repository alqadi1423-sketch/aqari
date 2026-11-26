/**
 * فجوات تسلسل الفاتورة الضريبية (المراجعة الشاملة 2026-11-13 · B-7): القواعد تجيز لعضو «كامل الفواتير» أن يرفع عدّاد INV واحداً في كل
 * كتابة بلا فاتورةٍ تصدر، فيبقى رقمٌ محجوزٌ بلا فاتورة في تسلسلٍ قرّر المالك أنه بلا فجوات (2026-10-05) · هذا التقرير يكشفها في
 * «فحص المطابقة»، والجذر (الخادم يأخذ الرقم ويكتب الفاتورة في معاملة واحدة) يُبنى مع الخادم.
 *
 *  - الرقم مشغولٌ بأي صفٍّ في invoices: فاتورة أو إشعار دائن (صفّهما واحد)، صادر أو محذوف (الرقم الذي ظهر لا يُعاد)، وبحرف جهازٍ قديم
 *    أو بلا حرف (أول رقمٍ من العدّاد بعد أعلى ما يعرفه الجهاز، فما دون ذلك تسلسلٌ قديم).
 *  - المدى من ١ إلى أعلى رقمٍ بلا حرف · فما رُفع بعد آخر فاتورة يظهر حين تصدر التي بعده.
 *  - رقم هذا الجهاز المحجوز (inv_reserved) تأخذه فاتورته التالية فليس فجوة · ورقمٌ محجوز في جهازٍ لم يزامن بعد لا يُرى هنا.
 *  - للمالك وحده: جهاز العضو لا يحمل كل الفواتير.
 */
import type { DB } from '../db/adapter';
import { INV_RESERVED_KEY } from './invoiceIssue';

const SEQ_GLOB = `no GLOB 'INV-[0-9][0-9][0-9][0-9]-[0-9]*'`;
const LETTERED = `(no GLOB '*-[A-Z]' OR no GLOB '*-[A-Z][A-Z]')`;

export function invoiceSeqGaps(db: DB): number[] {
  const hi = Number(db.get<{ mx: number }>(
    `SELECT COALESCE(MAX(CAST(substr(no, 10) AS INTEGER)), 0) AS mx FROM invoices WHERE ${SEQ_GLOB} AND NOT ${LETTERED}`)?.mx ?? 0);
  if (hi < 2) return [];
  const used = new Set(db.all<{ n: number }>(
    `SELECT DISTINCT CAST(substr(no, 10) AS INTEGER) AS n FROM invoices WHERE ${SEQ_GLOB}`).map((r) => Number(r.n)));
  const reserved = Number(db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [INV_RESERVED_KEY])?.value);
  if (Number.isInteger(reserved)) used.add(reserved);
  const out: number[] = [];
  for (let n = 1; n < hi; n++) if (!used.has(n)) out.push(n);
  return out;
}
