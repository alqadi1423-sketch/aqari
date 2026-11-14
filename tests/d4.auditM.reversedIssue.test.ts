/**
 * مدقق خارجي M · الجولة السابعة · reversedIssue (deriveSources.ts) بعد K١ على 2cf6151 · بيانات مصطنعة.
 * أصلٌ مزوَّر «يصل معكوساً» يسمّي عاكساً مشروعاً طُبِّق هنا: هل يُقبل فيُستولى على العاكس ويعود أصله حياً؟
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { restoreFromTrash } from '@/domain/trash';
import { addBank, addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER, has, net } from './helpers/rederive';
import { snap, newAsMember, bal } from './helpers/auditI';
import type { RemoteDoc } from '@/sync/types';

async function run(order: string[], target: 'r1' | 'r2', settleFirst = false) {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع M', 0);
  const pa = addProperty(s.owner, { name: 'عقار تقبيل M مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'MR-1' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const since = snap(s.r);
  const deal = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: null, outgoing: 'متنازل M', incoming: 'متنازل له M', amountHalalas: 5000000,
    date: '2026-06-01', commissionHalalas: 230000, method: 'bank', bankId: A, notes: '' });
  const cur = () => s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [deal])!.id;
  const e1 = cur();
  (entrySourceAction(s.dev, e1) as { kind: 'op'; run: (d: string, r: string) => void }).run('2026-08-15', 'سبب مصطنع');
  restoreFromTrash(s.dev, 'key_money_deals', deal);
  const e2 = cur();
  (entrySourceAction(s.dev, e2) as { kind: 'op'; run: (d: string, r: string) => void }).run('2026-10-20', 'سبب مصطنع ٢');
  restoreFromTrash(s.dev, 'key_money_deals', deal);
  const e3 = cur();
  const rev = (e: string) => s.dev.get<{ id: string }>(`SELECT reversed_by AS id FROM journal_entries WHERE id = ?`, [e])!.id;
  const ids: Record<string, string> = { e1, r1: rev(e1), e2, r2: rev(e2), e3 };
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  for (const n of order) s.r.inject(s.r.docs.get('journal_entries__' + ids[n])!);
  if (settleFirst) { await ownerPulls(s.owner, s.r); await ownerPulls(s.owner, s.r); }
  const settled = { owner: bal(s.owner, [A]), rejects: s.owner.all<{ pk: string; reason: string }>(`SELECT pk, reason FROM sync_rejects`)
    .map((x) => (Object.entries(ids).find(([, v]) => v === x.pk)?.[0] ?? x.pk) + ': ' + x.reason) };
  // والمزوَّر: نسخةٌ من الأصل المعكوس بمعرّفٍ ورقمٍ وسطورٍ جديدة، تسمّي العاكس المشروع
  const src = s.r.docs.get('journal_entries__' + (target === 'r1' ? e1 : e2))!;
  const k = 'm9-forged-' + target;
  s.r.inject({ ...src, id: 'journal_entries__' + k, k, by: MEMBER, op: 'reservations',
    d: { ...src.d, id: k, no: 'FG-M9-' + target, reversed_by: ids[target] },
    lines: (src.lines ?? []).map((l, i) => ({ ...l, id: k + '-l' + i, entry_id: k })) } as RemoteDoc);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const out = { order: order.join(','), target, settled, rejects: s.owner.all<{ pk: string; reason: string }>(`SELECT pk, reason FROM sync_rejects`)
    .map((x) => (Object.entries(ids).find(([, v]) => v === x.pk)?.[0] ?? x.pk) + ': ' + x.reason), forged: has(s.owner, k), owner: bal(s.owner, [A]), member: bal(s.dev, [A]),
    rev4: net(s.owner, '4500') - net(s.dev, '4500'), links: s.owner.all<{ id: string; r: string | null }>(`SELECT id, reversed_by AS r FROM journal_entries WHERE src_type = 'key_money'`)
      .map((x) => (Object.entries(ids).find(([, v]) => v === x.id)?.[0] ?? x.id) + '←' + (Object.entries(ids).find(([, v]) => v === x.r)?.[0] ?? x.r)) };
  s.close();
  return out;
}
const perms = (a: string[]): string[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));

// حدٌّ معروف موثَّق (DESIGN §١٣.١٨ هـ): الأصل الواصل معكوساً يُقبل بحساباته، فأصلٌ مزوَّر بسطور المشروع نفسها يسمّي عاكسه لا يُميَّز منه
// على جهاز المالك (وكل «شاهدٍ» يُرجَّح به يُزوَّر مثله) · يُعالج بسجل نسخ المستند في القسم ٥ · test.failing يسقط حين يُصلح فيُذكَّر به
test.failing('(M9) الترتيب الطبيعي e1 r1 e2 r2 e3 ومعها أصلٌ مزوَّر يسمّي r1: يُرفض الأصل المشروع e1 ويُقبل المزوَّر مكانه، وتسقط حركة البنك', async () => {
  const out = await run(['e1', 'r1', 'e2', 'r2', 'e3'], 'r1');
  // eslint-disable-next-line no-console
  console.log('M9', JSON.stringify(out));
  expect(out.forged).toBe(false);
  expect(out.owner).toEqual(out.member);
});

test.failing('(M9 مسح) في كل ترتيبٍ لوصول القيود الخمسة، والمزوَّر يسمّي r1 أو r2', async () => {
  const bad: unknown[] = [];
  for (const target of ['r1', 'r2'] as const) {
    for (const p of perms(['e1', 'r1', 'e2', 'r2', 'e3'])) {
      const out = await run(p, target);
      if (out.forged || JSON.stringify(out.owner) !== JSON.stringify(out.member)) bad.push(out);
    }
  }
  // eslint-disable-next-line no-console
  console.log('M9', bad.length, JSON.stringify(bad.slice(0, 4)));
  expect(bad).toEqual([]);
}, 900000);

test('(M9ب) والقيود المشروعة مستقرةٌ عند المالك قبله: أصلٌ مزوَّر يسمّي عاكساً طُبِّق لا يُقبل', async () => {
  const bad: unknown[] = [];
  for (const target of ['r1', 'r2'] as const) {
    for (const p of [['e1', 'r1', 'e2', 'r2', 'e3'], ['r1', 'e1', 'e3', 'r2', 'e2'], ['e3', 'r2', 'e2', 'r1', 'e1']]) {
      const out = await run(p, target, true);
      if (out.forged || JSON.stringify(out.owner) !== JSON.stringify(out.member)) bad.push(out);
    }
  }
  // eslint-disable-next-line no-console
  console.log('M9b', bad.length, JSON.stringify(bad.slice(0, 2)));
  expect(bad).toEqual([]);
}, 900000);
