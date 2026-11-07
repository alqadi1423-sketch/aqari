/**
 * مدقق خارجي O · الجولة الثامنة · ربط العضو قيدَ المالك بعاكسٍ مزوَّر، وجهاز المالك الجديد (reversedIssue في deriveSources.ts، وM١٠) على
 * e5e16f5 · بيانات مصطنعة · القاعدة (reversalReal) تجيز الربط مرةً واحدة بعاكسٍ قائمٍ في السحابة: مرحّلٍ بمصدر الأصل «_rev» ومعرّف
 * مصدره، وبعدد سطوره ومجموعه · ولا تفحص أنه مرآته · وكاتبهما عضوٌ بـ«كامل» الدفتر (srcOk: «ledger» وحده يكتب «_rev»).
 */
import { ownerCashIn } from '@/domain/cashOps';
import { walletCashBalance } from '@/domain/accounting/ledger';
import { memDb } from './helpers/testDb';
import { enableSync } from '@/sync/engine';
import { pair, sync, has, UID, MEMBER, mirrorOf } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';

test.each([
  ['سطره على حسابٍ لا وجود له (ينتظر)', '3199'],
  ['مرآةٌ بحسابٍ آخر قائم (يُرفض)', '4300'],
])('(O4) العضو يربط «إيداع المالك نقداً» بعاكسٍ مزوَّر %s ولا يعكسه أحد: هاتف المالك البديل يرفض قيد المالك نفسه فتنقص محفظته', async (_l, acc) => {
  const s = await pair();
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  ownerCashIn(s.owner, { amountHalalas: 400000, date: '2026-10-01', notes: 'إيداع المالك مصطنع O4' });
  const o = s.owner.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'cash_op' ORDER BY created_at DESC LIMIT 1`)!.id;
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const { ts: _ts, ...doc } = s.r.docs.get('journal_entries__' + o)!;
  const X = 'o4-x';
  const xDoc = { ...doc, id: 'journal_entries__' + X, k: X, by: MEMBER, op: 'ledger',
    d: { ...doc.d, id: X, no: 'FG-O4', src_type: 'cash_op_rev', src_id: doc.d!.src_id, reversed_by: null },
    lines: mirrorOf(doc.lines!).map((l, i) => ({ ...l, id: X + '-l' + i, entry_id: X, account_code: l.account_code === '1100' ? '1100' : acc })) } as RemoteDoc;
  const w = await s.r.write([xDoc, { ...doc, op: 'ledger', d: { ...doc.d, reversed_by: X } } as RemoteDoc]);
  expect(w.every((x) => x.ok)).toBe(true);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // هاتفٌ بديل للمالك ينضم، ثم يمضي ثلاثون يوماً
  const fresh = memDb();
  enableSync(fresh, UID);
  await sync(fresh, s.r);
  await sync(fresh, s.r);
  fresh.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await sync(fresh, s.r);
  await sync(fresh, s.r);
  const name = (pk: string) => (pk === o ? 'O' : pk === X ? 'X' : pk);
  const out = { oOnFresh: has(fresh, o), oOn1: has(s.owner, o), oOn2: has(s.dev, o),
    wallet: { device1: walletCashBalance(s.owner), device2: walletCashBalance(s.dev), fresh: walletCashBalance(fresh) },
    rejectsFresh: fresh.all<{ pk: string; reason: string }>(`SELECT pk, reason FROM sync_rejects`).map((x) => name(x.pk) + ': ' + x.reason) };
  // eslint-disable-next-line no-console
  console.log('O4', acc, JSON.stringify(out));
  expect(out.oOn1).toBe(true);
  // قيد المالك نفسه لم يعكسه أحد: يصل هاتفه البديل، والمحفظة واحدة على أجهزته
  expect(out.oOnFresh).toBe(true);
  expect(out.wallet.fresh).toBe(out.wallet.device1);
  fresh.close();
  s.close();
});
