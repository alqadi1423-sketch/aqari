/**
 * حركة البنك لقيدٍ قبضه أو ردّه تحويلاً (المراجعة الشاملة 2026-11-13 · A1-6 · قرار المالك س١٧): التأمين والعربون كانا نقداً في المحفظة
 * دائماً · فالقيد على 1100 كما هو (النقدية والبنوك)، ومعه حركة بنكٍ برقمه تنقل أثره من المحفظة إلى البنك (walletCashBalance = 1100 ناقص
 * البنوك) · ورصيد البنك يكفي ما يخرج منه كسائر مخارجه، والمحفظة تكفي ما يخرج نقداً (cashGuard).
 */
import type { DB } from '../../db/adapter';
import { t } from '../../i18n';
import { uid } from '../ids';
import { fmt } from '../money';
import { bankBalance } from './ledger';

/** أعمدة بنك التأمين والعربون (الهجرة ٦٣) · قاعدةٌ أقدم (نسخةٌ تُفحص قبل ترقيتها، واختبارات الهجرات) تبقى نقداً بلا كتابةٍ فيها */
const bankCols = new WeakMap<object, boolean>();
export function hasDepositBankCols(db: DB): boolean {
  const k = db as unknown as object;
  let v = bankCols.get(k);
  if (v === undefined) {
    v = db.all<{ name: string }>(`PRAGMA table_info(reservations)`).some((c) => c.name === 'refund_bank_id');
    // لا يُحفظ «بلا أعمدة» · فالقاعدة نفسها قد تُرقّى بعده
    if (v) bankCols.set(k, v);
  }
  return v;
}

/** اسم البنك الحيّ أو رفضٌ برسالة · والخروج منه لا يتجاوز رصيده بعد ما يعود إليه في المعاملة نفسها (back) */
export function requireBankFor(db: DB, bankId: string, out = 0, back = 0): string {
  const b = db.get<{ name: string }>(`SELECT name FROM banks WHERE id = ? AND deleted_at IS NULL`, [bankId]);
  if (!b) throw new Error(t('depositBank.bankMissing'));
  if (out > 0) {
    const bal = bankBalance(db, bankId) + back;
    if (out > bal) throw new Error(t('bank.insufficient', { bank: b.name, balance: fmt(bal), amount: fmt(out) }));
  }
  return b.name;
}

/** حركة بنكٍ مطابَقة برقم قيدها · موجبةٌ للقبض وسالبةٌ للردّ */
export function linkBankTx(db: DB, a: { bankId: string; date: string; descr: string; amount: number; entryNo: string; source: string }): void {
  db.run(
    `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
     VALUES (?,?,?,?,?,1,?,?,?)`,
    [uid(), a.bankId, a.date, a.descr, a.amount, a.entryNo, a.source, new Date().toISOString()]);
}

/** مجموع حركات البنك الحيّة لقيدٍ برقمه، لكل بنك */
export function bankTxOf(db: DB, entryNo: string): Array<{ bankId: string; amount: number }> {
  return db.all<{ b: string; a: number }>(
    `SELECT bank_id AS b, SUM(amount_halalas) AS a FROM bank_tx WHERE journal_no = ? AND deleted_at IS NULL GROUP BY bank_id`, [entryNo])
    .map((r) => ({ bankId: r.b, amount: Number(r.a) || 0 })).filter((r) => r.amount !== 0);
}

/** قيدٌ عُكس: حركات بنكه تُعكس بمثلها برقم عاكسه وتاريخه، فيعود أثره إلى البنك الذي خرج منه أو دخله */
export function mirrorBankTxOfReversed(db: DB, entryId: string, descr: string): void {
  const e = db.get<{ no: string; rev: string | null }>(`SELECT no, reversed_by AS rev FROM journal_entries WHERE id = ?`, [entryId]);
  if (!e?.rev) return;
  const r = db.get<{ no: string; date: string }>(`SELECT no, date FROM journal_entries WHERE id = ?`, [e.rev]);
  if (!r || bankTxOf(db, r.no).length) return;
  for (const x of bankTxOf(db, e.no)) {
    linkBankTx(db, { bankId: x.bankId, date: r.date, descr, amount: -x.amount, entryNo: r.no, source: descr });
  }
}
