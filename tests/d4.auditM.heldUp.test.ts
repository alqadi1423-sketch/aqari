/**
 * مدقق خارجي M · الجولة السابعة · ما صمد من حرّاس الجولة السادسة على 2cf6151 · بيانات مصطنعة.
 */
import { CASH_WITHDRAW_SOURCE, withdrawCashFromBank } from '@/domain/cashOps';
import { walletCashBalance, bankBalance } from '@/domain/accounting/ledger';
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { snap, newAsMember } from './helpers/auditI';
import type { RemoteDoc } from '@/sync/types';

test('(H1) بنك عضوٍ جديد بافتتاحيٍّ ٣٠٠٠ وسحبٌ منه في الرفع نفسه: البنك بصفر، والسحب لا يُطبَّق، والسحابة بنسخة المالك', async () => {
  const s = await pair();
  const T = addBank(s.owner, 'بنك قالب مصطنع M', 100000);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const since = snap(s.r);
  withdrawCashFromBank(s.dev, { bankId: T, amountHalalas: 100000, date: '2026-10-01' });
  await sync(s.dev, s.r);
  const [tx] = newAsMember(s.r, since).filter((d) => d.t === 'bank_tx');
  const b = s.r.docs.get('banks__' + T)!;
  const Z = 'bank-m-h1';
  // وقاعدة السحابة ترفض بنك العضو الجديد بافتتاحيٍّ غير صفر (openingKept · المدقق الخارجي O٥)، فلا يصل والسحب منه ينتظر
  const w = await s.r.write([{ ...b, id: 'banks__' + Z, k: Z, by: MEMBER, op: 'banks', d: { ...b.d, id: Z, name: 'بنك عضو مصطنع H1', opening_halalas: 300000 } } as RemoteDoc]);
  expect(w[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  s.r.inject({ ...tx, id: 'bank_tx__h1-w', k: 'h1-w', d: { ...tx.d, id: 'h1-w', bank_id: Z, amount_halalas: -100000, source: CASH_WITHDRAW_SOURCE } } as RemoteDoc);
  await ownerPulls(s.owner, s.r);
  const out = { z: bankBalance(s.owner, Z), wallet: walletCashBalance(s.owner), w: !!s.owner.get(`SELECT 1 FROM bank_tx WHERE id = 'h1-w'`),
    cloud: Number(s.r.docs.get('banks__' + Z)?.d?.opening_halalas ?? 0) };
  // eslint-disable-next-line no-console
  console.log('H1', JSON.stringify(out));
  expect(out).toEqual({ z: 0, wallet: 100000, w: false, cloud: 0 });
  s.close();
});

test('(H2) تعديل العضو لافتتاحي بنكٍ قائم يُرفض وتعود نسخة المالك إلى السحابة', async () => {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع M', 50000);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const b = s.r.docs.get('banks__' + A)!;
  // وقاعدة السحابة ترفضه (openingKept · المدقق الخارجي O٥): لا يصل جهاز المالك، والسحابة بنسخة المالك
  const w = await s.r.write([{ ...b, by: MEMBER, op: 'banks', d: { ...b.d, name: 'اسم جديد مصطنع', opening_halalas: 900000 } } as RemoteDoc]);
  expect(w[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  await ownerPulls(s.owner, s.r);
  const out = { a: bankBalance(s.owner, A), cloud: Number(s.r.docs.get('banks__' + A)!.d!.opening_halalas) };
  // eslint-disable-next-line no-console
  console.log('H2', JSON.stringify(out));
  expect(out).toEqual({ a: 50000, cloud: 50000 });
  s.close();
});
