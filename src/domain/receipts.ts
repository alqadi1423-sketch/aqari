/**
 * أرقام سندات القبض (المراجعة الشاملة 2026-11-13 · E-10 · قرار المالك س٣٠): متسلسلةٌ من عدّاد السحابة مثل بقية المستندات، بكتلٍ يحجزها كل
 * جهاز (numbering.ts · السلسلة RCP) فتعمل بلا اتصال والفجوات مقبولة · الصيغة `RCP-<سنة الدفعة>-<التسلسل>` والتسلسل واحدٌ عبر السنين كالعقود ·
 * يُحفظ مع الدفعة عند تسجيلها (الهجرة ٦٥: contract_payments.receipt_no) فيُطبع ويُبحث به · وما سُجّل قبل التغيير بلا رقم يُطبع برقمه
 * المشتق من معرّفه كما طُبع من قبل.
 */
import type { DB } from '../db/adapter';
import { takeNumber, deviceLetter, withLetter } from './numbering';

const pad = (n: number) => String(n).padStart(4, '0');

/** رقم السند التالي · من كتلة الجهاز، وبلا كتلة: تسلسل هذا الجهاز (بحرفه إن كان له حرف) بعد أعلى ما عنده */
export function nextReceiptNo(db: DB, date: string): string {
  const yr = /^\d{4}/.test(date) ? date.slice(0, 4) : String(new Date().getFullYear());
  const n = takeNumber(db, 'RCP');
  if (n !== null) return 'RCP-' + yr + '-' + pad(n);
  const letter = deviceLetter(db);
  const own = new RegExp('^RCP-\\d{4}-(\\d+)' + (letter ? '-' + letter : '') + '$');
  let max = 0;
  // i18n-exempt: تعليل الاستعلام لحارس الدفعات الملغاة
  for (const r of db.all<{ n: string }>(`SELECT receipt_no AS n FROM contract_payments /* تشمل الملغاة: رقم سندها مأخوذ */ WHERE receipt_no IS NOT NULL`)) {
    const m = String(r.n).match(own);
    if (m) max = Math.max(max, +m[1]);
  }
  return withLetter('RCP-' + yr + '-' + pad(max + 1), letter);
}

/** يعطي الدفعة رقم سندها إن لم يكن لها رقم · يُنادى بعد كل إدراجٍ لدفعة */
export function stampReceiptNo(db: DB, paymentId: string, date: string): void {
  if (db.get(`SELECT 1 FROM contract_payments WHERE id = ? AND receipt_no IS NULL`, [paymentId])) {
    db.run(`UPDATE contract_payments SET receipt_no = ? WHERE id = ?`, [nextReceiptNo(db, date), paymentId]);
  }
}

/** الرقم المشتق القديم · لسندٍ سُجّلت دفعته قبل الهجرة ٦٥ (أو على جهازٍ بإصدارٍ أقدم) */
export const legacyReceiptNo = (paymentId: string): string => 'RCP-' + paymentId.slice(0, 8).toUpperCase();

/** رقم سند الدفعة للطباعة: المحفوظ، وإلا المشتق كما طُبع من قبل */
export function receiptNoOf(db: DB, paymentId: string): string {
  const n = db.get<{ n: string | null }>(`SELECT receipt_no AS n FROM contract_payments WHERE id = ?`, [paymentId])?.n;
  return n || legacyReceiptNo(paymentId);
}

/** أقساط الدفعات التي يطابق رقم سندها النص (المحفوظ، أو المشتق القديم لما لا رقم له) · والتحصيل الجماعي بأقساط توزيعه · للبحث في التحصيل */
export function paymentsByReceipt(db: DB, needle: string): Set<string> {
  const q = needle.trim().toUpperCase();
  if (!q.startsWith('RCP')) return new Set();
  const rows = db.all<{ i: string | null }>(
    // i18n-exempt: تعليل الاستعلام لحارس الدفعات الملغاة
    `SELECT COALESCE(p.installment_id, a.installment_id) AS i FROM contract_payments p /* تشمل الملغاة: سندٌ طُبع ثم أُلغيت دفعته يُبحث به */
       LEFT JOIN payment_allocations a ON a.payment_id = p.id AND p.installment_id IS NULL
      WHERE UPPER(COALESCE(p.receipt_no, '')) LIKE ? OR (p.receipt_no IS NULL AND 'RCP-' || UPPER(substr(p.id, 1, 8)) LIKE ?)`,
    ['%' + q + '%', '%' + q + '%']);
  return new Set(rows.map((r) => r.i).filter((x): x is string => !!x));
}
