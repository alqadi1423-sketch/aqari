/**
 * مدقق خارجي K · الجولة السادسة · حارس حركة البنك من عضو على جهاز المالك (engine.ts · memberBankTxCheck) على e8d6c19 · بيانات مصطنعة.
 */
import { withdrawCashFromBank, depositCashToBank, ownerCashIn, pettyCashExpense, recordManualBankTx, transferBetweenBanks } from '@/domain/cashOps';
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { snap, newAsMember, bal, cash1100, rejects, waiting } from './helpers/auditI';
import type { RemoteDoc } from '@/sync/types';

async function setup(openingA = 0) {
  const p = await pair();
  const A = addBank(p.owner, 'بنك أ مصطنع K', openingA);
  const B = addBank(p.owner, 'بنك ب مصطنع K', 0);
  const C = addBank(p.owner, 'بنك ج مصطنع K', 0);
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, A, B, C };
}
const thirtyDays = async (s: Awaited<ReturnType<typeof setup>>) => {
  s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
};

describe('مدقق K · تدفقٌ مشروع من عضو يعلق عند المالك بفحص المحفظة الجديد (I٢)', () => {
  test('(K2) واردٌ بنكي بقيد، ثم سحبُ بعضه نقداً، ثم صرفُه نثرياً: الحركتان تنتظر كلٌّ منهما الأخرى أبداً', async () => {
    const s = await setup(0);
    const since = snap(s.r);
    // كل خطوةٍ يجيزها التطبيق على جهاز العضو: المحفظة صفر والبنك صفر في البداية
    recordManualBankTx(s.dev, { kind: 'income', bankId: s.A, amountHalalas: 200000, date: '2026-10-10', descr: 'وارد بنكي مصطنع K2' });
    withdrawCashFromBank(s.dev, { bankId: s.A, amountHalalas: 120000, date: '2026-10-11' });
    pettyCashExpense(s.dev, { amountHalalas: 120000, descr: 'مصروف نثري مصطنع K2', date: '2026-10-12' });
    await sync(s.dev, s.r);
    newAsMember(s.r, since);
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    const before = { owner: bal(s.owner, [s.A]), waiting: waiting(s.owner).map((w) => w.tbl) };
    await thirtyDays(s);
    const out = { before, owner: bal(s.owner, [s.A]), member: bal(s.dev, [s.A]), o1100: cash1100(s.owner), m1100: cash1100(s.dev),
      rejects: rejects(s.owner).map((r) => r.tbl + ': ' + r.reason), waiting: waiting(s.owner).map((w) => w.tbl) };
    // eslint-disable-next-line no-console
    console.log('K2', JSON.stringify(out));
    expect(out.owner).toEqual(out.member);
    expect(out.rejects).toEqual([]);
    expect(out.waiting).toEqual([]);
    s.close();
  });
});

describe('مدقق K · تزويرٌ يمرّ: إقران وارد التحويل (transferPaired)', () => {
  test('(K3) صادرٌ واحد من أ يُقرن بوارداتٍ مزوَّرة في بنوكٍ أخرى بالتاريخ والبيان والمبلغ نفسه: كلها تتخطى فحص المحفظة', async () => {
    const s = await setup(100000);
    const since = snap(s.r);
    // تحويلٌ مشروع أ ← ب
    transferBetweenBanks(s.dev, { fromBankId: s.A, toBankId: s.B, amountHalalas: 100000, date: '2026-10-05', notes: 'تحويل مصطنع K3' });
    await sync(s.dev, s.r);
    newAsMember(s.r, since);
    const inB = [...s.r.docs.values()].find((d) => d.t === 'bank_tx' && Number(d.d?.amount_halalas) > 0)!;
    // ووارداتٌ مزوَّرة بمثل نصفه الوارد في ج (وفي ب نفسه مرةً ثانية لا تُقرن: عدد الوارد فيه يساوي الصادر)
    const forge = (k: string, bank: string) => s.r.inject({ ...inB, id: 'bank_tx__' + k, k, by: MEMBER, op: 'banks',
      d: { ...inB.d, id: k, bank_id: bank, created_at: new Date().toISOString() } } as RemoteDoc);
    forge('k3-forged-c', s.C);
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    const out = { owner: bal(s.owner, [s.A, s.B, s.C]), cash1100: cash1100(s.owner),
      forgedApplied: !!s.owner.get(`SELECT 1 FROM bank_tx WHERE id = 'k3-forged-c'`), waiting: waiting(s.owner).map((w) => w.pk) };
    // eslint-disable-next-line no-console
    console.log('K3', JSON.stringify(out));
    // المحفظة صفر ولا نقد في الدفتر: الصادر الواحد يقابل وارداً واحداً، وما زاد عليه ينتظر كالإيداع، فلا تصير المحفظة سالبة
    // (على c01b21f: أحد الواردين ينتظر بحسب ترتيب الوصول، والمحفظة صفر في الترتيبين)
    expect(out.owner[3]).toBeGreaterThanOrEqual(0);
    s.close();
  });
  test('(K3ب) وأثره: المحفظة السالبة بالوارد المزوَّر توقف وارداً بنكياً مشروعاً بقيدٍ يأتي بعده (فحص I٢)', async () => {
    const s = await setup(100000);
    const since = snap(s.r);
    transferBetweenBanks(s.dev, { fromBankId: s.A, toBankId: s.B, amountHalalas: 100000, date: '2026-10-05', notes: 'تحويل مصطنع K3' });
    await sync(s.dev, s.r);
    newAsMember(s.r, since);
    const inB = [...s.r.docs.values()].find((d) => d.t === 'bank_tx' && Number(d.d?.amount_halalas) > 0)!;
    s.r.inject({ ...inB, id: 'bank_tx__k3b-forged-c', k: 'k3b-forged-c', by: MEMBER, op: 'banks',
      d: { ...inB.d, id: 'k3b-forged-c', bank_id: s.C, created_at: new Date().toISOString() } } as RemoteDoc);
    await ownerPulls(s.owner, s.r);
    await sync(s.dev, s.r);
    // ثم وارد بنكي مشروع بقيد (عمولة أو إيراد) من العضو
    const since2 = snap(s.r);
    recordManualBankTx(s.dev, { kind: 'income', bankId: s.B, amountHalalas: 50000, date: '2026-10-20', descr: 'وارد بنكي مشروع مصطنع K3b' });
    await sync(s.dev, s.r);
    newAsMember(s.r, since2);
    await ownerPulls(s.owner, s.r);
    await thirtyDays(s);
    const out = { owner: bal(s.owner, [s.A, s.B, s.C]), legitApplied: !!s.owner.get(`SELECT 1 FROM bank_tx WHERE descr = 'وارد بنكي مشروع مصطنع K3b'`),
      rejects: rejects(s.owner).map((r) => r.tbl + ': ' + r.reason) };
    // eslint-disable-next-line no-console
    console.log('K3b', JSON.stringify(out));
    expect(out.legitApplied).toBe(true);
    s.close();
  });
});
