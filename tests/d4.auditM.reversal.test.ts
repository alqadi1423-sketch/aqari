/**
 * مدقق خارجي M · الجولة السابعة · انتظار العاكس في memberReversalCheck (engine.ts) على 2cf6151 · بيانات مصطنعة.
 * «أصلٌ في الوارد يسمّي هذا العاكس يُنتظر قبل أي تخمين» ولا يُسأل: هل يُطبَّق هذا «الأصل» يوماً؟
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { addBank, addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER, has } from './helpers/rederive';
import { snap, newAsMember, bal, rejects, waiting } from './helpers/auditI';
import type { RemoteDoc } from '@/sync/types';

test('(M5) صفقة تقبيلٍ طُبّق قيدها عند المالك ثم ألغاها العضو، وقيدٌ مزوَّر لا يُطبَّق أبداً (مصدر «rent» بلا دفعة) يسمّي العاكس: الإلغاء لا يصل دفتر المالك أبداً', async () => {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع M', 0);
  const pa = addProperty(s.owner, { name: 'عقار تقبيل M مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'MM-1' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const since = snap(s.r);
  // عضوٌ يسجّل صفقة تقبيل ثم يلغيها (مسارات التطبيق نفسها)
  const deal = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: null, outgoing: 'متنازل M', incoming: 'متنازل له M', amountHalalas: 5000000,
    date: '2026-06-01', commissionHalalas: 230000, method: 'bank', bankId: A, notes: '' });
  const e1 = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [deal])!.id;
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  await ownerPulls(s.owner, s.r); // الصفقة وقيدها عند المالك
  const applied = { e1: has(s.owner, e1), owner: bal(s.owner, [A]) };
  await sync(s.dev, s.r);
  const since2 = snap(s.r);
  (entrySourceAction(s.dev, e1) as { kind: 'op'; run: (d: string, r: string) => void }).run('2026-08-15', 'سبب مصطنع');
  const r1 = s.dev.get<{ id: string }>(`SELECT reversed_by AS id FROM journal_entries WHERE id = ?`, [e1])!.id;
  await sync(s.dev, s.r);
  newAsMember(s.r, since2);
  // ومستندٌ مزوَّر واحد بعده: قيدٌ مرحّل بمصدر «rent» بلا دفعةٍ (ينتظر دفعته أبداً) يسمّي العاكس المشروع
  const e = s.r.docs.get('journal_entries__' + e1)!;
  const k = 'm5-forged';
  s.r.inject({ ...e, id: 'journal_entries__' + k, k, by: MEMBER, op: 'banks',
    d: { ...e.d, id: k, no: 'FG-M5', src_type: 'rent', src_id: 'm5-no-payment', reversed_by: r1 },
    lines: (e.lines ?? []).map((l, i) => ({ ...l, id: k + '-l' + i, entry_id: k })) } as RemoteDoc);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const ids: Record<string, string> = { [e1]: 'e1', [r1]: 'r1', [k]: 'forged' };
  const out = { applied, r1Here: has(s.owner, r1), owner: bal(s.owner, [A]), member: bal(s.dev, [A]),
    rejects: rejects(s.owner).map((x) => (ids[x.pk] ?? x.tbl) + ': ' + x.reason), waiting: waiting(s.owner).map((w) => ids[w.pk] ?? w.tbl) };
  // eslint-disable-next-line no-console
  console.log('M5', JSON.stringify(out));
  // العاكس المشروع مرآةُ أصله الحر هنا: يُقبل، والمزوَّر وحده يُرفض بطول انتظاره
  expect(out.r1Here).toBe(true);
  expect(out.owner).toEqual(out.member);
  s.close();
});

import { ownerCashIn } from '@/domain/cashOps';
import { walletCashBalance } from '@/domain/accounting/ledger';
import { memDb } from './helpers/testDb';
import { enableSync } from '@/sync/engine';
import { UID } from './helpers/rederive';

test('(M10) ربطٌ مزوَّر في السحابة (أصلٌ «معكوس» بعاكسٍ لا وجود له، مرةً واحدة كما تجيز القواعد): جهاز المالك الثاني يرفض عكس المالك نفسه للقيد', async () => {
  const s = await pair(); // owner = جهاز المالك الأول، dev = جهازه الثاني (الحساب نفسه بلا عضوية)
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  ownerCashIn(s.owner, { amountHalalas: 400000, date: '2026-10-01', notes: 'إيداع المالك مصطنع M10' });
  const o = s.owner.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'cash_op' ORDER BY created_at DESC LIMIT 1`)!.id;
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // عضوٌ يربط الأصل في السحابة بعاكسٍ لا يرفعه أبداً (القواعد تجيز الربط مرةً واحدة)
  const cloud = s.r.docs.get('journal_entries__' + o)!;
  const { ts: _ts, ...doc } = cloud;
  // وكاتب الصف لا يتغير (القواعد · الهجرة ٤٢): «by» كما في السحابة، و«op» مسار العضو
  const w = await s.r.write([{ ...doc, op: 'banks', d: { ...doc.d, reversed_by: 'm10-never' } } as RemoteDoc]);
  expect(w[0].ok).toBe(true);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // المالك على جهازه الأول يلغي العملية (مسار التطبيق)
  (entrySourceAction(s.owner, o) as { kind: 'op'; run: (d: string, r: string) => void }).run('2026-10-05', 'سبب مصطنع M10');
  const r = s.owner.get<{ id: string }>(`SELECT reversed_by AS id FROM journal_entries WHERE id = ?`, [o])!.id;
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  await sync(s.dev, s.r);
  // وهاتفٌ بديل للمالك ينضم بعدها
  const fresh = memDb();
  enableSync(fresh, UID);
  await sync(fresh, s.r);
  await sync(fresh, s.r);
  const out = { cloudLink: s.r.docs.get('journal_entries__' + o)!.d!.reversed_by, revOn2: has(s.dev, r), revOnFresh: has(fresh, r),
    wallet: { device1: walletCashBalance(s.owner), device2: walletCashBalance(s.dev), fresh: walletCashBalance(fresh) },
    rejects2: s.dev.all<{ pk: string; reason: string }>(`SELECT pk, reason FROM sync_rejects`).map((x) => (x.pk === r ? 'R' : x.pk === o ? 'O' : x.pk) + ': ' + x.reason),
    waiting2: s.dev.all<{ pk: string }>(`SELECT pk FROM sync_inbox`).map((x) => (x.pk === r ? 'R' : x.pk)) };
  // eslint-disable-next-line no-console
  console.log('M10', JSON.stringify(out));
  expect(out.revOn2).toBe(true);
  expect(out.wallet.device2).toBe(out.wallet.device1);
  expect(out.wallet.fresh).toBe(out.wallet.device1);
  fresh.close();
  s.close();
});
