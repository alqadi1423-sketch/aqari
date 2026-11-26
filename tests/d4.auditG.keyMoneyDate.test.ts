/**
 * مدقق خارجي (G) · الجولة الرابعة · تاريخ قيد عمولة التقبيل (deriveSources.ts · key_money · also: revDates + pendingRev) · بيانات مصطنعة.
 * إصلاح هـ٢ يقبل تاريخ العاكس المعلَّق إن سمّاه أصلٌ من الصفقة مرآةً له · لكن الأصل نفسه يكتبه العضو: قيد «key_money» يصل معكوساً
 * (reversedIssue) يُقبل بلا مطابقة مستنده، وعاكسه المرآة يُقبل بعده (memberReversalCheck) · فإذا طُبِّقا صار تاريخ العاكس من revDates ·
 * فزوجٌ مزوَّر صافيه صفر بتاريخٍ يختاره العضو يُجيز قيد الصفقة الحي بذلك التاريخ (سنةٌ أو ربعٌ آخر).
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { confirmContract } from '@/domain/contracts/service';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, has, reasonOf, net, srcAsMember, forge, mirrorOf, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';

test('مدقق G · (K1) قيد عمولة صفقةٍ حيّة (2026-11-01) بتاريخ 2027-01-10 ومعه أصلٌ وعاكسٌ مزوَّران بذلك التاريخ: يُرفض القيد', async () => {
  const s = await pair();
  const pa = addProperty(s.owner, { name: 'عقار تقبيل G مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'KG-A' });
  const ca = confirmContract(s.owner, contractInput(ua, { tenant: 'مستأجر تقبيل G مصطنع', idNumber: '1000000071', phone: '0555550071' }));
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const id = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: ca, outgoing: 'متنازل G', incoming: 'متنازل له G', amountHalalas: 5000000,
    date: '2026-11-01', commissionHalalas: 230000, method: 'cash', bankId: null, notes: '' });
  const e0 = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [id])!.id;
  await sync(s.dev, s.r);
  srcAsMember(s.r, /^key_money$/);
  for (const d of [...s.r.docs.values()].filter((x) => x.t === 'key_money_deals')) s.r.inject({ ...d, by: MEMBER });
  const orig = s.r.docs.get('journal_entries__' + e0)!;
  // القيد الحي بتاريخٍ غير تاريخ الصفقة
  s.r.inject({ ...orig, by: MEMBER, d: { ...orig.d, date: '2027-01-10' } } as RemoteDoc);
  // وزوجٌ مزوَّر صافيه صفر: أصلٌ «key_money» للصفقة نفسها يصل معكوساً، وعاكسه مرآته · كلاهما بالتاريخ المختار
  const rev = forge(orig, { src_type: 'key_money_rev', lines: mirrorOf(orig.lines!) });
  const o2 = forge(orig, { src_type: 'key_money', reversed_by: rev.k, lines: orig.lines! });
  s.r.inject({ ...o2, d: { ...o2.d, date: '2027-01-10' } } as RemoteDoc);
  s.r.inject({ ...rev, op: 'reservations', d: { ...rev.d, date: '2027-01-10' } } as RemoteDoc);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const out = {
    e0: [has(s.owner, e0), reasonOf(s.owner, e0).slice(0, 70)], e0Date: s.owner.get<{ date: string }>(`SELECT date FROM journal_entries WHERE id = ?`, [e0])?.date,
    o2: [has(s.owner, o2.k), reasonOf(s.owner, o2.k).slice(0, 50)], rev: [has(s.owner, rev.k), reasonOf(s.owner, rev.k).slice(0, 50)],
    dealDate: s.owner.get<{ date: string }>(`SELECT date FROM key_money_deals WHERE id = ?`, [id])?.date,
    rev4300in2026: net(s.owner, '4300', 'e.date < ?', ['2027-01-01']), rev4300in2027: net(s.owner, '4300', 'e.date >= ?', ['2027-01-01']),
    member4300in2026: net(s.dev, '4300', 'e.date < ?', ['2027-01-01']),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out));
  // عمولة صفقةٍ تاريخها 2026-11-01 لا تُقيَّد إيراداً في 2027
  expect(out.rev4300in2027).toBe(0);
  expect(has(s.owner, e0)).toBe(false);
  s.close();
});
