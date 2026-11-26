/**
 * مدقق خارجي (هـ) · الجولة الثالثة · memberBankTxCheck (engine.ts) · بيانات مصطنعة.
 * الحارس يسأل «هل لرقم القيد قيدٌ هنا» وحده: فحركةٌ بلا رقم قيد تُطبَّق بلا فحص، وحركةٌ ثانية برقم قيدٍ له حركته تُطبَّق كذلك · ورصيد
 * البنك (bankBalance) مجموع الحركات · وكل إدراجٍ لـ bank_tx في التطبيق يحمل رقم قيده، وحركةٌ واحدة لكل قيد.
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { confirmContract } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار بنك هـ مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'BE-A' });
  const ca = confirmContract(p.owner, contractInput(ua, { tenant: 'مستأجر بنك هـ مصطنع', idNumber: '1000000061', phone: '0555550061' }));
  const bank = addBank(p.owner, 'بنك هـ مصطنع');
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, ua, ca, bank };
}
async function legitDeal(s: Awaited<ReturnType<typeof setup>>) {
  recordKeyMoneyDeal(s.dev, { unitId: s.ua, contractId: s.ca, outgoing: 'متنازل بنك هـ', incoming: 'متنازل له بنك هـ',
    amountHalalas: 5000000, date: '2026-11-01', commissionHalalas: 230000, method: 'bank', bankId: s.bank, notes: '' });
  await sync(s.dev, s.r);
  const k = asMember(s.r, 'key_money');
  for (const d of [...s.r.docs.values()].filter((x) => x.t === 'bank_tx')) s.r.inject({ ...d, by: MEMBER, op: 'reservations' });
  await ownerPulls(s.owner, s.r);
  expect(has(s.owner, k)).toBe(true);
  expect(bankBalance(s.owner, s.bank)).toBe(230000);
  return [...s.r.docs.values()].find((x) => x.t === 'bank_tx')!;
}
const copyTx = (tx: RemoteDoc, k: string, over: Record<string, unknown>): RemoteDoc =>
  ({ ...tx, id: 'bank_tx__' + k, k, by: MEMBER, op: 'reservations', d: { ...tx.d, id: k, ...over } } as RemoteDoc);

describe('مدقق هـ · حركة البنك من عضو', () => {
  test('(أ) حركةٌ ثانية برقم قيدٍ له حركته: لا تُطبَّق', async () => {
    const s = await setup();
    const tx = await legitDeal(s);
    s.r.inject(copyTx(tx, 'tx-dup-e', { amount_halalas: 9900000 }));
    await ownerPulls(s.owner, s.r);
    const out = { owner: bankBalance(s.owner, s.bank), member: bankBalance(s.dev, s.bank),
      applied: !!s.owner.get(`SELECT 1 FROM bank_tx WHERE id = 'tx-dup-e'`) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(out.owner).toBe(230000);
    s.close();
  });

  test('(ب) حركةٌ بلا رقم قيد من عضو (لا مسار في التطبيق يكتبها): لا تُطبَّق', async () => {
    const s = await setup();
    const tx = await legitDeal(s);
    s.r.inject(copyTx(tx, 'tx-nono-e', { amount_halalas: 9900000, journal_no: '' }));
    s.r.inject(copyTx(tx, 'tx-null-e', { amount_halalas: 1100000, journal_no: null }));
    await ownerPulls(s.owner, s.r);
    const out = { owner: bankBalance(s.owner, s.bank), member: bankBalance(s.dev, s.bank) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(out.owner).toBe(230000);
    s.close();
  });
});
