/**
 * مدقق خارجي (G) · الجولة الرابعة · memberBankTxCheck (src/sync/engine.ts) على 97d0beb · بيانات مصطنعة.
 * الحارس الجديد: حركة البنك من عضوٍ بلا رقم قيد تُقبل لمصدري الإيداع والسحب النقديين وحدهما وفي حدود الرصيد، وبرقم قيدٍ في حدود نقد
 * القيد (1100) وبإشارته · و«تعديلٌ لا يمسّ المبلغ ولا القيد ولا المصدر يمرّ»، و«المحذوفة تُطبَّق».
 */
import {
  transferBetweenBanks, withdrawCashFromBank, depositCashToBank, pettyCashExpense, ownerCashIn,
} from '@/domain/cashOps';
import { deleteBankTx } from '@/domain/bankTx';
import { restoreFromTrash } from '@/domain/trash';
import { bankBalance, walletCashBalance } from '@/domain/accounting/ledger';
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, reasonOf, MEMBER } from './helpers/rederive';
import type { MemoryRemote } from './helpers/memoryRemote';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';

/** كل حركات البنك الجديدة في الحساب بكاتبها العضو (قسم البنوك) */
function txAsMember(r: MemoryRemote, seen: Set<string>): RemoteDoc[] {
  const out: RemoteDoc[] = [];
  for (const d of [...r.docs.values()]) {
    if (d.t !== 'bank_tx' || seen.has(d.id)) continue;
    const { ts: _ts, ...doc } = d as RemoteDoc & { ts: string };
    r.inject({ ...doc, by: MEMBER, op: 'banks' } as RemoteDoc);
    seen.add(d.id);
    out.push(doc as RemoteDoc);
  }
  return out;
}
const bal = (db: DB, banks: string[]) => [...banks.map((b) => bankBalance(db, b)), walletCashBalance(db)];

async function setup(openingA: number) {
  const p = await pair();
  const A = addBank(p.owner, 'بنك أ مصطنع G', openingA);
  const B = addBank(p.owner, 'بنك ب مصطنع G', 0);
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, A, B, seen: new Set<string>() };
}

describe('مدقق G · حركة البنك من عضو بعد هـ٩', () => {
  test('(G1) تحويلٌ بين بنكين من عضو (transferBetweenBanks · مسارٌ في التطبيق بلا رقم قيد): يقبله المالك كما في دفتر العضو', async () => {
    const s = await setup(500000);
    transferBetweenBanks(s.dev, { fromBankId: s.A, toBankId: s.B, amountHalalas: 100000, date: '2026-11-01' });
    await sync(s.dev, s.r);
    const txs = txAsMember(s.r, s.seen);
    await ownerPulls(s.owner, s.r);
    const out = { owner: bal(s.owner, [s.A, s.B]), member: bal(s.dev, [s.A, s.B]), reasons: txs.map((t) => reasonOf(s.owner, t.k)) };
    // eslint-disable-next-line no-console
    console.log('G1', JSON.stringify(out));
    expect(out.owner).toEqual(out.member);
    s.close();
  });

  test('(G2) سحبٌ نقدي من أ ثم إيداعه في ب في التزامٍ واحد (وقت الخادم واحد · الترتيب بمعرّف المستند): يقبلهما المالك', async () => {
    const s = await setup(500000);
    withdrawCashFromBank(s.dev, { bankId: s.A, amountHalalas: 100000, date: '2026-11-01' });
    depositCashToBank(s.dev, { bankId: s.B, amountHalalas: 100000, date: '2026-11-01' });
    await sync(s.dev, s.r);
    // التزام Firestore الواحد يختم مستنداته بوقت الطلب نفسه (REQUEST_TIME)، والمالك يطبّق بالرتبة ثم الوقت ثم المعرّف · ومعرّف الحركة
    // uid() عشوائي، فالإيداع يسبق السحب في نصف الحالات: نسمّيهما بما يسبق فيه الإيداع
    const docs = [...s.r.docs.values()].filter((d) => d.t === 'bank_tx');
    const ts = docs[0].ts;
    for (const d of docs) {
      s.r.docs.delete(d.id);
      const k = Number(d.d!.amount_halalas) > 0 ? 'g2-a-dep' : 'g2-b-wd';
      s.r.docs.set('bank_tx__' + k, { ...d, id: 'bank_tx__' + k, k, by: MEMBER, op: 'banks', ts, d: { ...d.d, id: k } } as RemoteDoc & { ts: string });
    }
    await ownerPulls(s.owner, s.r);
    const out = { owner: bal(s.owner, [s.A, s.B]), member: bal(s.dev, [s.A, s.B]), dep: reasonOf(s.owner, 'g2-a-dep'), wd: reasonOf(s.owner, 'g2-b-wd') };
    // eslint-disable-next-line no-console
    console.log('G2', JSON.stringify(out));
    expect(out.owner).toEqual(out.member);
    s.close();
  });

  test('(G3) حذفٌ مزوَّر لحركة سحبٍ صُرف نقدها: يُرفع رصيد البنك بلا مال · لا يقبله المالك', async () => {
    const s = await setup(100000);
    withdrawCashFromBank(s.dev, { bankId: s.A, amountHalalas: 100000, date: '2026-11-01' });
    pettyCashExpense(s.dev, { amountHalalas: 100000, descr: 'مصروف نثري مصطنع G3', date: '2026-11-01' });
    await sync(s.dev, s.r);
    const [wd] = txAsMember(s.r, s.seen);
    for (const d of [...s.r.docs.values()].filter((x) => x.t === 'journal_entries')) s.r.inject({ ...d, by: MEMBER, op: 'banks' });
    await ownerPulls(s.owner, s.r);
    const before = bal(s.owner, [s.A]);
    expect(before).toEqual([0, 0]);
    // العضو لا يستطيع حذفها في التطبيق (requireCash) · فيكتب شاهد الحذف بنفسه
    expect(() => deleteBankTx(s.dev, wd.k)).toThrow();
    s.r.inject({ ...wd, by: MEMBER, op: 'banks', d: { ...wd.d, deleted_at: '2026-11-02T00:00:00.000Z' } } as RemoteDoc);
    await ownerPulls(s.owner, s.r);
    const out = { before, after: bal(s.owner, [s.A]), applied: s.owner.get<{ x: string | null }>(`SELECT deleted_at AS x FROM bank_tx WHERE id = ?`, [wd.k])?.x ?? null };
    // eslint-disable-next-line no-console
    console.log('G3', JSON.stringify(out));
    expect(out.after).toEqual([0, 0]);
    s.close();
  });

  test('(G4) استعادة إيداعٍ من السلة بعد صرف نقده بإيداعٍ آخر (restoreFromTrash): «تعديلٌ لا يمسّ المبلغ» يمرّ والمحفظة سالبة', async () => {
    const s = await setup(0);
    ownerCashIn(s.owner, { amountHalalas: 100000, date: '2026-11-01' });
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    depositCashToBank(s.dev, { bankId: s.A, amountHalalas: 100000, date: '2026-11-01' });
    await sync(s.dev, s.r);
    const [dep1] = txAsMember(s.r, s.seen);
    await ownerPulls(s.owner, s.r);
    expect(bal(s.owner, [s.A])).toEqual([100000, 0]);
    deleteBankTx(s.dev, dep1.k);
    await sync(s.dev, s.r);
    s.r.inject({ ...s.r.docs.get(dep1.id)!, by: MEMBER, op: 'banks' });
    await ownerPulls(s.owner, s.r);
    expect(bal(s.owner, [s.A])).toEqual([0, 100000]);
    depositCashToBank(s.dev, { bankId: s.A, amountHalalas: 100000, date: '2026-11-02' });
    await sync(s.dev, s.r);
    txAsMember(s.r, s.seen);
    await ownerPulls(s.owner, s.r);
    expect(bal(s.owner, [s.A])).toEqual([100000, 0]);
    // الاستعادة من السلة صارت تفحص المحفظة على جهاز العضو (إصلاح G٤) · والحارس على جهاز المالك يُختبر بمستند استعادةٍ مزوَّر
    expect(() => restoreFromTrash(s.dev, 'bank_tx', dep1.k)).toThrow();
    const cur = s.r.docs.get(dep1.id)!;
    s.r.inject({ ...cur, by: MEMBER, op: 'banks', d: { ...cur.d, deleted_at: null } } as RemoteDoc);
    await ownerPulls(s.owner, s.r);
    const out = { owner: bal(s.owner, [s.A]), member: bal(s.dev, [s.A]), reason: reasonOf(s.owner, dep1.k) };
    // eslint-disable-next-line no-console
    console.log('G4', JSON.stringify(out));
    expect(out.owner[1]).toBeGreaterThanOrEqual(0);
    expect(out.owner[0]).toBe(100000);
    s.close();
  });

  test('(G5) نقل حركة سحبٍ إلى بنكٍ آخر بتعديل bank_id وحده: يمرّ بلا فحص فيُسحب من أ ثانيةً ما ليس فيه', async () => {
    const s = await setup(100000);
    withdrawCashFromBank(s.dev, { bankId: s.A, amountHalalas: 100000, date: '2026-11-01' });
    await sync(s.dev, s.r);
    const [wd] = txAsMember(s.r, s.seen);
    await ownerPulls(s.owner, s.r);
    expect(bal(s.owner, [s.A, s.B])).toEqual([0, 0, 100000]);
    s.r.inject({ ...wd, by: MEMBER, op: 'banks', d: { ...wd.d, bank_id: s.B } } as RemoteDoc);
    await ownerPulls(s.owner, s.r);
    const mid = bal(s.owner, [s.A, s.B]);
    s.r.inject({ ...wd, id: 'bank_tx__g5-wd2', k: 'g5-wd2', by: MEMBER, op: 'banks', d: { ...wd.d, id: 'g5-wd2' } } as RemoteDoc);
    await ownerPulls(s.owner, s.r);
    const out = { mid, after: bal(s.owner, [s.A, s.B]) };
    // eslint-disable-next-line no-console
    console.log('G5', JSON.stringify(out));
    // لا بنك سالب، ولا محفظةٌ فوق ما أُخرج من البنوك فعلاً (100000)
    expect(Math.min(...out.after.slice(0, 2))).toBeGreaterThanOrEqual(0);
    expect(out.after[2]).toBeLessThanOrEqual(100000);
    s.close();
  });

  test('(G6) حركاتٌ بإشارتين برقم قيدٍ واحد على بنكين (المجموع في حدود نقده): رصيد ب أضعاف نقد القيد', async () => {
    const s = await setup(0);
    ownerCashIn(s.owner, { amountHalalas: 500000, date: '2026-11-01' });
    await sync(s.owner, s.r);
    const no = s.owner.get<{ no: string }>(`SELECT no FROM journal_entries WHERE src_type = 'cash_op'`)!.no;
    const base: RemoteDoc = {
      id: '', t: 'bank_tx', k: '', u: new Date().toISOString(), dev: 'dev-g6', by: MEMBER, op: 'banks', del: false,
      d: { id: '', bank_id: s.B, date: '2026-11-01', descr: 'حركة مصطنعة G6', amount_halalas: 0, matched: 1, journal_no: no, source: 'G6',
        created_at: new Date().toISOString(), deleted_at: null },
    } as RemoteDoc;
    const tx = (k: string, bank: string, amount: number): RemoteDoc =>
      ({ ...base, id: 'bank_tx__' + k, k, d: { ...base.d, id: k, bank_id: bank, amount_halalas: amount } } as RemoteDoc);
    // كل حركةٍ في سحبٍ مستقل: المجموع 500000 ثم 0 ثم 500000 ...
    const seq: Array<[string, number]> = [[s.B, 500000], [s.A, -500000], [s.B, 500000], [s.A, -500000], [s.B, 500000]];
    for (const [i, [bank, amount]] of seq.entries()) {
      s.r.inject(tx('g6-' + i, bank, amount));
      await ownerPulls(s.owner, s.r);
    }
    const mid = bal(s.owner, [s.A, s.B]);
    // ثم سحبٌ نقدي من ب بكل «رصيده» إلى المحفظة
    s.r.inject({ ...tx('g6-wd', s.B, -1500000), d: { ...tx('g6-wd', s.B, -1500000).d, journal_no: '', source: 'سحب نقدي إلى المحفظة' } } as RemoteDoc);
    await ownerPulls(s.owner, s.r);
    const out = { mid, owner: bal(s.owner, [s.A, s.B]), cash1100: 500000,
      applied: seq.map((_, i) => !!s.owner.get(`SELECT 1 FROM bank_tx WHERE id = ?`, ['g6-' + i])),
      wd: !!s.owner.get(`SELECT 1 FROM bank_tx WHERE id = 'g6-wd'`) };
    // eslint-disable-next-line no-console
    console.log('G6', JSON.stringify(out));
    // حركات القيد لا تتجاوز نقده في أي بنك، ولا بنك سالب، والمحفظة لا تتجاوز النقدية
    expect(out.mid[1]).toBeLessThanOrEqual(500000);
    expect(out.owner[0]).toBeGreaterThanOrEqual(0);
    expect(out.owner[2]).toBeLessThanOrEqual(500000);
    s.close();
  });
});

import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';

/** كل ما رفعه الجهاز الثاني بكاتبه العضو */
function everythingAsMember(r: MemoryRemote, seen: Set<string>) {
  for (const d of [...r.docs.values()]) {
    if (seen.has(d.id) || d.by === MEMBER) continue;
    const { ts: _t, ...doc } = d as RemoteDoc & { ts: string };
    r.inject({ ...doc, by: MEMBER, op: d.t === 'bank_tx' || d.t === 'banks' ? 'banks' : 'contracts' } as RemoteDoc);
    seen.add(d.id);
  }
}

describe('مدقق G · تحصيلٌ نقدي ثم إيداعه في البنك من عضو', () => {
  test.each([['عقدٌ قائم عند المالك', false], ['عقدٌ جديد يؤكده العضو في الجلسة نفسها', true]])('(G7) %s: تحصيل نقدي ثم إيداعه في رفعٍ واحد · يقبلهما المالك', async (_l, fresh) => {
    const s = await setup(0);
    const pa = addProperty(fresh ? s.dev : s.owner, { name: 'عقار تحصيل G مصطنع' });
    const ua = addUnit(fresh ? s.dev : s.owner, pa, { unit_no: 'G7-A' });
    let cid = '';
    if (!fresh) {
      cid = confirmContract(s.owner, contractInput(ua, { tenant: 'مستأجر تحصيل G مصطنع', idNumber: '1000000081', phone: '0555550081' }));
      await sync(s.owner, s.r);
      await sync(s.dev, s.r);
    } else {
      cid = confirmContract(s.dev, contractInput(ua, { tenant: 'مستأجر تحصيل G مصطنع', idNumber: '1000000081', phone: '0555550081' }));
    }
    const inst = s.dev.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
    recordRentPayment(s.dev, cid, { installmentId: inst, period: 'الأول', date: '2026-02-01', lines: [{ method: 'cash', amountHalalas: 200000 }], discountHalalas: 0, notes: '' });
    depositCashToBank(s.dev, { bankId: s.A, amountHalalas: 200000, date: '2026-02-02' });
    await sync(s.dev, s.r);
    everythingAsMember(s.r, s.seen);
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    const dep = s.dev.get<{ id: string }>(`SELECT id FROM bank_tx WHERE source = 'إيداع نقدي من المحفظة'`)!.id;
    const out = { owner: bal(s.owner, [s.A]), member: bal(s.dev, [s.A]), dep: reasonOf(s.owner, dep),
      rejects: s.owner.all(`SELECT tbl, reason FROM sync_rejects`), waiting: s.owner.all(`SELECT tbl, last_error FROM sync_inbox`) };
    // eslint-disable-next-line no-console
    console.log('G7', JSON.stringify(out));
    expect(out.owner).toEqual(out.member);
    s.close();
  });
});

import { memDb } from './helpers/testDb';
describe('G٤ في التطبيق نفسه: الاستعادة من السلة عكس الحذف', () => {
  test('استعادة إيداعٍ صُرف نقده في إيداعٍ آخر تُرفض، واستعادة سحبٍ يكفيه البنك تُقبل', () => {
    const db = memDb();
    const A = addBank(db, 'بنك مصطنع للاستعادة', 0);
    ownerCashIn(db, { amountHalalas: 100000, date: '2026-11-01' });
    depositCashToBank(db, { bankId: A, amountHalalas: 100000, date: '2026-11-01' });
    const dep = db.get<{ id: string }>(`SELECT id FROM bank_tx ORDER BY created_at DESC LIMIT 1`)!.id;
    deleteBankTx(db, dep);
    depositCashToBank(db, { bankId: A, amountHalalas: 100000, date: '2026-11-02' });
    expect(() => restoreFromTrash(db, 'bank_tx', dep)).toThrow();
    expect([bankBalance(db, A), walletCashBalance(db)]).toEqual([100000, 0]);
    withdrawCashFromBank(db, { bankId: A, amountHalalas: 40000, date: '2026-11-03' });
    const wd = db.get<{ id: string }>(`SELECT id FROM bank_tx WHERE amount_halalas < 0`)!.id;
    deleteBankTx(db, wd);
    expect(() => restoreFromTrash(db, 'bank_tx', wd)).not.toThrow();
    expect([bankBalance(db, A), walletCashBalance(db)]).toEqual([60000, 40000]);
  });
});
