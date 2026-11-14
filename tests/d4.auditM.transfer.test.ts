/**
 * مدقق خارجي M · الجولة السابعة · transferPaired (engine.ts) على 2cf6151 · بيانات مصطنعة.
 * «!wasLive» يصدق على الاستعادة من السلة كما على الإنشاء: وارد تحويلٍ محذوف يُستعاد بلا فحص المحفظة ما دام صادره قائماً.
 */
import { transferBetweenBanks, CASH_DEPOSIT_SOURCE } from '@/domain/cashOps';
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { snap, newAsMember, bal } from './helpers/auditI';
import type { RemoteDoc } from '@/sync/types';

test('(M6) حذف وارد التحويل إلى السلة، ثم إيداع نقده في بنكٍ ثالث، ثم استعادته: المحفظة تحت الصفر وبنكان يحملان المال نفسه', async () => {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع M', 100000);
  const B = addBank(s.owner, 'بنك ب مصطنع M', 0);
  const C = addBank(s.owner, 'بنك ج مصطنع M', 0);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const since = snap(s.r);
  transferBetweenBanks(s.dev, { fromBankId: A, toBankId: B, amountHalalas: 100000, date: '2026-10-05', notes: 'تحويل مصطنع M6' });
  await sync(s.dev, s.r);
  const docs = newAsMember(s.r, since).filter((d) => d.t === 'bank_tx');
  await ownerPulls(s.owner, s.r);
  const step0 = bal(s.owner, [A, B, C]);
  const inB = docs.find((d) => Number(d.d?.amount_halalas) > 0)!;
  const put = (d: RemoteDoc) => s.r.inject({ ...d, by: MEMBER, op: 'banks', u: new Date().toISOString() } as RemoteDoc);
  // ١) الوارد إلى السلة (يعيد نقده إلى المحفظة: البنك ب يكفيه)
  put({ ...inB, d: { ...inB.d, deleted_at: '2026-10-06T00:00:00.000Z' } });
  await ownerPulls(s.owner, s.r);
  const step1 = bal(s.owner, [A, B, C]);
  // ٢) إيداع ذلك النقد في ج (المحفظة تكفيه)
  const k = 'm6-deposit';
  put({ ...inB, id: 'bank_tx__' + k, k, d: { ...inB.d, id: k, bank_id: C, source: CASH_DEPOSIT_SOURCE, descr: 'إيداع مصطنع M6', deleted_at: null } });
  await ownerPulls(s.owner, s.r);
  const step2 = bal(s.owner, [A, B, C]);
  // ٣) استعادة الوارد من السلة
  put({ ...inB, d: { ...inB.d, deleted_at: null } });
  await ownerPulls(s.owner, s.r);
  const out = { step0, step1, step2, final: bal(s.owner, [A, B, C]) };
  // eslint-disable-next-line no-console
  console.log('M6', JSON.stringify(out));
  // المحفظة صفر قبل الاستعادة: استعادة الوارد تُنقصها فتنتظر كاستعادة الإيداع
  expect(out.final[3]).toBeGreaterThanOrEqual(0);
  s.close();
});
