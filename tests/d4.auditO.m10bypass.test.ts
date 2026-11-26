/**
 * مدقق خارجي O · الجولة الثامنة · إصلاح M١٠ في freeOriginals (engine.ts) على e5e16f5 · بيانات مصطنعة.
 * «ربطٌ بعاكسٍ لا وجود له هنا ولا في الوارد لا يحجز الأصل» · والوجود في الوارد يصنعه العضو: قاعدة السحابة (reversalReal) لا تجيز الربط
 * إلا بعاكسٍ قائمٍ في السحابة، فالعاكس الذي يسمّيه الربط يصل الوارد دائماً · وعاكسٌ ينتظر (سطرٌ على حسابٍ لا وجود له) يبقى فيه ثلاثين يوماً.
 */
import { ownerCashIn } from '@/domain/cashOps';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { walletCashBalance } from '@/domain/accounting/ledger';
import { memDb } from './helpers/testDb';
import { enableSync } from '@/sync/engine';
import { pair, sync, has, UID, MEMBER, mirrorOf } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';

test.each([false, true])('(O3) M10 والعاكس المسمّى مستندٌ في السحابة ينتظر (refused=%s: السحابة ترفض إعادة ربط الأصل كما تقضي قاعدة الربط مرةً واحدة): جهاز المالك الثاني يرفض عكس المالك نفسه', async (refused) => {
  const s = await pair(); // owner = جهاز المالك الأول، dev = جهازه الثاني
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  ownerCashIn(s.owner, { amountHalalas: 400000, date: '2026-10-01', notes: 'إيداع المالك مصطنع O3' });
  const o = s.owner.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'cash_op' ORDER BY created_at DESC LIMIT 1`)!.id;
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const cloud = s.r.docs.get('journal_entries__' + o)!;
  const { ts: _ts, ...doc } = cloud;
  // العضو: عاكسٌ «حقيقي» في السحابة كما تشترط reversalReal (مرحّل، مصدره cash_op_rev ومعرّف مصدره، وبعدد سطور الأصل) · وأحد سطوره
  // على حسابٍ لا وجود له فينتظر في وارد المالك (مفتاحٌ أجنبي) ثلاثين يوماً ولا يُطبَّق
  const X = 'o3-x';
  const xLines = mirrorOf(doc.lines!).map((l, i) => ({ ...l, id: X + '-l' + i, entry_id: X, account_code: l.account_code === '1100' ? '1100' : '3199' }));
  const xDoc = { ...doc, id: 'journal_entries__' + X, k: X, by: MEMBER, op: 'ledger',
    d: { ...doc.d, id: X, no: 'FG-O3', src_type: 'cash_op_rev', src_id: doc.d!.src_id, reversed_by: null }, lines: xLines } as RemoteDoc;
  // والربط مرةً واحدة في الالتزام نفسه
  const link = { ...doc, op: 'ledger', d: { ...doc.d, reversed_by: X } } as RemoteDoc;
  const w = await s.r.write([xDoc, link]);
  expect(w.every((x) => x.ok)).toBe(true);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // المالك على جهازه الأول يلغي العملية (مسار التطبيق)
  (entrySourceAction(s.owner, o) as { kind: 'op'; run: (d: string, r: string) => void }).run('2026-10-05', 'سبب مصطنع O3');
  const r = s.owner.get<{ id: string }>(`SELECT reversed_by AS id FROM journal_entries WHERE id = ?`, [o])!.id;
  await sync(s.owner, s.r);
  // القاعدة (orgOnlyLinksReversal): الأصل مربوطٌ في السحابة فإعادة ربطه تُرفض · MemoryRemote لا يفحص القواعد فيُعاد الربط كما كان
  if (refused) s.r.inject({ ...s.r.docs.get('journal_entries__' + o)!, d: { ...doc.d, reversed_by: X } } as RemoteDoc);
  await sync(s.dev, s.r);
  await sync(s.dev, s.r);
  const fresh = memDb();
  enableSync(fresh, UID);
  await sync(fresh, s.r);
  await sync(fresh, s.r);
  // وبعد ثلاثين يوماً يُرفض X لطول انتظاره · ورفض R ليس رفض انتظار فلا يعود
  for (const db of [s.dev, fresh]) db.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await sync(s.dev, s.r);
  await sync(s.dev, s.r);
  await sync(fresh, s.r);
  await sync(fresh, s.r);
  const name = (pk: string) => (pk === r ? 'R' : pk === o ? 'O' : pk === X ? 'X' : pk);
  const out = { revOn2: has(s.dev, r), revOnFresh: has(fresh, r),
    wallet: { device1: walletCashBalance(s.owner), device2: walletCashBalance(s.dev), fresh: walletCashBalance(fresh) },
    rejects2: s.dev.all<{ pk: string; reason: string }>(`SELECT pk, reason FROM sync_rejects`).map((x) => name(x.pk) + ': ' + x.reason),
    waiting2: s.dev.all<{ pk: string }>(`SELECT pk FROM sync_inbox`).map((x) => name(x.pk)),
    rejectsFresh: fresh.all<{ pk: string; reason: string }>(`SELECT pk, reason FROM sync_rejects`).map((x) => name(x.pk) + ': ' + x.reason),
    waitingFresh: fresh.all<{ pk: string }>(`SELECT pk FROM sync_inbox`).map((x) => name(x.pk)) };
  // eslint-disable-next-line no-console
  console.log('O3', refused, JSON.stringify(out));
  // عكس المالك نفسه يصل جهازيه الآخرين، والمحفظة واحدة على أجهزته الثلاثة (ما يرجوه اختبار M10)
  expect(out.revOn2).toBe(true);
  expect(out.wallet.device2).toBe(out.wallet.device1);
  expect(out.wallet.fresh).toBe(out.wallet.device1);
  fresh.close();
  s.close();
});
