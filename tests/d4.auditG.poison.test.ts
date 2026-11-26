/**
 * مدقق خارجي (G) · الجولة الرابعة · سطر قيدٍ قيمة حقله ليست قيمة (engine.ts · restageArrivedParents/awaitedRefs) · بيانات مصطنعة.
 * إصلاح هـ٨ (docLines/linesMalformed) يرفض سطراً ليس كائناً، لا كائناً حقوله ليست قيماً · وقيد العضو ينتظر مستنده قبل إدراج سطوره
 * (memberSourceCheck)، فيبلغ ثلاثين يوماً ويُرفض «سجل أب غير موجود» · ثم في كل دورةٍ يُعاد على التجربة: awaitedRefs يربط قيمة الحساب
 * في استعلامٍ خارج حماية applyOne، فيرمي ويُسقط التطبيق كله على جهاز المالك في كل دورة.
 */
import { ownerCashIn } from '@/domain/cashOps';
import { addBank } from './helpers/fixtures';
import { pair, sync, forge, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';

test('مدقق G · (M1) قيد عضوٍ ينتظر مستنده وسطره account_code كائن: بعد رفض الانتظار يبقى جهاز المالك يطبّق الوارد', async () => {
  const s = await pair();
  ownerCashIn(s.owner, { amountHalalas: 1000, date: '2026-11-01' });
  await sync(s.owner, s.r);
  const base = [...s.r.docs.values()].find((d) => d.t === 'journal_entries')!;
  const bad = forge(base, { src_type: 'key_money', lines: [
    { account_code: { a: 1 }, descr: 'مصطنع', debit_halalas: 1000, credit_halalas: 0 },
    { account_code: '4300', descr: 'مصطنع', debit_halalas: 0, credit_halalas: 1000 },
  ] as never });
  s.r.inject({ ...bad, op: 'reservations', d: { ...bad.d, src_id: 'deal-never-g' } } as RemoteDoc);
  await sync(s.owner, s.r);
  const waiting = s.owner.get<{ e: string }>(`SELECT last_error AS e FROM sync_inbox WHERE pk = ?`, [bad.k])?.e ?? null;
  // يمضي الشهر
  s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await sync(s.owner, s.r);
  const rejected = s.owner.get<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE pk = ?`, [bad.k])?.reason ?? null;
  // ثم يصل من العضو صفٌّ عادي
  const bank = addBank(s.dev, 'بنك بعد السمّ مصطنع');
  await sync(s.dev, s.r);
  s.r.inject({ ...s.r.docs.get('banks__' + bank)!, by: MEMBER, op: 'banks' });
  let err = '';
  try { await sync(s.owner, s.r); await sync(s.owner, s.r); } catch (e) { err = String((e as Error).message); }
  const out = { waiting, rejected, err, bankArrived: !!s.owner.get(`SELECT 1 FROM banks WHERE id = ?`, [bank]),
    inbox: s.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox`)!.n };
  // eslint-disable-next-line no-console
  console.log('M1', JSON.stringify(out));
  expect(err).toBe('');
  expect(out.bankArrived).toBe(true);
  s.close();
});
