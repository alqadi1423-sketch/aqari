/**
 * مدقق خارجي O · الجولة الثامنة · قيد المصدر للعملية النقدية في memberBankTxCheck (engine.ts) على e5e16f5 · بيانات مصطنعة.
 * «العملية النقدية لا حركة بنكٍ لها إلا الوارد البنكي والرسوم (حسابا 4300 و5400)» · والمصروف النثري نقداً (pettyCashExpense) سطوره
 * 5400 من 1100 كالرسوم البنكية حرفاً (post.ts: cashOpLines، الفرع الأخير للنوعين) · ولا فحص لرصيد البنك في حركة القيد.
 */
import { ownerCashIn, ownerCashOut, pettyCashExpense, CASH_DEPOSIT_SOURCE } from '@/domain/cashOps';
import { walletCashBalance, bankBalance } from '@/domain/accounting/ledger';
import { addBank } from './helpers/fixtures';
import { savePurchase, payPurchase, type PurchaseInput } from '@/domain/purchases';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { rejects, waiting, cash1100 } from './helpers/auditI';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';

let n = 0;
const tx = (s: { r: { inject: (d: RemoteDoc) => void } }, d: Record<string, unknown>): string => {
  const k = 'o-tx-' + (++n);
  s.r.inject({ id: 'bank_tx__' + k, t: 'bank_tx', k, u: new Date().toISOString(), dev: 'dev-o', by: MEMBER, op: 'banks', del: false,
    d: { id: k, date: '2026-10-05', descr: 'حركة مصطنعة O', matched: 1, created_at: new Date().toISOString(), deleted_at: null, ...d } } as RemoteDoc);
  return k;
};
const applied = (db: DB, k: string) => !!db.get(`SELECT 1 FROM bank_tx WHERE id = ? AND deleted_at IS NULL`, [k]);

async function setup(kind: 'petty' | 'ownerOut' | 'purchase') {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع O', 0);
  const B = addBank(s.owner, 'بنك ب مصطنع O', 0);
  // المالك: إيداعه نقداً في المحفظة ثم صرفه كله من المحفظة (مصروفاً نثرياً أو مسحوباتٍ له)
  ownerCashIn(s.owner, { amountHalalas: 300000, date: '2026-10-01' });
  if (kind === 'petty') pettyCashExpense(s.owner, { amountHalalas: 300000, descr: 'مصروف نثري للمالك مصطنع O', date: '2026-10-02' });
  else if (kind === 'ownerOut') ownerCashOut(s.owner, { amountHalalas: 300000, date: '2026-10-02' });
  else {
    // فاتورة شراءٍ سدّدها المالك نقداً من المحفظة (payment_method «نقداً»، بلا بنك)
    s.owner.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
      ['SUP-O2', 'مورد مصطنع O2', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
    const pid = savePurchase(s.owner, {
      supplier: 'مورد مصطنع O2', date: '2026-10-02', due: '2026-11-02', category: 'صيانة', incorpItem: '', amortize: false,
      amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: null, propertyId: null, meterId: null, meterReading: null,
      subtotalHalalas: 300000, taxHalalas: 0, totalHalalas: 300000,
    } as PurchaseInput);
    payPurchase(s.owner, pid, 'cash', null, '2026-10-02');
  }
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const no = s.owner.get<{ no: string }>(`SELECT e.no FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
    WHERE e.src_type = ? AND l.account_code = '1100' AND l.credit_halalas > 0`, [kind === 'purchase' ? 'purchase_pay' : 'cash_op'])!.no;
  return { ...s, A, B, no };
}

describe('مدقق O · حركة بنكٍ مزوَّرة برقم قيد مصروفٍ نثري (نقدٌ صُرف من المحفظة)', () => {
  test.each([['petty' as const, 'المصروف النثري (عملية نقدية فيها 5400)'], ['purchase' as const, 'سداد فاتورة شراءٍ نقداً (payment_method «نقداً»)']])('(O2 · %s) سحبٌ برقم قيدٍ صُرف نقده من المحفظة من بنكٍ فارغ ثم إيداع «نقده» في بنكٍ آخر: البنك سالب والمحفظة وبنكٌ آخر بمالٍ لا وجود له · %s', async (kind, _label) => {
    const s = await setup(kind);
    const base = [bankBalance(s.owner, s.A), bankBalance(s.owner, s.B), walletCashBalance(s.owner)];
    // ١) حركةٌ برقم قيد المصروف النثري: بإشارة نقده (سالبة) وفي حدّه، وقيده «عملية نقدية» فيها 5400
    const fee = tx(s, { bank_id: s.A, amount_halalas: -300000, journal_no: s.no, source: 'رسوم بنكية' });
    await ownerPulls(s.owner, s.r);
    const mid = [bankBalance(s.owner, s.A), bankBalance(s.owner, s.B), walletCashBalance(s.owner)];
    // ٢) و«النقد» الذي ظهر في المحفظة يُودع في بنك ب (بلا قيد · يمرّ بفحص المحفظة)
    const dep = tx(s, { bank_id: s.B, amount_halalas: 300000, journal_no: '', source: CASH_DEPOSIT_SOURCE });
    await ownerPulls(s.owner, s.r);
    const out = { base, mid, owner: [bankBalance(s.owner, s.A), bankBalance(s.owner, s.B), walletCashBalance(s.owner)], cash1100: cash1100(s.owner),
      feeApplied: applied(s.owner, fee), depApplied: applied(s.owner, dep), rejects: rejects(s.owner).map((r) => r.tbl + ': ' + r.reason),
      waiting: waiting(s.owner).map((w) => w.tbl) };
    // eslint-disable-next-line no-console
    console.log('O2', kind, JSON.stringify(out));
    expect(base).toEqual([0, 0, 0]);
    // كما في M1 (d4.auditM.jointly): لا ينزل بنكٌ تحت الصفر بحركةٍ لا مسار لها في التطبيق، ولا يظهر في المحفظة نقدٌ لا وجود له
    expect(out.feeApplied).toBe(false);
    expect(out.owner).toEqual(base);
    s.close();
  });

  test('(صمد) والحركة نفسها برقم «مسحوبات المالك» (3100 من 1100): تُرفض بقيد المصدر', async () => {
    const s = await setup('ownerOut');
    const fee = tx(s, { bank_id: s.A, amount_halalas: -300000, journal_no: s.no, source: 'رسوم بنكية' });
    await ownerPulls(s.owner, s.r);
    expect(applied(s.owner, fee)).toBe(false);
    expect([bankBalance(s.owner, s.A), walletCashBalance(s.owner)]).toEqual([0, 0]);
    s.close();
  });
});
