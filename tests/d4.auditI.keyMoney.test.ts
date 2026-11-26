/**
 * مدقق خارجي (I) · الجولة الخامسة · تاريخ قيد عمولة التقبيل (deriveSources.ts · keyMoneyDates · إصلاح K١) على 662e4ae · بيانات مصطنعة.
 * السلسلة من تاريخ الصفقة تحسب أصلاً في الوارد (r.pending) وعاكسَه في الوارد · ولا تسأل هل سيُطبَّقان: زوجٌ مزوَّر سطوره مشوَّهة
 * (سطرٌ فيه حقلٌ كائن · linesMalformed يرفضه حين يُفحص) يُجيز القيد الحي بتاريخه ثم يُرفض هو وحده، فيبقى الإيراد منقولاً إلى فترةٍ أخرى.
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { confirmContract } from '@/domain/contracts/service';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, has, reasonOf, net, srcAsMember, forge, mirrorOf, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';

test('مدقق I · (K1b) قيد عمولة صفقة 2026-11-01 بتاريخ 2027-01-10، وأصلٌ وعاكسٌ مزوَّران مشوَّها السطور بعده في الوارد: يُقبل القيد', async () => {
  const s = await pair();
  const pa = addProperty(s.owner, { name: 'عقار تقبيل I مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'KI-B' });
  const ca = confirmContract(s.owner, contractInput(ua, { tenant: 'مستأجر تقبيل I مصطنع', idNumber: '1000000072', phone: '0555550072' }));
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const id = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: ca, outgoing: 'متنازل I', incoming: 'متنازل له I', amountHalalas: 5000000,
    date: '2026-11-01', commissionHalalas: 230000, method: 'cash', bankId: null, notes: '' });
  const e0 = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [id])!.id;
  await sync(s.dev, s.r);
  srcAsMember(s.r, /^key_money$/);
  for (const d of [...s.r.docs.values()].filter((x) => x.t === 'key_money_deals')) s.r.inject({ ...d, by: MEMBER });
  const orig = s.r.docs.get('journal_entries__' + e0)!;
  // القيد الحي بتاريخٍ غير تاريخ الصفقة
  s.r.inject({ ...orig, by: MEMBER, d: { ...orig.d, date: '2027-01-10' } } as RemoteDoc);
  // ثم (وقت خادمٍ أحدث) أصلٌ «key_money» بتاريخ الصفقة ومبالغها يصل معكوساً، وعاكسه مرآته بالتاريخ المختار · في سطرٍ من كلٍّ حقلٌ كائن
  const bad = (ls: NonNullable<RemoteDoc['lines']>) => ls.map((l, i) => (i === 0 ? { ...l, note: { x: 1 } } : l)) as never;
  const rev = forge(orig, { k: 'zz-i-rev', src_type: 'key_money_rev', lines: mirrorOf(orig.lines!) });
  const o2 = forge(orig, { k: 'zz-i-o2', src_type: 'key_money', reversed_by: rev.k, lines: orig.lines! });
  s.r.inject({ ...o2, lines: bad(o2.lines!), d: { ...o2.d, date: '2026-11-01' } } as RemoteDoc);
  s.r.inject({ ...rev, op: 'reservations', lines: bad(rev.lines!), d: { ...rev.d, date: '2027-01-10' } } as RemoteDoc);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const out = {
    e0: [has(s.owner, e0), reasonOf(s.owner, e0).slice(0, 70)], e0Date: s.owner.get<{ date: string }>(`SELECT date FROM journal_entries WHERE id = ?`, [e0])?.date,
    o2: [has(s.owner, o2.k), reasonOf(s.owner, o2.k).slice(0, 50)], rev: [has(s.owner, rev.k), reasonOf(s.owner, rev.k).slice(0, 50)],
    rev4300in2026: net(s.owner, '4300', 'e.date < ?', ['2027-01-01']), rev4300in2027: net(s.owner, '4300', 'e.date >= ?', ['2027-01-01']),
  };
  // eslint-disable-next-line no-console
  console.log('K1b', JSON.stringify(out));
  // عمولة صفقةٍ تاريخها 2026-11-01 لا تُقيَّد إيراداً في 2027
  expect(out.rev4300in2027).toBe(0);
  s.close();
});

test('مدقق I · (K1c) أصلٌ مزوَّر معكوس يُطبَّق أولاً، ثم القيد الحي بتاريخ العاكس وعاكسٌ مشوَّه السطور بعده: يُقبل القيد؟', async () => {
  const s = await pair();
  const pa = addProperty(s.owner, { name: 'عقار تقبيل I ج مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'KI-C' });
  const ca = confirmContract(s.owner, contractInput(ua, { tenant: 'مستأجر تقبيل I ج مصطنع', idNumber: '1000000073', phone: '0555550073' }));
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const id = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: ca, outgoing: 'متنازل I', incoming: 'متنازل له I', amountHalalas: 5000000,
    date: '2026-11-01', commissionHalalas: 230000, method: 'cash', bankId: null, notes: '' });
  const e0 = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [id])!.id;
  await sync(s.dev, s.r);
  srcAsMember(s.r, /^key_money$/);
  for (const d of [...s.r.docs.values()].filter((x) => x.t === 'key_money_deals')) s.r.inject({ ...d, by: MEMBER });
  const orig = s.r.docs.get('journal_entries__' + e0)!;
  const held = { ...orig } as RemoteDoc & { ts?: string };
  s.r.docs.delete(orig.id);
  await ownerPulls(s.owner, s.r);
  const rev = forge(orig, { k: 'zz-i-rev-c', src_type: 'key_money_rev', lines: mirrorOf(orig.lines!) });
  const o2 = forge(orig, { k: 'zz-i-o2-c', src_type: 'key_money', reversed_by: rev.k, lines: orig.lines! });
  s.r.inject({ ...o2, d: { ...o2.d, date: '2026-11-01' } } as RemoteDoc);
  await ownerPulls(s.owner, s.r);
  const mid = { o2: [has(s.owner, o2.k), reasonOf(s.owner, o2.k).slice(0, 50)], waiting: s.owner.all(`SELECT pk, last_error FROM sync_inbox`) };
  const { ts: _t, ...h } = held;
  s.r.inject({ ...h, by: MEMBER, d: { ...h.d, date: '2027-01-10' } } as RemoteDoc);
  const bad = (ls: NonNullable<RemoteDoc['lines']>) => ls.map((l, i) => (i === 0 ? { ...l, note: { x: 1 } } : l)) as never;
  s.r.inject({ ...rev, op: 'reservations', lines: bad(rev.lines!), d: { ...rev.d, date: '2027-01-10' } } as RemoteDoc);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const out = {
    mid, e0: [has(s.owner, e0), reasonOf(s.owner, e0).slice(0, 70)],
    o2: [has(s.owner, o2.k), reasonOf(s.owner, o2.k).slice(0, 50)], rev: [has(s.owner, rev.k), reasonOf(s.owner, rev.k).slice(0, 50)],
    rev4300in2026: net(s.owner, '4300', 'e.date < ?', ['2027-01-01']), rev4300in2027: net(s.owner, '4300', 'e.date >= ?', ['2027-01-01']),
  };
  // eslint-disable-next-line no-console
  console.log('K1c', JSON.stringify(out));
  expect(out.rev4300in2027).toBe(0);
  s.close();
});

test.each([['سطرٌ null في سطوره (هـ٨)', 'null'], ['سطرٌ فيه حقلٌ كائن (M١)', 'object']])(
  'مدقق I · (K2) صفقةٌ قُيِّدت عمولتها، ثم أصلٌ مزوَّر لها يصل معكوساً وعاكسه في الوارد مشوَّه (%s): يُطبَّق الأصل ويُرفض العاكس', async (_l, kind) => {
  const s = await pair();
  const pa = addProperty(s.owner, { name: 'عقار تقبيل I د مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'KI-D' });
  const ca = confirmContract(s.owner, contractInput(ua, { tenant: 'مستأجر تقبيل I د مصطنع', idNumber: '1000000074', phone: '0555550074' }));
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const id = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: ca, outgoing: 'متنازل I', incoming: 'متنازل له I', amountHalalas: 5000000,
    date: '2026-11-01', commissionHalalas: 230000, method: 'cash', bankId: null, notes: '' });
  const e0 = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [id])!.id;
  await sync(s.dev, s.r);
  srcAsMember(s.r, /^key_money$/);
  for (const d of [...s.r.docs.values()].filter((x) => x.t === 'key_money_deals')) s.r.inject({ ...d, by: MEMBER });
  await ownerPulls(s.owner, s.r);
  const before = { e0: has(s.owner, e0), cash: net(s.owner, '1100'), rev4300: net(s.owner, '4300') };
  const orig = s.r.docs.get('journal_entries__' + e0)!;
  const rev = forge(orig, { k: 'zz-k2-rev-' + kind, src_type: 'key_money_rev', lines: mirrorOf(orig.lines!) });
  const o2 = forge(orig, { k: 'zz-k2-o2-' + kind, src_type: 'key_money', reversed_by: rev.k, lines: orig.lines! });
  s.r.inject(o2);
  const badLines = kind === 'null' ? [...rev.lines!, null] : rev.lines!.map((l, i) => (i === 0 ? { ...l, note: { x: 1 } } : l));
  s.r.inject({ ...rev, op: 'reservations', lines: badLines as never });
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const out = {
    before, e0: has(s.owner, e0), o2: [has(s.owner, o2.k), reasonOf(s.owner, o2.k).slice(0, 50)], rev: [has(s.owner, rev.k), reasonOf(s.owner, rev.k).slice(0, 50)],
    o2ReversedBy: s.owner.get<{ r: string | null }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [o2.k])?.r ?? null,
    cash: net(s.owner, '1100'), rev4300: net(s.owner, '4300'), member1100: net(s.dev, '1100'),
  };
  // eslint-disable-next-line no-console
  console.log('K2', kind, JSON.stringify(out));
  // عمولة الصفقة مرةً واحدة في الدفتر، ونقدها مرةً واحدة
  expect(out.cash).toBe(before.cash);
  expect(out.rev4300).toBe(before.rev4300);
  s.close();
});

test('مدقق I · (K2b) الأصل المزوَّر المعكوس بخمسين ضعف العمولة (حسابات المصدر وحدها تُفحص) وعاكسه مشوَّه: نقدٌ وإيراد بلا مستند', async () => {
  const s = await pair();
  const pa = addProperty(s.owner, { name: 'عقار تقبيل I هـ مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'KI-E' });
  const ca = confirmContract(s.owner, contractInput(ua, { tenant: 'مستأجر تقبيل I هـ مصطنع', idNumber: '1000000075', phone: '0555550075' }));
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const id = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: ca, outgoing: 'متنازل I', incoming: 'متنازل له I', amountHalalas: 5000000,
    date: '2026-11-01', commissionHalalas: 230000, method: 'cash', bankId: null, notes: '' });
  const e0 = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [id])!.id;
  await sync(s.dev, s.r);
  srcAsMember(s.r, /^key_money$/);
  for (const d of [...s.r.docs.values()].filter((x) => x.t === 'key_money_deals')) s.r.inject({ ...d, by: MEMBER });
  await ownerPulls(s.owner, s.r);
  const before = { cash: net(s.owner, '1100'), rev4300: net(s.owner, '4300') };
  const orig = s.r.docs.get('journal_entries__' + e0)!;
  const x50 = orig.lines!.map((l) => ({ ...l, debit_halalas: Number(l.debit_halalas) * 50, credit_halalas: Number(l.credit_halalas) * 50 }));
  const rev = forge(orig, { k: 'zz-k2b-rev', src_type: 'key_money_rev', lines: mirrorOf(x50) });
  const o2 = forge(orig, { k: 'zz-k2b-o2', src_type: 'key_money', reversed_by: rev.k, lines: x50 });
  s.r.inject(o2);
  s.r.inject({ ...rev, op: 'reservations', lines: [...rev.lines!, null] as never });
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const out = { before, o2: has(s.owner, o2.k), rev: reasonOf(s.owner, rev.k).slice(0, 40), cash: net(s.owner, '1100'), rev4300: net(s.owner, '4300') };
  // eslint-disable-next-line no-console
  console.log('K2b', JSON.stringify(out));
  expect(out.cash).toBe(before.cash);
  s.close();
});
