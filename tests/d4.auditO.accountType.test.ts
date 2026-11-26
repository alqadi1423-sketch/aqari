/**
 * مدقق خارجي O · الجولة الثامنة · حارس الافتتاحي لحسابات الدليل (engine.ts · applyOne، إصلاح M٧) على e5e16f5 · بيانات مصطنعة.
 * «افتتاحي 1100 من عضوٍ كان يُدخل المحفظة نقداً بلا قيد» · والمحفظة = accountBalance('1100') − حركات البنوك، وaccountBalance يقرأ
 * نوع الحساب (DEBIT_NORMAL_TYPES) وحذفه الناعم (getAccount: deleted_at IS NULL) من الصف نفسه، لا افتتاحيه وحده.
 */
import { withdrawCashFromBank, pettyCashExpense, CASH_DEPOSIT_SOURCE } from '@/domain/cashOps';
import { walletCashBalance, bankBalance } from '@/domain/accounting/ledger';
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { rejects, cash1100 } from './helpers/auditI';
import type { RemoteDoc } from '@/sync/types';

/** المالك: بنك أ بافتتاحيٍّ وضعه المالك، سحبه كله إلى المحفظة ثم صرفه نثرياً · فالمحفظة صفر وصافي 1100 في الدفتر سالب */
async function setup() {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع O', 100000);
  const B = addBank(s.owner, 'بنك ب مصطنع O', 0);
  withdrawCashFromBank(s.owner, { bankId: A, amountHalalas: 100000, date: '2026-10-01' });
  pettyCashExpense(s.owner, { amountHalalas: 100000, descr: 'مصروف المالك مصطنع O', date: '2026-10-02' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  return { ...s, A, B };
}

/** إيداعٌ نقدي من المحفظة إلى بنك (cashOps.depositCashToBank) بكاتبه العضو · بلا قيد */
const deposit = (s: Awaited<ReturnType<typeof setup>>, bank: string, amount: number): RemoteDoc => {
  const k = 'o-dep-' + bank + '-' + amount;
  const d: RemoteDoc = {
    id: 'bank_tx__' + k, t: 'bank_tx', k, u: new Date().toISOString(), dev: 'dev-o', by: MEMBER, op: 'banks', del: false,
    d: { id: k, bank_id: bank, date: '2026-10-05', descr: 'إيداع مصطنع O', amount_halalas: amount, matched: 0, journal_no: '',
      source: CASH_DEPOSIT_SOURCE, created_at: new Date().toISOString(), deleted_at: null },
  } as RemoteDoc;
  s.r.inject(d);
  return d;
};

const forgeAccount = (s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown>) => {
  const row = s.owner.get<Record<string, unknown>>(`SELECT * FROM accounts WHERE code = '1100'`)!;
  s.r.inject({ id: 'accounts__1100', t: 'accounts', k: '1100', d: { ...row, ...over } as never,
    u: new Date().toISOString(), dev: 'dev-o', del: false, by: MEMBER, op: 'ledger' } as RemoteDoc);
};

describe('مدقق O · الحساب 1100 من عضو بغير افتتاحيه', () => {
  test.each([
    ['نوعه «خصم» (دائن الطبيعة)', { type: 'خصم' }],
    ['حذفه الناعم (deleted_at)', { deleted_at: '2026-10-04T00:00:00.000Z' }],
  ])('(O1) عضوٌ بمسار «ledger» يغيّر %s ثم يودع «نقد المحفظة» في بنك: يقبله المالك فيظهر في البنك مالٌ لا وجود له', async (_l, over) => {
    const s = await setup();
    const base = { wallet: walletCashBalance(s.owner), A: bankBalance(s.owner, s.A), B: bankBalance(s.owner, s.B), cash1100: cash1100(s.owner) };
    forgeAccount(s, over);
    await ownerPulls(s.owner, s.r);
    const afterAcc = walletCashBalance(s.owner);
    deposit(s, s.B, afterAcc);
    await ownerPulls(s.owner, s.r);
    const out = {
      base, walletAfterAccount: afterAcc,
      owner: { wallet: walletCashBalance(s.owner), A: bankBalance(s.owner, s.A), B: bankBalance(s.owner, s.B), cash1100: cash1100(s.owner) },
      acc: s.owner.get(`SELECT type, deleted_at, opening_halalas FROM accounts WHERE code = '1100'`),
      rejects: rejects(s.owner).map((r) => r.tbl + ': ' + r.reason),
    };
    // eslint-disable-next-line no-console
    console.log('O1', JSON.stringify(out));
    // قبل التغيير: لا مال في بنكٍ ولا في المحفظة (افتتاحي أ سُحب وصُرف) · والدفتر لم يتغير فيه قيد
    expect(base).toEqual({ wallet: 0, A: 0, B: 0, cash1100: -100000 });
    // الحارس (M٧ · القاعدة ٩٩): مالٌ بلا قيد لا يدخل المحفظة ولا بنكاً من صفّ حسابٍ كتبه عضو
    expect(out.walletAfterAccount).toBe(0);
    expect(out.owner.B).toBe(0);
    s.close();
  });
});
