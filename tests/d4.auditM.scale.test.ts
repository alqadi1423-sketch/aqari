/**
 * مدقق خارجي M · الجولة السابعة · كلفة jointlyCovered (engine.ts) بحجم الوارد (القاعدة ١٠١) على 2cf6151 · بيانات مصطنعة.
 * كل حركةٍ تنتظر نقصاً تمسح حركات البنك كلها في الوارد وتفكّ حمولتها، فالمرور الواحد تربيعي في عدد المنتظر.
 */
import { withdrawCashFromBank, CASH_WITHDRAW_SOURCE } from '@/domain/cashOps';
import { addBank } from './helpers/fixtures';
import { pair, sync, MEMBER } from './helpers/rederive';
import { snap, newAsMember } from './helpers/auditI';
import type { RemoteDoc } from '@/sync/types';

/** n سحبٍ من بنكٍ فارغ تنتظر كلها (رفعُ عضوٍ كبير، أو مزوَّرة) · يعيد زمن سحب المالك الثاني (الوارد كله منتظر) */
async function run(n: number) {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع M', 0);
  const B = addBank(s.owner, 'بنك ب مصطنع M', 100);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const since = snap(s.r);
  withdrawCashFromBank(s.dev, { bankId: B, amountHalalas: 100, date: '2026-10-01' });
  await sync(s.dev, s.r);
  const [tmpl] = newAsMember(s.r, since).filter((d) => d.t === 'bank_tx');
  for (let i = 0; i < n; i++) {
    const k = 'm-scale-' + i;
    s.r.inject({ ...tmpl, id: 'bank_tx__' + k, k, by: MEMBER, op: 'banks',
      d: { ...tmpl.d, id: k, bank_id: A, amount_halalas: -100, journal_no: '', source: CASH_WITHDRAW_SOURCE, descr: 'سحب مصطنع ' + i } } as RemoteDoc);
  }
  await sync(s.owner, s.r); // يجلب الوارد ويطبّق مرةً
  const t0 = process.hrtime.bigint();
  await sync(s.owner, s.r); // دورةٌ ثانية: لا جديد في السحابة، والوارد كله يُعاد فحصه
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const waiting = Number(s.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox WHERE tbl = 'bank_tx'`)!.n);
  // وبعد ثلاثين يوماً: تُرفض لطول انتظارها، ثم تُعاد «على التجربة» في كل دورة (مفتاح البنك حاضر) فتُفحص كلها ثانيةً
  s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await sync(s.owner, s.r);
  const t1 = process.hrtime.bigint();
  await sync(s.owner, s.r);
  const after30 = Number(process.hrtime.bigint() - t1) / 1e9;
  const rejected = Number(s.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'bank_tx'`)!.n);
  s.close();
  return { secs, waiting, after30, rejected };
}

test('(M4) حركات البنك المنتظرة: ×٤ في عددها دون ×٦ في زمن الدورة (معيار d4.auditB.memberQuadratic)', async () => {
  const small = await run(400);
  const big = await run(1600);
  const ratio = big.secs / small.secs;
  // eslint-disable-next-line no-console
  console.log('M4', JSON.stringify({ small, big, ratio: Number(ratio.toFixed(1)) }));
  expect(small.waiting).toBe(400);
  expect(big.waiting).toBe(1600);
  expect(ratio).toBeLessThan(6);
  // والمرفوض لطول انتظاره لا يكلّف كل دورةٍ بعده كلفة الانتظار نفسها
  expect(big.after30).toBeLessThan(2);
}, 600000);
