/**
 * مدقق خارجي K · الجولة السادسة · ما صمد (اختباراتٌ ناجحة) · بيانات مصطنعة.
 */
import { ownerCashIn, pettyCashExpense, transferBetweenBanks } from '@/domain/cashOps';
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls } from './helpers/rederive';
import { snap, newAsMember, bal, rejects, waiting } from './helpers/auditI';

test('(صمد) تحويلاتٌ متطابقة البيان والتاريخ والمبلغ (أ←ب مرتين وب←أ) والمحفظة عند المالك سالبة بالصرف المتزامن (L٥): تُقرن كلها وتصل', async () => {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع K', 300000);
  const B = addBank(s.owner, 'بنك ب مصطنع K', 0);
  ownerCashIn(s.owner, { amountHalalas: 50000, date: '2026-10-01' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  pettyCashExpense(s.owner, { amountHalalas: 50000, descr: 'مصروف المالك مصطنع K', date: '2026-10-02' });
  const since = snap(s.r);
  pettyCashExpense(s.dev, { amountHalalas: 50000, descr: 'مصروف العضو مصطنع K', date: '2026-10-02' });
  for (const [f, t] of [[A, B], [A, B], [B, A]]) {
    transferBetweenBanks(s.dev, { fromBankId: f, toBankId: t, amountHalalas: 100000, date: '2026-10-03', notes: 'تحويل متكرر مصطنع' });
  }
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  await sync(s.dev, s.r);
  const out = { owner: bal(s.owner, [A, B]), member: bal(s.dev, [A, B]), rejects: rejects(s.owner), waiting: waiting(s.owner) };
  // eslint-disable-next-line no-console
  console.log('held', JSON.stringify(out));
  expect(out.owner).toEqual(out.member);
  expect(out.rejects).toEqual([]);
  expect(out.waiting).toEqual([]);
  s.close();
});
