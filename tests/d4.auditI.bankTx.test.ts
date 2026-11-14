/**
 * مدقق خارجي (I) · الجولة الخامسة · حارس حركة البنك على جهاز المالك (engine.ts · memberBankTxCheck) على 662e4ae · بيانات مصطنعة.
 * الحارس يحكم على الحركة بأثرها: رصيد البنك = افتتاحيه + حركاته الحية، والمحفظة = 1100 − حركات البنوك · وحركة قيدٍ قائم بإشارة نقده
 * وفي حدّه · فيُجرَّب: (أ) تضخيم البنك من جدولٍ آخر (افتتاحي البنك)، (ب) أثر الحركة المربوطة بقيدٍ في المحفظة، (ج) تدفقات مشروعة.
 */
import {
  withdrawCashFromBank, depositCashToBank, ownerCashIn, pettyCashExpense, recordManualBankTx, transferBetweenBanks,
} from '@/domain/cashOps';
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { restoreFromTrash } from '@/domain/trash';
import { savePurchase, payPurchaseSplit, deletePurchase, type PurchaseInput } from '@/domain/purchases';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { snap, newAsMember, bal, cash1100, rejects, waiting } from './helpers/auditI';
import type { RemoteDoc } from '@/sync/types';

async function setup(openingA = 0) {
  const p = await pair();
  const A = addBank(p.owner, 'بنك أ مصطنع I', openingA);
  const B = addBank(p.owner, 'بنك ب مصطنع I', 0);
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, A, B };
}

describe('مدقق I · تضخيم البنك والمحفظة بما لا يفحصه الحارس', () => {
  test('(I1) العضو (مدير البنوك) يعدّل افتتاحي بنكٍ ثم يسحبه نقداً: يقبله المالك فتفوق المحفظة نقدية الدفتر 1100', async () => {
    const s = await setup(0);
    const since = snap(s.r);
    // كما يحفظه نموذج «تعديل الحساب البنكي» (app/banks.tsx · save): الافتتاحي حقلٌ حر ولو كان للبنك حركات
    s.dev.run(`UPDATE banks SET opening_halalas = ? WHERE id = ?`, [100000000, s.A]);
    withdrawCashFromBank(s.dev, { bankId: s.A, amountHalalas: 100000000, date: '2026-11-01' });
    // ويصرفه مصروفاً نثرياً من المحفظة
    pettyCashExpense(s.dev, { amountHalalas: 100000000, descr: 'مصروف مصطنع I1', date: '2026-11-02' });
    await sync(s.dev, s.r);
    newAsMember(s.r, since);
    await ownerPulls(s.owner, s.r);
    const out = {
      owner: bal(s.owner, [s.A]), cash1100: cash1100(s.owner),
      opening: s.owner.get<{ o: number }>(`SELECT opening_halalas AS o FROM banks WHERE id = ?`, [s.A])!.o,
      wd: !!s.owner.get(`SELECT 1 FROM bank_tx WHERE source = 'سحب نقدي إلى المحفظة'`), rejects: rejects(s.owner), waiting: waiting(s.owner),
    };
    // eslint-disable-next-line no-console
    console.log('I1', JSON.stringify(out));
    // قبل التغيير: لا بنك ولا نقد · والحارس يقرأ الافتتاحي مالاً موثوقاً: سحبٌ بلا قيد بمليون ريال يُطبَّق، ونقده يُصرف من الدفتر
    expect(out.wd).toBe(false);
    // والافتتاحي عند المالك لم يتغيّر: قاعدة السحابة ترفض افتتاحيّ العضو (openingKept · القاعدة ٩٩ بعد I١، ثم O٥) فلا يصل
    expect(out.opening).toBe(0);
    // ومصروف العضو من نقدٍ رُفض سحبه يُقبل كأي صرفٍ نقدي متزامن (L٥): المحفظة سالبة ظاهرةً لا مخفية · حدٌّ معروف (DESIGN §١٣.١٨ هـ)
    s.close();
  });

  test('(I2) حركة بنكٍ جديدة برقم قيد إيداع المالك نقداً (قيدٌ قائم صُرف نقده): يقبلها المالك فتصير المحفظة سالبة', async () => {
    const s = await setup(0);
    ownerCashIn(s.owner, { amountHalalas: 500000, date: '2026-11-01' });
    pettyCashExpense(s.owner, { amountHalalas: 500000, descr: 'مصروف المالك مصطنع I2', date: '2026-11-01' });
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    const no = s.owner.get<{ no: string }>(`SELECT e.no FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.src_type = 'cash_op' AND l.account_code = '1100' AND l.debit_halalas > 0`)!.no;
    expect(bal(s.owner, [s.A, s.B])).toEqual([0, 0, 0]);
    // لا مسار في التطبيق يربط حركةً جديدة بقيدٍ قائم قبلها · العضو يكتبها بنفسه (قسم البنوك)
    const tx: RemoteDoc = {
      id: 'bank_tx__i2-tx', t: 'bank_tx', k: 'i2-tx', u: new Date().toISOString(), dev: 'dev-i2', by: MEMBER, op: 'banks', del: false,
      d: { id: 'i2-tx', bank_id: s.B, date: '2026-11-01', descr: 'حركة مصطنعة I2', amount_halalas: 500000, matched: 1, journal_no: no,
        source: 'تحصيل', created_at: new Date().toISOString(), deleted_at: null },
    } as RemoteDoc;
    s.r.inject(tx);
    await ownerPulls(s.owner, s.r);
    const out = { owner: bal(s.owner, [s.A, s.B]), cash1100: cash1100(s.owner), applied: !!s.owner.get(`SELECT 1 FROM bank_tx WHERE id = 'i2-tx'`),
      rejects: rejects(s.owner), waiting: waiting(s.owner) };
    // eslint-disable-next-line no-console
    console.log('I2', JSON.stringify(out));
    // المحفظة لا تصير سالبة (قرار المالك 2026-10-05)، ولا يظهر في بنكٍ نقدٌ صُرف من المحفظة
    expect(out.owner[2]).toBeGreaterThanOrEqual(0);
    s.close();
  });
});

describe('مدقق I · «الحذف» بقيمةٍ يعدّها الحارس حيّةً والدفتر محذوفة', () => {
  test.each([['سحبٌ نقدي بلا قيد', false], ['سدادٌ من البنك مربوطٌ بقيد', true]])(
    '(I3) %s صُرف أثره، ثم deleted_at = \'\' (نصٌّ فارغ): الحارس يراه «تعديلاً لا يمسّ شيئاً» والرصيد يراه محذوفاً', async (_l, linked) => {
      const s = await setup(100000);
      s.dev.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
        ['SUP-I3', 'مورد مصطنع I3', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
      const since = snap(s.r);
      if (!linked) {
        withdrawCashFromBank(s.dev, { bankId: s.A, amountHalalas: 100000, date: '2026-11-01' });
        pettyCashExpense(s.dev, { amountHalalas: 100000, descr: 'مصروف مصطنع I3', date: '2026-11-01' });
      } else {
        const pid = savePurchase(s.dev, {
          supplier: 'مورد مصطنع I3', date: '2026-10-15', due: '2026-11-15', category: 'صيانة', incorpItem: '', amortize: false,
          amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: null, propertyId: null, meterId: null, meterReading: null,
          subtotalHalalas: 100000, taxHalalas: 0, totalHalalas: 100000,
        } as PurchaseInput);
        payPurchaseSplit(s.dev, pid, [{ method: 'bank', bankId: s.A, amountHalalas: 100000 }], '2026-10-16');
      }
      await sync(s.dev, s.r);
      newAsMember(s.r, since);
      await ownerPulls(s.owner, s.r);
      const before = bal(s.owner, [s.A]);
      const tx = [...s.r.docs.values()].find((d) => d.t === 'bank_tx')!;
      s.r.inject({ ...tx, by: MEMBER, op: 'banks', d: { ...tx.d, deleted_at: '' } } as RemoteDoc);
      await ownerPulls(s.owner, s.r);
      const out = { before, after: bal(s.owner, [s.A]), stored: s.owner.get<{ x: string | null }>(`SELECT deleted_at AS x FROM bank_tx WHERE id = ?`, [tx.k])?.x,
        inTrash: !!s.owner.get(`SELECT 1 FROM bank_tx WHERE id = ? AND deleted_at IS NOT NULL`, [tx.k]), rejects: rejects(s.owner) };
      // eslint-disable-next-line no-console
      console.log('I3', linked, JSON.stringify(out));
      // حذفُ حركةٍ صُرف أثرها لا يُطبَّق (G3)، وحركة القيد القائم لا تُحذف
      expect(out.after).toEqual(out.before);
      s.close();
    });
});

describe('مدقق I · تدفقاتٌ مشروعة من عضو: يقبلها المالك كما في دفتره', () => {
  const same = (s: Awaited<ReturnType<typeof setup>>) => {
    const out = { owner: bal(s.owner, [s.A, s.B]), member: bal(s.dev, [s.A, s.B]), o1100: cash1100(s.owner), m1100: cash1100(s.dev),
      rejects: rejects(s.owner), waiting: waiting(s.owner) };
    return out;
  };

  test('(L1) تقبيلٌ بعمولةٍ في البنك، إلغاؤه بتاريخٍ يختاره المستخدم ثم استعادته، ثم إلغاءٌ واستعادةٌ ثانيان', async () => {
    const s = await setup(0);
    const pa = addProperty(s.owner, { name: 'عقار تقبيل I مصطنع' });
    const ua = addUnit(s.owner, pa, { unit_no: 'KI-A' });
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    const since = snap(s.r);
    const deal = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: null, outgoing: 'متنازل I', incoming: 'متنازل له I', amountHalalas: 5000000,
      date: '2026-06-01', commissionHalalas: 230000, method: 'bank', bankId: s.A, notes: '' });
    const e1 = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [deal])!.id;
    const a1 = entrySourceAction(s.dev, e1) as { kind: 'op'; run: (d: string, r: string) => void };
    a1.run('2026-08-15', 'سبب مصطنع');
    restoreFromTrash(s.dev, 'key_money_deals', deal);
    const e2 = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [deal])!.id;
    const a2 = entrySourceAction(s.dev, e2) as { kind: 'op'; run: (d: string, r: string) => void };
    a2.run('2026-10-20', 'سبب مصطنع ٢');
    restoreFromTrash(s.dev, 'key_money_deals', deal);
    await sync(s.dev, s.r);
    newAsMember(s.r, since);
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    const out = same(s);
    // eslint-disable-next-line no-console
    console.log('L1', JSON.stringify(out));
    expect(out.owner).toEqual(out.member);
    expect(out.rejects).toEqual([]);
    s.close();
  });

  test('(L2) فاتورة شراءٍ سُدّدت مقسّمةً على بنكين ونقداً، ثم حُذفت واستُعيدت', async () => {
    const s = await setup(0);
    ownerCashIn(s.owner, { amountHalalas: 1000000, date: '2026-10-01' });
    // والبنكان يكفيان شطرَيهما: السداد من البنك لا يُنزله تحت الصفر (سجل القرارات ٥٥ · وكان أحدهما بلا رصيد)
    depositCashToBank(s.owner, { bankId: s.A, amountHalalas: 100000, date: '2026-10-01' });
    depositCashToBank(s.owner, { bankId: s.B, amountHalalas: 150000, date: '2026-10-01' });
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    s.dev.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
      ['SUP-I2', 'مورد مصطنع I', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
    const since = snap(s.r);
    const pid = savePurchase(s.dev, {
      supplier: 'مورد مصطنع I', date: '2026-10-15', due: '2026-11-15', category: 'صيانة', incorpItem: '', amortize: false,
      amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: null, propertyId: null, meterId: null, meterReading: null,
      subtotalHalalas: 300000, taxHalalas: 0, totalHalalas: 300000,
    } as PurchaseInput);
    payPurchaseSplit(s.dev, pid, [
      { method: 'bank', bankId: s.A, amountHalalas: 100000 }, { method: 'card', bankId: s.B, amountHalalas: 150000 },
      { method: 'cash', amountHalalas: 50000 }], '2026-10-16');
    deletePurchase(s.dev, pid);
    restoreFromTrash(s.dev, 'purchases', pid);
    await sync(s.dev, s.r);
    newAsMember(s.r, since);
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    const out = same(s);
    // eslint-disable-next-line no-console
    console.log('L2', JSON.stringify(out));
    expect(out.owner).toEqual(out.member);
    expect(out.rejects).toEqual([]);
    s.close();
  });

  test('(L3) رسومٌ ووارد بنكيان يدويان، ثم إلغاء الوارد من مصدره، وإيداعٌ وسحبٌ نقديان، وتعديل «مطابَقة»', async () => {
    const s = await setup(300000);
    ownerCashIn(s.owner, { amountHalalas: 200000, date: '2026-10-01' });
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    const since = snap(s.r);
    recordManualBankTx(s.dev, { kind: 'income', bankId: s.A, amountHalalas: 11500, date: '2026-10-10', descr: 'وارد مصطنع I' });
    recordManualBankTx(s.dev, { kind: 'fee', bankId: s.A, amountHalalas: 2500, date: '2026-10-11', descr: 'رسوم مصطنعة I' });
    const inc = s.dev.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'cash_op' AND id IN (SELECT entry_id FROM journal_lines WHERE account_code = '4300')`)!.id;
    (entrySourceAction(s.dev, inc) as { kind: 'op'; run: (d: string, r: string) => void }).run('2026-10-12', 'سبب مصطنع');
    depositCashToBank(s.dev, { bankId: s.B, amountHalalas: 150000, date: '2026-10-13' });
    withdrawCashFromBank(s.dev, { bankId: s.A, amountHalalas: 200000, date: '2026-10-14' });
    s.dev.run(`UPDATE bank_tx SET matched = 0`);
    await sync(s.dev, s.r);
    newAsMember(s.r, since);
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    const out = same(s);
    // eslint-disable-next-line no-console
    console.log('L3', JSON.stringify(out));
    expect(out.owner).toEqual(out.member);
    expect(out.rejects).toEqual([]);
    s.close();
  });

  test('(L4) تحصيل إيجارٍ مقسّمٍ على بنكين ثم إلغاء الدفعة بتاريخٍ يختاره المستخدم', async () => {
    const s = await setup(0);
    const pa = addProperty(s.owner, { name: 'عقار تحصيل I مصطنع' });
    const ua = addUnit(s.owner, pa, { unit_no: 'CI-A' });
    const cid = confirmContract(s.owner, contractInput(ua, { tenant: 'مستأجر تحصيل I مصطنع', idNumber: '1000000091', phone: '0555550091' }));
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    const since = snap(s.r);
    const inst = s.dev.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
    const pay = recordRentPayment(s.dev, cid, { installmentId: inst, period: 'الأول', date: '2026-02-01',
      lines: [{ method: 'bank', bankId: s.A, amountHalalas: 120000 }, { method: 'cheque', bankId: s.B, amountHalalas: 80000 }], discountHalalas: 0, notes: '' });
    cancelPayment(s.dev, pay, { date: '2026-03-10', reason: 'سبب مصطنع' });
    await sync(s.dev, s.r);
    for (const d of [...s.r.docs.values()]) {
      if (since.get(d.id) === d.ts || d.by === MEMBER) continue;
      const { ts: _t, ...doc } = d as RemoteDoc & { ts: string };
      s.r.inject({ ...doc, by: MEMBER, op: d.t === 'bank_tx' ? 'collect' : 'collect' } as RemoteDoc);
    }
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    const out = same(s);
    // eslint-disable-next-line no-console
    console.log('L4', JSON.stringify(out));
    expect(out.owner).toEqual(out.member);
    expect(out.rejects).toEqual([]);
    s.close();
  });

  test('(L5) تحويلٌ بين بنكين من عضو والمحفظة عند المالك سالبة (صرفٌ نقدي متزامن من الجهازين): نصفه الوارد ينتظر ثم يُرفض', async () => {
    const s = await setup(100000);
    ownerCashIn(s.owner, { amountHalalas: 50000, date: '2026-10-01' });
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    // الجهازان بلا اتصال: كلٌّ يصرف نقد المحفظة نفسه (requireCash يمرّ على كلٍّ منهما)
    pettyCashExpense(s.owner, { amountHalalas: 50000, descr: 'مصروف المالك مصطنع L5', date: '2026-10-02' });
    const since = snap(s.r);
    pettyCashExpense(s.dev, { amountHalalas: 50000, descr: 'مصروف العضو مصطنع L5', date: '2026-10-02' });
    // ثم يحوّل العضو رصيد أ كله إلى ب: لا يمسّ المحفظة
    transferBetweenBanks(s.dev, { fromBankId: s.A, toBankId: s.B, amountHalalas: 100000, date: '2026-10-03' });
    await sync(s.dev, s.r);
    newAsMember(s.r, since);
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    await sync(s.dev, s.r);
    const before = same(s);
    // ثلاثون يوماً ولم يتغيّر شيء
    s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
    await ownerPulls(s.owner, s.r);
    const after = same(s);
    // eslint-disable-next-line no-console
    console.log('L5', JSON.stringify({ before, after }));
    // الدفترا متفقان في المحفظة (سالبة في الاثنين بالصرف المتزامن) · والتحويل لا يمسّها فيصل كاملاً
    expect(after.owner).toEqual(after.member);
    s.close();
  });

  test('(L6) المالك يسدّد من البنك (بلا فحص رصيد) والعضو يسحب من البنك نفسه في الوقت ذاته: السحب ينتظر ثم يُرفض فيختلف الدفتران', async () => {
    const s = await setup(100000);
    s.owner.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
      ['SUP-L6', 'مورد مصطنع L6', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    // المالك: فاتورة شراءٍ تُسدَّد من أ (payPurchaseSplit لا يفحص رصيد البنك)
    const pid = savePurchase(s.owner, {
      supplier: 'مورد مصطنع L6', date: '2026-10-15', due: '2026-11-15', category: 'صيانة', incorpItem: '', amortize: false,
      amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: null, propertyId: null, meterId: null, meterReading: null,
      subtotalHalalas: 100000, taxHalalas: 0, totalHalalas: 100000,
    } as PurchaseInput);
    payPurchaseSplit(s.owner, pid, [{ method: 'bank', bankId: s.A, amountHalalas: 100000 }], '2026-10-16');
    // العضو بلا اتصال: يسحب رصيد أ نقداً (رصيده عنده يكفي)
    const since = snap(s.r);
    withdrawCashFromBank(s.dev, { bankId: s.A, amountHalalas: 100000, date: '2026-10-16' });
    await sync(s.dev, s.r);
    newAsMember(s.r, since);
    await ownerPulls(s.owner, s.r);
    s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
    await ownerPulls(s.owner, s.r);
    await sync(s.dev, s.r);
    const out = same(s);
    // eslint-disable-next-line no-console
    console.log('L6', JSON.stringify(out));
    // حدٌّ معروف موثَّق (DESIGN §١٣.١٨ هـ): جهاز المالك لا يعرف ما رآه العضو بلا اتصال، فلا يميّز السحب المتزامن من سحبٍ مزوَّر من بنكٍ
    // فارغ (G٥ وG٦) · فيبقى البنك عنده غير سالب، ويُسجَّل الرفض ظاهراً لا صامتاً · ويُحسم بشاشة التعارضات في القسم ٥
    expect(out.owner[0]).toBeGreaterThanOrEqual(0);
    expect(s.owner.get(`SELECT 1 FROM sync_rejects WHERE tbl = 'bank_tx'`)).toBeTruthy();
    s.close();
  });
});
