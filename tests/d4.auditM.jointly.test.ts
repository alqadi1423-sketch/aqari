/**
 * مدقق خارجي M · الجولة السابعة · jointlyCovered (engine.ts) على 2cf6151 · بيانات مصطنعة.
 * «حركات البنك المنتظرة في الوارد» تُعدّ رصيداً ولو لم تُطبَّق أبداً.
 */
import { withdrawCashFromBank, recordManualBankTx, pettyCashExpense } from '@/domain/cashOps';
import { CASH_WITHDRAW_SOURCE, CASH_DEPOSIT_SOURCE } from '@/domain/cashOps';
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { snap, newAsMember, bal, rejects, waiting } from './helpers/auditI';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';

async function setup() {
  const p = await pair();
  const A = addBank(p.owner, 'بنك أ مصطنع M', 0);
  const B = addBank(p.owner, 'بنك ب مصطنع M', 50000);
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  const since = snap(p.r);
  // قالبٌ مشروع: سحبٌ من ب على جهاز العضو
  withdrawCashFromBank(p.dev, { bankId: B, amountHalalas: 50000, date: '2026-10-01' });
  await sync(p.dev, p.r);
  const [tmpl] = newAsMember(p.r, since).filter((d) => d.t === 'bank_tx');
  return { ...p, A, B, tmpl };
}
let n = 0;
const forgeTx = (s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown>): string => {
  const k = 'm-forged-' + (++n);
  s.r.inject({ ...s.tmpl, id: 'bank_tx__' + k, k, by: MEMBER, op: 'banks', u: new Date().toISOString(),
    d: { ...s.tmpl.d, id: k, created_at: new Date().toISOString(), ...over } } as RemoteDoc);
  return k;
};
const applied = (s: { owner: DB }, k: string) => !!s.owner.get(`SELECT 1 FROM bank_tx WHERE id = ? AND deleted_at IS NULL`, [k]);

describe('مدقق M · jointlyCovered يعدّ حركةً منتظرةً لن تُطبَّق أبداً رصيداً', () => {
  test('(M1) واردٌ مزوَّر برقم قيدٍ لا وجود له (ينتظر قيده أبداً) يغطّي سحباً مزوَّراً من بنكٍ فارغ: البنك سالب والمحفظة نقدٌ لا وجود له', async () => {
    const s = await setup();
    await ownerPulls(s.owner, s.r); // القالب المشروع يُطبَّق (ب صفر، المحفظة 50000)
    const base = bal(s.owner, [s.A, s.B]);
    // ١) واردٌ إلى أ برقم قيدٍ لم يُكتب قط (ينتظر قيده)
    const fake = forgeTx(s, { bank_id: s.A, amount_halalas: 300000, journal_no: 'JV-M1-لا-وجود', source: 'وارد بنكي', descr: 'وارد مزوَّر M1' });
    // ٢) سحبٌ نقدي من أ الفارغ بالمبلغ نفسه
    const w = forgeTx(s, { bank_id: s.A, amount_halalas: -300000, journal_no: '', source: CASH_WITHDRAW_SOURCE, descr: 'سحب مزوَّر M1' });
    await ownerPulls(s.owner, s.r);
    // وبعد ثلاثين يوماً يُرفض الوارد المزوَّر لطول انتظاره
    s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
    await ownerPulls(s.owner, s.r);
    const out = { base, owner: bal(s.owner, [s.A, s.B]), fakeApplied: applied(s, fake), withdrawalApplied: applied(s, w),
      rejects: rejects(s.owner).map((r) => r.pk + ': ' + r.reason), waiting: waiting(s.owner).map((x) => x.pk) };
    // eslint-disable-next-line no-console
    console.log('M1', JSON.stringify(out));
    // الحارس (G٥): سحبٌ من بنكٍ فارغ لا يُدخل المحفظة نقداً لا وجود له، ولا ينزل البنك تحت الصفر
    expect(out.owner[0]).toBeGreaterThanOrEqual(0);
    expect(out.owner[2]).toBe(base[2]);
    s.close();
  });

  test('(M2) حركةٌ مزوَّرة تُرفض فوراً بعد السحب (مصدرٌ لا يجيزه الحارس) تكفي لقبوله ما دامت في الدفعة نفسها بعده', async () => {
    const s = await setup();
    await ownerPulls(s.owner, s.r);
    const base = bal(s.owner, [s.A, s.B]);
    // السحب أولاً في الرفع، ثم «شريكه»: واردٌ بلا قيد بمصدرٍ غير معروف يرفضه الحارس (bankTxNoEntry) حين يصل دوره
    const w = forgeTx(s, { bank_id: s.A, amount_halalas: -200000, journal_no: '', source: CASH_WITHDRAW_SOURCE, descr: 'سحب مزوَّر M2' });
    const p = forgeTx(s, { bank_id: s.A, amount_halalas: 200000, journal_no: '', source: 'مصدر مزوَّر M2', descr: 'شريك مزوَّر M2' });
    await ownerPulls(s.owner, s.r);
    const out = { base, owner: bal(s.owner, [s.A, s.B]), withdrawalApplied: applied(s, w), partnerApplied: applied(s, p),
      rejects: rejects(s.owner).map((r) => r.pk + ': ' + r.reason), waiting: waiting(s.owner).map((x) => x.pk) };
    // eslint-disable-next-line no-console
    console.log('M2', JSON.stringify(out));
    expect(out.partnerApplied).toBe(false);
    expect(out.owner[0]).toBeGreaterThanOrEqual(0);
    s.close();
  });

  test('(M3) والمحفظة تحت الصفر: إيداعٌ مزوَّر من محفظةٍ فارغة يغطيه «سحب رسومٍ» منتظرٌ برقم قيدٍ لا وجود له من بنكٍ آخر', async () => {
    const s = await setup();
    // ب برصيد 50000 هنا · والقالب (سحب ب كله) لا يُطبَّق: يُحذف من السحابة قبل سحب المالك
    s.r.docs.delete(s.tmpl.id);
    await ownerPulls(s.owner, s.r);
    const base = bal(s.owner, [s.A, s.B]); // [0, 50000, 0]
    const fee = forgeTx(s, { bank_id: s.B, amount_halalas: -50000, journal_no: 'JV-M3-لا-وجود', source: 'رسوم بنكية', descr: 'رسوم مزوَّرة M3' });
    const dep = forgeTx(s, { bank_id: s.A, amount_halalas: 50000, journal_no: '', source: CASH_DEPOSIT_SOURCE, descr: 'إيداع مزوَّر M3' });
    await ownerPulls(s.owner, s.r);
    const out = { base, owner: bal(s.owner, [s.A, s.B]), depositApplied: applied(s, dep), feeApplied: applied(s, fee),
      waiting: waiting(s.owner).map((x) => x.pk) };
    // eslint-disable-next-line no-console
    console.log('M3', JSON.stringify(out));
    // المحفظة صفر: الإيداع منها ينتظر (التطبيق: requireWalletCovers)، ولا تصير سالبة
    expect(out.owner[2]).toBeGreaterThanOrEqual(0);
    s.close();
  });

  test('(M8) سلسلة K2 المشروعة (وارد بقيد ثم سحب ثم صرف نثري) تعلق ما دامت في الوارد حركةٌ منتظرة لا صلة لها (سحب L6 من بنكٍ آخر)', async () => {
    const p = await pair();
    const A = addBank(p.owner, 'بنك أ مصطنع M8', 0);
    const C = addBank(p.owner, 'بنك ج مصطنع M8', 50000);
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    const since = snap(p.r);
    // L6: المالك يسحب من ج على جهازه، والعضو بلا اتصال يسحب منه أيضاً (حدٌّ معروف: ينتظر ثم يُرفض)
    withdrawCashFromBank(p.owner, { bankId: C, amountHalalas: 50000, date: '2026-10-09' });
    withdrawCashFromBank(p.dev, { bankId: C, amountHalalas: 50000, date: '2026-10-09' });
    // ثم سلسلة K2 كما في d4.auditK.bankTx على بنك أ
    recordManualBankTx(p.dev, { kind: 'income', bankId: A, amountHalalas: 200000, date: '2026-10-10', descr: 'وارد بنكي مصطنع M8' });
    withdrawCashFromBank(p.dev, { bankId: A, amountHalalas: 120000, date: '2026-10-11' });
    pettyCashExpense(p.dev, { amountHalalas: 120000, descr: 'مصروف نثري مصطنع M8', date: '2026-10-12' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    newAsMember(p.r, since);
    await ownerPulls(p.owner, p.r);
    await ownerPulls(p.owner, p.r);
    const k2 = p.owner.all<{ descr: string }>(`SELECT descr FROM bank_tx WHERE bank_id = ? AND deleted_at IS NULL`, [A]).map((x) => x.descr);
    const out = { ownerA: bal(p.owner, [A])[0], memberA: bal(p.dev, [A])[0], k2Applied: k2.length, waiting: waiting(p.owner).map((w) => w.tbl + ':' + w.last_error) };
    // eslint-disable-next-line no-console
    console.log('M8', JSON.stringify(out));
    // حركتا سلسلة K2 مستقلتان عن سحب ج: تُقبلان معاً كما في K2
    expect(out.k2Applied).toBe(2);
    p.close();
  });
});
