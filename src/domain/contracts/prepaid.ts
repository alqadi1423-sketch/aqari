/**
 * ردّ الإيجار المقدَّم عند الإنهاء المبكر (المراجعة الشاملة 2026-11-13 · A1-4 · قرار المالك س١٦).
 *
 * يُسأل عند إلغاء العقد عمّا قُبض عن مدةٍ بعد الإنهاء: «يُحتفظ به» (الافتراضي) فيُحسب إيراداً يوم الإنهاء في أساس الاستحقاق
 * (accrual.ts · prepaidExtras) بلا قيد، أو «يُردّ» للمستأجر بقيدٍ على نمط ردّ الفائض (settleSurplus):
 *   مدين إيراد العقد بتقسيمه (rentRevenueLines) · دائن النقدية والبنوك 1100 · وحركة بنكية سالبة إن كان تحويلاً.
 * فالاختيار يحمله القيد نفسه: لا عمود له في العقد ولا هجرة (وجود قيد الردّ هو «يُردّ»، وغيابه «يُحتفظ به»).
 * والسقف ما قبضه المكتب فوق ما يكتسبه العقد حتى يوم إلغائه (prepaidUnearned) · والردّ للمالك وحده: لا يظهر خياره لعضو، وقيدٌ
 * بمصدره من جهاز عضو يرفضه جهاز المالك (sync/engine.ts · OWNER_ONLY_SOURCES).
 */
import type { DB } from '../../db/adapter';
import { t } from '../../i18n';
import { uid } from '../ids';
import { fmt } from '../money';
import { logAudit } from '../audit';
import { requireCash } from '../cashGuard';
import { requireOpenPeriod } from '../vatFilings';
import { postEntry, type PostedEntry } from '../accounting/post';
import { bankBalance } from '../accounting/ledger';
import { rentRevenueLines } from '../accounting/rentSplit';
import { prepaidUnearned } from '../accrual';

/** مصدر قيد ردّ الإيجار المقدَّم · مربوطٌ بالعقد */
export const PREPAID_REFUND_SRC = 'prepaid_refund';

export interface PrepaidRefundInput {
  amountHalalas: number;
  date: string;
  /** نقداً من المحفظة أو تحويلاً من حساب بنكي */
  method: 'cash' | 'bank';
  bankId?: string | null;
}

/** يرحّل ردّ الإيجار المقدَّم لعقدٍ ملغى · يُستدعى داخل معاملة الإلغاء بعد كتابة تاريخه (cancelContract) */
export function refundPrepaidRent(db: DB, contractId: string, input: PrepaidRefundInput): PostedEntry {
  const c = db.get<{ contract_no: string | null; tenant_name: string; status: string }>(
    `SELECT contract_no, tenant_name, status FROM contracts WHERE id = ?`, [contractId]);
  if (!c) throw new Error(t('prepaid.noContract'));
  const amount = Math.round(Number(input.amountHalalas) || 0);
  if (amount <= 0) throw new Error(t('prepaid.amountRequired'));
  const max = prepaidUnearned(db, contractId);
  if (amount > max) throw new Error(t('prepaid.over', { amount: fmt(amount), max: fmt(max) }));
  requireOpenPeriod(db, input.date);
  if (input.method !== 'cash' && input.method !== 'bank') throw new Error(t('prepaid.methodRequired'));
  let bankName = '';
  if (input.method === 'bank') {
    if (!input.bankId) throw new Error(t('prepaid.bankRequired'));
    const b = db.get<{ name: string }>(`SELECT name FROM banks WHERE id = ? AND deleted_at IS NULL`, [input.bankId]);
    if (!b) throw new Error(t('prepaid.bankMissing'));
    bankName = b.name;
    const bal = bankBalance(db, input.bankId);
    if (amount > bal) throw new Error(t('bank.insufficient', { bank: b.name, balance: fmt(bal), amount: fmt(amount) }));
  } else {
    requireCash(db, amount, t('prepaid.cashWhat', { lng: 'ar' }));
  }
  const who = t('prepaid.who', { tenant: c.tenant_name, no: c.contract_no || '', lng: 'ar' });
  const how = input.method === 'bank' ? t('prepaid.viaBank', { bank: bankName, lng: 'ar' }) : t('prepaid.viaCash', { lng: 'ar' });
  const entry = postEntry(db, {
    date: input.date,
    memo: t('prepaid.memo', { who, how, lng: 'ar' }),
    lines: [
      ...rentRevenueLines(db, contractId, amount, t('prepaid.lineRevenue', { lng: 'ar' }), 'debit'),
      { account: '1100', descr: t(input.method === 'bank' ? 'prepaid.lineBank' : 'prepaid.lineCash', { lng: 'ar' }), debit: 0, credit: amount },
    ],
    srcType: PREPAID_REFUND_SRC,
    srcId: contractId,
  })!;
  if (input.method === 'bank') {
    const descr = t('prepaid.bankTx', { who, lng: 'ar' });
    db.run(
      `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
       VALUES (?,?,?,?,?,1,?,?,?)`,
      [uid(), input.bankId!, input.date, descr, -amount, entry.no, t('prepaid.audit', { lng: 'ar' }), new Date().toISOString()]);
  }
  logAudit(db, 'العقود', 'create', t('prepaid.audit', { lng: 'ar' }), // i18n-exempt: قسم السجل المخزَّن
    `${who}: ${fmt(amount)} · ${entry.no} · ${how}`, { prepaid_halalas: max }, { prepaid_halalas: max - amount, journal_no: entry.no });
  return entry;
}
