/**
 * المراجعة الشاملة 2026-11-13 · المراجع A1 (دورة الإيجار) · بيانات مصطنعة كلها.
 *
 * A1-2 · عالٍ · src/domain/contracts/service.ts:756-828 (applyDepositSettlement) · src/domain/accounting/post.ts:363-375
 *        (depositDeductLines) · src/domain/accrual.ts:411-416
 *   السيناريو: عقد ١٢٬٠٠٠ ريال (2025-11-01 إلى 2026-10-31) بأقساط شهرية ١٬٠٠٠ وتأمين ١٬٠٠٠ لدى المكتب · سدّد المستأجر
 *   أحد عشر قسطاً وغادر ولم يدفع قسط أكتوبر 2026 · فسوّى المالك التأمين بخصمه كاملاً «إيجار أكتوبر غير المدفوع» وردّ صفر.
 *   النتيجة اليوم:
 *     - الخصم يذهب إلى 4300 «إيراد من خصم التأمين»، وقسط أكتوبر يبقى مفتوحاً: ملف المستأجر يقول «متأخرات ١٬٠٠٠»،
 *       وشاشة التحصيل والتنبيهات ورسائل المطالبة تطالبه بها، وهي مدفوعة من تأمينه.
 *     - إيراد الاستحقاق في الرئيسية للسنة ١٣٬٠٠٠ لا ١٢٬٠٠٠: قيمة العقد كاملة (ومنها أكتوبر) + الخصم في 4300 مرة ثانية.
 *     - ولو زاد الخصم على التأمين لصار الزائد مطالبةً فوق الأقساط المفتوحة نفسها، فيُطالَب بالمبلغ مرتين.
 *   لماذا يهم: أشيع حالة في نهاية العقود (المستأجر يغادر وعليه آخر شهر)، والمالك يرى ديناً ليس له ويرسل مطالبة خاطئة.
 *   السلوك الصحيح: الخصم الذي يغطي متأخرات الإيجار يُسدّد به القسط المفتوح (دفعةٌ «من التأمين» مدين 2400 / دائن إيراد
 *   الإيجار بتقسيمه)، فيصير المتبقي صفراً والإيراد ١٢٬٠٠٠ مرة واحدة · وخصم الأضرار يبقى 4300.
 *   (اسم الخيار coverArrears في الاختبار كان اقتراحاً؛ ما يُختبر هو الأثر لا الاسم · صار arrearsHalalas «منها مقابل أقساطٍ متأخرة»
 *    بقرار المالك س١)
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, saveDepositSettlement, recordRentPayment, cancelContract, depositArrearsDue } from '@/domain/contracts/service';
import { tenantProfile } from '@/domain/tenants';
import { periodRevenueAccrual } from '@/domain/accrual';
import { accountBalance } from '@/domain/accounting/ledger';
import { planCancelPayment } from '@/domain/contracts/cancelPayment';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { integrityChecks } from '@/domain/accounting/integrity';
import { t } from '@/i18n';
import { pair, sync, ownerPulls, asMember, has, reasonOf, doubled, MEMBER } from './helpers/rederive';
import type { DB } from '@/db/adapter';

test('A1-2 خصم التأمين مقابل قسطٍ لم يُدفع يسدّد القسط ولا يُحسب إيراداً مرتين', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار متأخرات مصطنع' }), { unit_no: 'M-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر متأخرات مصطنع', idNumber: '1000000927',
    valueHalalas: 1200000, cycle: 'شهرية', start: '2025-11-01', end: '2026-10-31', depositHalalas: 100000 }));
  const insts = db.all<{ id: string; due_date: string; amount_halalas: number }>(
    `SELECT id, due_date, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  expect(insts).toHaveLength(12);
  for (const i of insts.slice(0, 11)) {
    recordRentPayment(db, cid, { installmentId: i.id, period: '', date: i.due_date,
      lines: [{ method: 'cash', amountHalalas: Number(i.amount_halalas) }], discountHalalas: 0, notes: '' });
  }
  // التسوية: التأمين كله مقابل إيجار أكتوبر غير المدفوع
  saveDepositSettlement(db, cid, { date: '2026-11-05', deductionHalalas: 100000, deductionReason: 'إيجار أكتوبر غير المدفوع',
    refundHalalas: 0, notes: '', arrearsHalalas: 100000 });

  const tid = db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [cid])!.t;
  // لا دين على المستأجر بعد أن سُدّد أكتوبر من تأمينه (اليوم: ١٬٠٠٠)
  expect(tenantProfile(db, tid, '2026-11-13')!.totals.outstanding).toBe(0);
  // الإيراد بالأساس النقدي ١٢٬٠٠٠ مرة واحدة · وبالاستحقاق كذلك (اليوم: ١٣٬٠٠٠)
  const cashRevenue = accountBalance(db, '4200') + accountBalance(db, '4300');
  expect(cashRevenue).toBe(1200000);
  expect(periodRevenueAccrual(db, '2025-11-01', '2026-11-30')).toBe(1200000);
  db.close();
});

// ═══ تتمة A1-2 · الأرقام محسوبة باليد · بيانات مصطنعة ═══

/** عقد ١٢٬٠٠٠ ريال (2025-11-01 إلى 2026-10-31) بأقساط شهرية ١٬٠٠٠ وتأمين ١٬٠٠٠ · يُسدَّد منه أول «paid» قسطاً نقداً */
function lease(db: DB, paid: number, n: number, holder?: string) {
  const u = addUnit(db, addProperty(db, { name: 'عقار متأخرات مصطنع ' + n }), { unit_no: 'M-' + n });
  const cid = confirmContract(db, { ...contractInput(u, { tenant: 'مستأجر متأخرات مصطنع ' + n, idNumber: '10000009' + String(n).padStart(2, '0'),
    phone: '05000009' + String(n).padStart(2, '0'), valueHalalas: 1200000, cycle: 'شهرية', start: '2025-11-01', end: '2026-10-31',
    depositHalalas: 100000 }), ...(holder ? { depositHolder: holder } : {}) } as never);
  const insts = db.all<{ id: string; due_date: string; amount_halalas: number }>(
    `SELECT id, due_date, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  for (const i of insts.slice(0, paid)) {
    recordRentPayment(db, cid, { installmentId: i.id, period: '', date: i.due_date,
      lines: [{ method: 'cash', amountHalalas: Number(i.amount_halalas) }], discountHalalas: 0, notes: '' });
  }
  const tid = db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [cid])!.t;
  return { cid, insts, tid };
}
const statusOf = (db: DB, id: string) => {
  const r = db.get<{ s: string; p: number }>(`SELECT status AS s, paid_halalas AS p FROM contract_installments WHERE id = ?`, [id])!;
  return { s: r.s, p: Number(r.p) };
};
const openClaims = (db: DB, cid: string) => Number(db.get<{ n: number }>(
  `SELECT COALESCE(SUM(amount_halalas), 0) AS n FROM claims WHERE contract_id = ? AND deleted_at IS NULL AND status = 'مفتوحة'`, [cid])!.n);
const livePays = (db: DB, cid: string) => db.all<{ id: string; journal_entry_id: string; net_halalas: number; installment_id: string }>(
  `SELECT id, journal_entry_id, net_halalas, installment_id FROM contract_payments WHERE contract_id = ? AND method_label = 'من التأمين' AND cancelled_at IS NULL`, [cid]);

test('A1-2 خصمٌ يتجاوز التأمين: الأقساط تُسدَّد منه أولاً، والمطالبة بما زاد على الأقساط وحده', () => {
  const db = memDb();
  // سدّد عشرة أقساط (نوفمبر إلى أغسطس) وبقي سبتمبر وأكتوبر ٢٬٠٠٠ · والخصم ٢٬٥٠٠: ٢٬٠٠٠ للقسطين و٥٠٠ أضرار
  const { cid, insts, tid } = lease(db, 10, 1);
  expect(depositArrearsDue(db, cid, '2026-11-05')).toBe(200000);
  saveDepositSettlement(db, cid, { date: '2026-11-05', deductionHalalas: 250000, deductionReason: 'إيجار سبتمبر وأكتوبر وأضرار',
    refundHalalas: 0, notes: '', arrearsHalalas: 200000 });
  // التأمين ١٬٠٠٠ يسدّد سبتمبر كاملاً (أقدم استحقاقاً) · وأكتوبر ١٬٠٠٠ يبقى على قسطه
  expect(statusOf(db, insts[10].id)).toEqual({ s: 'مدفوعة', p: 100000 });
  expect(statusOf(db, insts[11].id)).toEqual({ s: 'مستحقة', p: 0 });
  // المطالبة = الزيادة ١٬٥٠٠ ناقص ما بقي على الأقساط ١٬٠٠٠ = ٥٠٠ (الأضرار) · لا ١٬٥٠٠ فوق أكتوبر المفتوح (قبل الإصلاح: ١٬٥٠٠)
  expect(openClaims(db, cid)).toBe(50000);
  // فالمطلوب من المستأجر ١٬٠٠٠ قسطاً + ٥٠٠ مطالبةً = ١٬٥٠٠ = الخصم ٢٬٥٠٠ ناقص التأمين ١٬٠٠٠، مرةً واحدة
  expect(tenantProfile(db, tid, '2026-11-13')!.totals.outstanding).toBe(100000);
  // الدفتر: التزام التأمين صفر · الإيجار ١٠٬٠٠٠ نقداً + ١٬٠٠٠ من التأمين · و4300 المطالبة ٥٠٠ وحدها (لا خصم 4300: المخصوم كله أقساط)
  expect(accountBalance(db, '2400')).toBe(0);
  expect(accountBalance(db, '4200')).toBe(1100000);
  expect(accountBalance(db, '4300')).toBe(50000);
  expect(db.get(`SELECT 1 FROM journal_entries WHERE src_type = 'deposit_deduct' AND src_id = ?`, [cid])).toBeUndefined();
  // الاستحقاق: قيمة العقد ١٢٬٠٠٠ مرة واحدة + الأضرار ٥٠٠
  expect(periodRevenueAccrual(db, '2025-11-01', '2026-11-30')).toBe(1250000);
  // وصفّ التسوية بالمخصوم من التأمين نفسه
  expect(Number(db.get<{ d: number }>(`SELECT deduction_halalas AS d FROM deposit_settlements WHERE contract_id = ?`, [cid])!.d)).toBe(100000);
  // وفحوص مطابقة الدفتر كلها خضراء (التزام التأمين، والدفعات بقيودها، ولا يتيم)
  expect(integrityChecks(db).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  db.close();
});

test('A1-2 تعديل التسوية يعكس دفعات التأمين قبل إعادة التطبيق · ودفعة التأمين لا تُلغى وحدها', () => {
  const db = memDb();
  const { cid, insts, tid } = lease(db, 11, 2);
  const settle = (arrears: number) => saveDepositSettlement(db, cid, { date: '2026-11-05', deductionHalalas: 100000,
    deductionReason: 'إيجار أكتوبر أو أضرار', refundHalalas: 0, notes: '', arrearsHalalas: arrears });
  settle(100000);
  const [pay] = livePays(db, cid);
  expect(pay.installment_id).toBe(insts[11].id);
  // لا «إلغاء الدفعة» لها: تُعدَّل من التسوية · وزرّ «إلغاء من مصدره» يفتح مستندها (التسوية في شاشة العقد)
  expect(planCancelPayment(db, pay.id).blockers).toEqual([t('payment.cancelFromSettlement')]);
  expect(entrySourceAction(db, pay.journal_entry_id)).toEqual({ kind: 'document' });

  // التعديل إلى «أضرار كلها»: دفعة التأمين ملغاةٌ بعاكس قيدها، وأكتوبر يعود مستحقاً، والخصم كله 4300
  settle(0);
  expect(livePays(db, cid)).toHaveLength(0);
  const old = db.get<{ c: string | null; e: string | null }>(`SELECT cancelled_at AS c, cancel_entry_id AS e FROM contract_payments WHERE id = ?`, [pay.id])!;
  expect(old.c).not.toBeNull();
  expect(db.get(`SELECT src_type AS s FROM journal_entries WHERE id = ?`, [old.e])).toEqual({ s: 'deposit_rent_rev' });
  expect(db.get(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [pay.journal_entry_id])).toEqual({ r: old.e });
  expect(statusOf(db, insts[11].id)).toEqual({ s: 'مستحقة', p: 0 });
  expect(tenantProfile(db, tid, '2026-11-13')!.totals.outstanding).toBe(100000);
  expect(accountBalance(db, '4200')).toBe(1100000);
  expect(accountBalance(db, '4300')).toBe(100000);
  expect(accountBalance(db, '2400')).toBe(0);

  // والعودة إلى «إيجار أكتوبر»: دفعةٌ واحدة حيّة، والأرقام كالتسوية الأولى
  settle(100000);
  expect(livePays(db, cid)).toHaveLength(1);
  expect(tenantProfile(db, tid, '2026-11-13')!.totals.outstanding).toBe(0);
  expect(accountBalance(db, '4200')).toBe(1200000);
  expect(accountBalance(db, '4300')).toBe(0);
  expect(periodRevenueAccrual(db, '2025-11-01', '2026-11-30')).toBe(1200000);

  // تعديلٌ يُرفض لا يمسّ شيئاً: مقابل الأقساط ١٬٥٠٠ والمتبقي عليها (بما سدّده التأمين) ١٬٠٠٠
  expect(() => saveDepositSettlement(db, cid, { date: '2026-11-05', deductionHalalas: 150000, deductionReason: 'تجربة',
    refundHalalas: 0, notes: '', arrearsHalalas: 150000 })).toThrow(t('deposit.arrearsOverDue', { due: '1,000.00' }));
  expect(livePays(db, cid)).toHaveLength(1);
  expect(accountBalance(db, '4200')).toBe(1200000);
  // ولا يتجاوز الخصم نفسه
  expect(() => saveDepositSettlement(db, cid, { date: '2026-11-05', deductionHalalas: 50000, deductionReason: 'تجربة',
    refundHalalas: 50000, notes: '', arrearsHalalas: 100000 })).toThrow(t('deposit.arrearsOverDeduction'));
  expect(integrityChecks(db).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  db.close();
});

test('A1-2 التأمين لدى المنصة: القسط يُسدَّد إيجاراً والمخصوم كله يستقر من محتجزاتها · ولدى طرف آخر لا يُسدَّد منه قسط', () => {
  const db = memDb();
  const { cid, tid } = lease(db, 11, 3, 'منصة إيجار');
  saveDepositSettlement(db, cid, { date: '2026-11-05', deductionHalalas: 100000, deductionReason: 'إيجار أكتوبر', refundHalalas: 0,
    notes: '', deductDestination: 'حسابنا', arrearsHalalas: 100000 });
  expect(tenantProfile(db, tid, '2026-11-13')!.totals.outstanding).toBe(0);
  // قبض التأمين 1260/2400 ثم سداد أكتوبر 2400/4200 ثم الاستقرار 1100/1260 · النقد ١١٬٠٠٠ أقساطاً + ١٬٠٠٠ من المنصة
  expect(accountBalance(db, '1260')).toBe(0);
  expect(accountBalance(db, '2400')).toBe(0);
  expect(accountBalance(db, '4200')).toBe(1200000);
  expect(accountBalance(db, '4300')).toBe(0);
  expect(accountBalance(db, '1100')).toBe(1200000);

  const other = lease(db, 11, 4, 'طرف آخر');
  expect(() => saveDepositSettlement(db, other.cid, { date: '2026-11-05', deductionHalalas: 100000, deductionReason: 'إيجار أكتوبر',
    refundHalalas: 0, notes: '', deductReceived: true, arrearsHalalas: 100000 })).toThrow(t('deposit.arrearsOtherHolder'));
  db.close();
});

test('A1-2 الإلغاء بتسوية: «منها مقابل أقساطٍ متأخرة» تسدّد ما حلّ بتاريخ الإلغاء', () => {
  const db = memDb();
  const { cid, insts, tid } = lease(db, 6, 5);
  // سُدّد نوفمبر إلى أبريل · مايو (2026-05-01) ويونيو (2026-06-01) حلّا ولم يُدفعا · والإلغاء 2026-06-15 بخصم التأمين ١٬٠٠٠ كله لهما
  expect(depositArrearsDue(db, cid, '2026-06-15')).toBe(200000);
  cancelContract(db, cid, { date: '2026-06-15', reason: 'إخلاء مصطنع', installmentsFate: 'cancel', settle: true,
    deductionHalalas: 100000, refundHalalas: 0, deductionReason: 'إيجار مايو', arrearsHalalas: 100000 });
  // مايو أقدمهما فيُسدَّد · ويونيو حلّ قبل الإلغاء فيبقى مستحقاً ١٬٠٠٠ · وما بعده ملغى
  expect(statusOf(db, insts[6].id)).toEqual({ s: 'مدفوعة', p: 100000 });
  expect(statusOf(db, insts[7].id)).toEqual({ s: 'مستحقة', p: 0 });
  expect(statusOf(db, insts[8].id).s).toBe('ملغية');
  expect(tenantProfile(db, tid, '2026-06-20')!.totals.outstanding).toBe(100000);
  expect(accountBalance(db, '2400')).toBe(0);
  expect(accountBalance(db, '4200')).toBe(700000);
  expect(accountBalance(db, '4300')).toBe(0);
  expect(Number(db.get<{ d: number }>(`SELECT cancel_deduction_halalas AS d FROM contracts WHERE id = ?`, [cid])!.d)).toBe(100000);
  db.close();
});

describe('A1-2 إعادة اشتقاق قيد سداد القسط من التأمين على جهاز المالك', () => {
  async function setup(n: number) {
    const p = await pair();
    const u = addUnit(p.owner, addProperty(p.owner, { name: 'عقار تسوية متأخرات مصطنع ' + n }), { unit_no: 'DR-' + n });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    // عقد ثلاثة أشهر ٣٬٠٠٠ بأقساط ١٬٠٠٠ وتأمين ١٬٥٠٠ · لم يُدفع شيء · على الجهاز الثاني ثم في الحساب وعلى جهاز المالك
    const cid = confirmContract(p.dev, contractInput(u, { tenant: 'مستأجر تسوية متأخرات مصطنع ' + n, idNumber: '10000033' + String(n).padStart(2, '0'),
      phone: '05000033' + String(n).padStart(2, '0'), valueHalalas: 300000, cycle: 'شهرية', start: '2026-01-01', end: '2026-03-31', depositHalalas: 150000 }));
    await sync(p.dev, p.r);
    await ownerPulls(p.owner, p.r);
    // الخصم ١٬٥٠٠: منه ١٬٢٠٠ للأقساط (يناير ١٬٠٠٠ وفبراير ٢٠٠) و٣٠٠ أضرار في 4300
    saveDepositSettlement(p.dev, cid, { date: '2026-04-05', deductionHalalas: 150000, deductionReason: 'إيجار وأضرار مصطنعة',
      refundHalalas: 0, notes: '', arrearsHalalas: 120000 });
    await sync(p.dev, p.r);
    return { ...p, cid };
  }
  /** قيود التسوية ودفعات التأمين في الحساب بكاتبها العضو */
  function allAsMember(r: Awaited<ReturnType<typeof pair>>['r']): string[] {
    const ids: string[] = [];
    for (const d of [...r.docs.values()]) {
      const entry = d.t === 'journal_entries' && /^deposit_(rent|deduct)(_rev)?$/.test(String(d.d?.src_type));
      if (!entry && !(d.t === 'contract_payments' && d.d?.method_label === 'من التأمين')) continue;
      r.inject({ ...d, by: MEMBER });
      if (entry) ids.push(d.k);
    }
    return ids;
  }

  test('إيجابي · ما يكتبه التطبيق يُقبل: قيدا السداد وقيد الأضرار بما بقي، والأقساط مسدَّدة على جهاز المالك', async () => {
    const s = await setup(1);
    const ids = allAsMember(s.r);
    expect(ids).toHaveLength(3);
    await ownerPulls(s.owner, s.r);
    for (const k of ids) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    const paid = s.owner.all<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [s.cid]).map((x) => Number(x.p));
    expect(paid).toEqual([100000, 20000, 0]);
    expect(accountBalance(s.owner, '4200')).toBe(120000);
    expect(accountBalance(s.owner, '4300')).toBe(30000);
    expect(accountBalance(s.owner, '2400')).toBe(0);
    s.close();
  });

  test('إيجابي · تعديل العضو التسوية إلى «أضرار كلها»: عكس السداد ووسم دفعاته ملغاةً يُقبلان، والأقساط تعود مستحقة', async () => {
    const s = await setup(4);
    allAsMember(s.r);
    await ownerPulls(s.owner, s.r);
    saveDepositSettlement(s.dev, s.cid, { date: '2026-04-05', deductionHalalas: 150000, deductionReason: 'أضرار مصطنعة',
      refundHalalas: 0, notes: '', arrearsHalalas: 0 });
    await sync(s.dev, s.r);
    const ids = allAsMember(s.r);
    await ownerPulls(s.owner, s.r);
    for (const k of ids) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    const paid = s.owner.all<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [s.cid]).map((x) => Number(x.p));
    expect(paid).toEqual([0, 0, 0]);
    expect(s.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL`, [s.cid])!.n).toBe(0);
    expect(accountBalance(s.owner, '4200')).toBe(0);
    expect(accountBalance(s.owner, '4300')).toBe(150000);
    expect(accountBalance(s.owner, '2400')).toBe(0);
    s.close();
  });

  test('سلبي · قيد السداد من التأمين بضعف دفعته: يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup(2);
    allAsMember(s.r);
    const k = asMember(s.r, 'deposit_rent', doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).not.toBe('');
    s.close();
  });

  test('سلبي · قيد الخصم بالمخصوم كله في 4300 مع سداد الأقساط منه (يُحسب مرتين): يُرفض', async () => {
    const s = await setup(3);
    allAsMember(s.r);
    const k = asMember(s.r, 'deposit_deduct', (ls) => ls.map((l) => ({ ...l,
      debit_halalas: Number(l.debit_halalas) ? 150000 : 0, credit_halalas: Number(l.credit_halalas) ? 150000 : 0 })));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/4300|2400/);
    s.close();
  });
});
