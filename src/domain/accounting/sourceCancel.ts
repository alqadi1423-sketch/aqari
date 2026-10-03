/**
 * كل قيد تلقائي يُلغى من عمليته الأصلية (قرار المالك ٢٠٢٦-١٠-٠٣) · زرّ «عكس القيد» في الدفتر يفتح عملية مصدره.
 *
 *  - قيد دفعة إيجار ← «إلغاء الدفعة» (cancelPayment.ts).
 *  - قيد خصم مربوط بدفعة أو قسط ← «إلغاء قيد الخصم»: يُعكس، والدفعة ترجع خصماً بلا نوع كما قبل حجزه.
 *  - عملية نقد (مصروف نثري · إيداع المالك · مسحوباته) ← «إلغاء العملية»: تُعكس، ولا يُسحب من المحفظة ما ليس فيها.
 *  - عمولة تقبيل ← «إلغاء التقبيل»: تُعكس وحركة بنكها، والصفقة تدخل السلة.
 *  - استرداد ضريبة أو رفضه ← «إلغاء الاسترداد»: يُعكس وترجع الفاتورة «لم يُطلب».
 *  - ردّ فائض أو تحويله رصيداً ← «إلغاء الرد»: يُعكس، وحركة البنك بمثلها، والرصيد الدائن يُطرح إن لم يُستعمل.
 *  - وما له عملية في شاشة مستنده (فاتورة · مشتريات · مطالبة · تأمين · حجز) يُفتح مستنده ليُلغى منه.
 * كلٌّ ذرّي بتاريخ وسبب، وفي سجل العمليات · والقيد اليدوي يُعكس من الدفتر كما هو.
 */
import type { DB } from '../../db/adapter';
import { uid } from '../ids';
import { logAudit } from '../audit';
import { reverseEntryById } from './post';
import { walletCashBalance } from './ledger';
import { RuleViolation } from '../contracts/service';
import { DISCOUNT_ENTRY_SRC } from '../contracts/installments';
import { fmt } from '../money';

export type SourceAction =
  | { kind: 'payment'; paymentId: string }
  | { kind: 'op'; label: string; effects: string[]; blockers: string[]; run: (date: string, reason: string) => void }
  | { kind: 'document' }
  | null;

interface EntryRow { id: string; no: string; auto: number; src_type: string | null; src_id: string | null; status: string; reversed_by: string | null }

const DOCUMENT_SOURCES = ['invoice', 'purchase', 'purchase_pay', 'claim', 'claim_collect', 'contract_deposit',
  'deposit_refund', 'deposit_carry', 'deposit_deduct', 'deposit_deduct_move', 'reservation', 'reservation_convert', 'reservation_forfeit'];

/** خطوط القيد على حساب · موجبها مدين */
const net = (db: DB, entryId: string, account: string) => Number(db.get<{ s: number }>(
  `SELECT COALESCE(SUM(debit_halalas - credit_halalas), 0) AS s FROM journal_lines WHERE entry_id = ? AND account_code = ?`,
  [entryId, account])!.s);

/** حركات البنك المربوطة بالقيد برقمه · تُعكس بمثلها */
function reverseBankTx(db: DB, entryNo: string, date: string, descr: string): void {
  for (const t of db.all<{ bank_id: string; amount: number }>(
    `SELECT bank_id, amount_halalas AS amount FROM bank_tx WHERE journal_no = ? AND deleted_at IS NULL`, [entryNo])) {
    db.run(`INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
            VALUES (?,?,?,?,?,1,'',?,?)`, [uid(), t.bank_id, date, descr, -Number(t.amount), descr, new Date().toISOString()]);
  }
}

function reverse(db: DB, e: EntryRow, date: string, memo: string): void {
  if (!reverseEntryById(db, e.id, memo, date)) throw new RuleViolation('القيد ' + e.no + ' معكوس من قبل');
}

export function entrySourceAction(db: DB, entryId: string): SourceAction {
  const e = db.get<EntryRow>(`SELECT id, no, auto, src_type, src_id, status, reversed_by FROM journal_entries WHERE id = ?`, [entryId]);
  if (!e || e.status !== 'مرحّل' || e.reversed_by || !e.src_type || Number(e.auto) !== 1) return null;
  if (e.src_type.endsWith('_rev')) return null; // مرآة قيد · لا يُلغى المُلغي

  const pay = db.get<{ id: string }>(`SELECT id FROM contract_payments WHERE journal_entry_id = ? AND cancelled_at IS NULL`, [e.id]);
  if (pay) return { kind: 'payment', paymentId: pay.id };

  const op = (label: string, effects: string[], blockers: string[], run: (date: string, reason: string) => void): SourceAction =>
    ({ kind: 'op', label, effects, blockers, run: (date, reason) => {
      if (!reason.trim()) throw new RuleViolation('اكتب سبب الإلغاء');
      if (blockers.length) throw new RuleViolation(blockers.join(' · '));
      db.transaction(() => run(date, reason.trim()));
    } });

  if (e.src_type === DISCOUNT_ENTRY_SRC) {
    const amount = net(db, e.id, '4900');
    const p = db.get<{ id: string; kind: string | null }>(`SELECT id, discount_kind AS kind FROM contract_payments WHERE id = ?`, [e.src_id]);
    return op('إلغاء قيد الخصم', ['يُعكس القيد ' + e.no + ' (' + fmt(amount) + ')', p ? 'والدفعة ترجع خصماً بلا نوع كما قبل حجزه' : 'وخصم القسط يرجع إلى ما قبله'], [],
      (date, reason) => {
        if (p?.kind) db.run(`UPDATE contract_payments SET discount_kind = NULL WHERE id = ?`, [p.id]);
        reverse(db, e, date, 'إلغاء قيد خصم · ' + reason);
        logAudit(db, 'التحصيل', 'update', 'إلغاء قيد خصم', e.no + ' · ' + reason);
      });
  }

  if (e.src_type === 'cash_op') {
    const cashIn = net(db, e.id, '1100'); // ما أدخله القيد في المحفظة · عكسُه يُخرجه
    const blockers = cashIn > 0 && walletCashBalance(db) < cashIn ? ['النقد في المحفظة (' + fmt(walletCashBalance(db)) + ') لا يكفي لعكس ' + fmt(cashIn)] : [];
    return op('إلغاء العملية', ['يُعكس القيد ' + e.no], blockers, (date, reason) => {
      reverse(db, e, date, 'إلغاء عملية نقد · ' + reason);
      logAudit(db, 'النقد والبنوك', 'update', 'إلغاء عملية نقد', e.no + ' · ' + reason);
    });
  }

  if (e.src_type === 'key_money') {
    return op('إلغاء التقبيل', ['يُعكس قيد العمولة ' + e.no, 'وحركة البنك بمثلها إن كانت', 'والصفقة تدخل سلة المحذوفات'], [], (date, reason) => {
      reverse(db, e, date, 'إلغاء تقبيل · ' + reason);
      reverseBankTx(db, e.no, date, 'إلغاء عمولة تقبيل');
      db.run(`UPDATE key_money_deals SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), e.src_id]);
      logAudit(db, 'العقارات', 'delete', 'إلغاء تقبيل', e.no + ' · ' + reason);
    });
  }

  if (e.src_type === 'vat_refund') {
    return op('إلغاء الاسترداد', ['يُعكس القيد ' + e.no, 'وترجع الفاتورة «لم يُطلب»'], [], (date, reason) => {
      reverse(db, e, date, 'إلغاء استرداد ضريبة · ' + reason);
      db.run(`UPDATE purchases SET refund_status = 'لم يُطلب', refund_date = NULL WHERE id = ?`, [e.src_id]);
      logAudit(db, 'فواتير الشراء', 'update', 'إلغاء استرداد ضريبة', e.no + ' · ' + reason);
    });
  }

  if (e.src_type === 'surplus_refund' || e.src_type === 'surplus_credit') {
    const credit = e.src_type === 'surplus_credit' ? -net(db, e.id, '2410') : 0;
    const tenant = db.get<{ id: string; c: number }>(
      `SELECT t.id, t.credit_halalas AS c FROM tenants t JOIN contracts c ON c.tenant_id = t.id WHERE c.id = ?`, [e.src_id]);
    const blockers = credit > 0 && (!tenant || Number(tenant.c) < credit) ? ['الرصيد الدائن المحوَّل استُعمل منه · فلا يُطرح كاملاً'] : [];
    return op('إلغاء الرد', ['يُعكس القيد ' + e.no, credit > 0 ? 'ويُطرح ' + fmt(credit) + ' من رصيد المستأجر الدائن' : 'وحركة البنك بمثلها إن كانت', 'ويعود الفائض ظاهراً'],
      blockers, (date, reason) => {
        reverse(db, e, date, 'إلغاء ردّ فائض · ' + reason);
        reverseBankTx(db, e.no, date, 'إلغاء ردّ فائض');
        if (credit > 0 && tenant) db.run(`UPDATE tenants SET credit_halalas = credit_halalas - ? WHERE id = ?`, [credit, tenant.id]);
        logAudit(db, 'التحصيل', 'update', 'إلغاء ردّ فائض', e.no + ' · ' + reason);
      });
  }

  if (DOCUMENT_SOURCES.includes(e.src_type)) return { kind: 'document' };
  return null;
}
