/**
 * المدقق الخارجي S · الجولة العاشرة · على 7e3b492 · بيانات مصطنعة كلها.
 * S١: «الربط المتأخر» (engine.ts lateLink) يقيس وقت حركة البنك بـ incomingAt(doc) = أصغر «ts» و«u» · و«u» يكتبه جهاز العضو بلا قيد
 * (القاعدة: r.u is string وحده)، فيؤخّره العضو إلى ما قبل قيد المالك فلا تُعدّ الحركة «متأخرة» أياً كان عمرها، ويسقط فحص كفاية البنك
 * الذي أُضيف لـ O٢: حركةٌ مزوَّرة برقم قيدٍ يدويٍّ قديم صُرف نقده من المحفظة (رواتب نقداً) من بنكٍ فارغ تُطبَّق، فيصير البنك سالباً
 * وتظهر في المحفظة نقودٌ لا وجود لها تُودَع بعدها في بنكٍ آخر.
 * على e7c151c كان الفحص على كل حركة قيدٍ سالبة جديدة فتنتظر (ثم تُرفض) · والتوثيق (DESIGN.md §Q٣) يقول «بعد قيدها بأكثر من ساعة بوقت الخادم».
 * السلوك الصحيح: وقت الحركة وقت الخادم (ts) وحده، فحركةٌ كُتبت بعد قيدها بساعات تنتظر ما يكفيها مهما ادّعى «u».
 */
import { ownerCashIn, CASH_DEPOSIT_SOURCE } from '@/domain/cashOps';
import { postEntry } from '@/domain/accounting/post';
import { walletCashBalance, bankBalance } from '@/domain/accounting/ledger';
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { rejects, waiting } from './helpers/auditI';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';

const HOUR = 3600 * 1000;
let n = 0;
const tx = (s: { r: { inject: (d: RemoteDoc) => void } }, u: string, d: Record<string, unknown>): string => {
  const k = 's1-tx-' + (++n);
  s.r.inject({ id: 'bank_tx__' + k, t: 'bank_tx', k, u, dev: 'dev-member-s1', by: MEMBER, op: 'banks', del: false,
    d: { id: k, date: '2026-10-05', descr: 'حركة مصطنعة S1', matched: 1, created_at: u, deleted_at: null, ...d } } as RemoteDoc);
  return k;
};
const applied = (db: DB, k: string) => !!db.get(`SELECT 1 FROM bank_tx WHERE id = ? AND deleted_at IS NULL`, [k]);

async function setup() {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع S1', 0);
  const B = addBank(s.owner, 'بنك ب مصطنع S1', 0);
  // المالك يودع نقداً في المحفظة ثم يصرفه كله رواتب نقداً بقيدٍ يدوي (مدين 5200 دائن 1100)
  ownerCashIn(s.owner, { amountHalalas: 300000, date: '2026-10-01' });
  const e = postEntry(s.owner, { date: '2026-10-02', memo: 'رواتب نقداً مصطنعة S1', lines: [
    { account: '5200', descr: 'رواتب مصطنعة', debit: 300000, credit: 0 },
    { account: '1100', descr: 'نقداً من المحفظة', debit: 0, credit: 300000 }] })!;
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  return { ...s, A, B, no: e.no, entryId: e.id };
}

/** الوقت (Date وحده) يتقدّم ثلاث ساعات بعد قيد المالك: المؤقتات حقيقية */
function threeHoursLater() {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval',
    'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
  jest.setSystemTime(Date.now() + 3 * HOUR);
}
afterEach(() => jest.useRealTimers());

describe('S1 · الربط المتأخر يُقاس بـ«u» الذي يكتبه العضو', () => {
  test('(ضابط · صمد) حركةٌ بـ«u» صادق بعد ثلاث ساعات من قيد الرواتب: تنتظر ما يكفيها ولا تُطبَّق', async () => {
    const s = await setup();
    threeHoursLater();
    const fee = tx(s, new Date().toISOString(), { bank_id: s.A, amount_halalas: -300000, journal_no: s.no, source: 'سداد مصطنع' });
    await ownerPulls(s.owner, s.r);
    expect(applied(s.owner, fee)).toBe(false);
    expect([bankBalance(s.owner, s.A), walletCashBalance(s.owner)]).toEqual([0, 0]);
    s.close();
  });

  test('S1: الحركة نفسها بـ«u» مؤخَّرٍ إلى ما قبل القيد تُطبَّق: البنك سالب، و«نقد» المحفظة يُودَع في بنكٍ آخر', async () => {
    const s = await setup();
    const at = s.owner.get<{ u: string }>(`SELECT u FROM sync_rowtime WHERE tbl = 'journal_entries' AND pk = ?`, [s.entryId])!.u;
    threeHoursLater();
    const base = [bankBalance(s.owner, s.A), bankBalance(s.owner, s.B), walletCashBalance(s.owner)];
    // ١) «u» يكتبه العضو: قبل وقت قيد المالك بدقيقة (أو أي وقتٍ قديم)، و«ts» وقت الخادم الحقيقي (بعد ثلاث ساعات)
    const fee = tx(s, new Date(Date.parse(at) - 60 * 1000).toISOString(), { bank_id: s.A, amount_halalas: -300000, journal_no: s.no, source: 'سداد مصطنع' });
    await ownerPulls(s.owner, s.r);
    // ٢) و«النقد» الذي ظهر في المحفظة يُودَع في بنك ب (حركةٌ بلا قيد بمصدر الإيداع · تمرّ بفحص المحفظة)
    const dep = tx(s, new Date().toISOString(), { bank_id: s.B, amount_halalas: 300000, journal_no: '', source: CASH_DEPOSIT_SOURCE });
    await ownerPulls(s.owner, s.r);
    const feeDoc = s.r.docs.get('bank_tx__' + fee)!;
    const out = { lagMs: Date.parse(feeDoc.ts) - Date.parse(at), base,
      owner: [bankBalance(s.owner, s.A), bankBalance(s.owner, s.B), walletCashBalance(s.owner)],
      feeApplied: applied(s.owner, fee), depApplied: applied(s.owner, dep),
      rejects: rejects(s.owner).map((r) => r.tbl + ': ' + r.reason), waiting: waiting(s.owner).map((w) => w.tbl + ': ' + w.last_error) };
    // eslint-disable-next-line no-console
    console.log('S1', JSON.stringify(out));
    expect(out.lagMs).toBeGreaterThan(2 * HOUR); // كُتبت في الخادم بعد القيد بأكثر من ساعتين
    expect(base).toEqual([0, 0, 0]);
    // الصحيح: لا تُطبَّق (ربطٌ متأخر بوقت الخادم، والبنك لا يكفيها)، ولا يتغيّر بنكٌ ولا المحفظة
    expect(out.feeApplied).toBe(false);
    expect(out.owner).toEqual(base);
    s.close();
  });

  /**
   * S١ب: ولا يكفي إصلاحٌ يقرأ «ts» للحركة وحدها: وقت القيد (sync_rowtime) آخر نسخةٍ عرفها الجهاز له، والعضو يجدّده بكتابة ربط عكسٍ على
   * قيد المالك (تقبله القاعدة بعاكسٍ قائمٍ في السحابة بعدد السطور والمجموع · O٣ وO٤)، فيرفض جهاز المالك العاكس المزوَّر ويُبقي الربط
   * معلَّقاً، لكنه يكتب للقيد وقتاً جديداً · فحركةٌ بـ«u» صادقٍ بعده لا تُعدّ متأخرة.
   */
  test('S1b: ربط عكسٍ مزوَّر يجدّد وقت قيد الرواتب القديم، فحركةٌ بـ«u» صادق بعده تُطبَّق من بنكٍ فارغ', async () => {
    const s = await setup();
    threeHoursLater();
    const { ts: _t, ...e } = s.r.docs.get('journal_entries__' + s.entryId)!;
    // ١) عاكسٌ «مرحّل» بمصدر manual_rev لقيد الرواتب، بعدد سطوره ومجموعه وليس مرآته (يرفضه جهاز المالك)
    const R = 's1b-rev';
    const now = new Date().toISOString();
    s.r.inject({ ...e, id: 'journal_entries__' + R, k: R, u: now, dev: 'dev-member-s1', by: MEMBER, op: 'ledger',
      d: { ...e.d, id: R, no: 'S1B-REV', src_type: 'manual_rev', src_id: s.entryId, reversed_by: null, memo: 'عاكس مزوَّر مصطنع S1b' },
      lines: e.lines!.map((l, i) => ({ ...l, id: R + '-l' + i, entry_id: R })) } as RemoteDoc);
    // ٢) وربطُ قيد الرواتب به (الحقل الوحيد الذي تجيزه القاعدة على المرحّل)
    s.r.inject({ ...e, u: now, dev: 'dev-member-s1', op: 'ledger', d: { ...e.d, reversed_by: R } } as RemoteDoc);
    // ٣) والحركة بـ«u» صادق
    const fee = tx(s, new Date().toISOString(), { bank_id: s.A, amount_halalas: -300000, journal_no: s.no, source: 'سداد مصطنع' });
    await ownerPulls(s.owner, s.r);
    const out = { feeApplied: applied(s.owner, fee), owner: [bankBalance(s.owner, s.A), walletCashBalance(s.owner)],
      reversedHere: s.owner.get<{ r: string | null }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [s.entryId])!.r,
      rejects: rejects(s.owner).map((r) => r.tbl + ': ' + r.reason.slice(0, 60)) };
    // eslint-disable-next-line no-console
    console.log('S1b', JSON.stringify(out));
    expect(out.reversedHere).toBeNull(); // العاكس المزوَّر لم يُقبل
    expect(out.feeApplied).toBe(false);
    expect(out.owner).toEqual([0, 0]);
    s.close();
  });
});
