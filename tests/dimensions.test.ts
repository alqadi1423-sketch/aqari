/**
 * أبعاد الدفتر ومراكز التكلفة (قرار المالك ٢٠٢٦-١٠-٠٤) · كل سطر قيدٍ يحمل العقار والوحدة والعقد ومركز التكلفة
 * والأصل · تُشتق من مستند القيد، ومركز التكلفة من الشاشة، والقديم يُملأ بأداةٍ تُعرض قبل التنفيذ · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import type { DB } from '@/db/adapter';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { savePurchase } from '@/domain/purchases';
import { saveInvoice } from '@/domain/invoices';
import { postManualEntry, reverseEntryById } from '@/domain/accounting/post';
import {
  GENERAL_COST_CENTER, withCostCenter, planDimsBackfill, applyDimsBackfill, addCostCenter, deleteCostCenter, costCenters,
} from '@/domain/accounting/dimensions';
import { trialBalance, costCenterReport, accountMovement } from '@/domain/accounting/ledger';
import { financialStatementBlock } from '@/domain/finStatements';

type Line = { account_code: string; property_id: string | null; unit_id: string | null; contract_id: string | null; cost_center_id: string | null };
const linesOf = (db: DB, entryId: string) => db.all<Line>(
  `SELECT account_code, property_id, unit_id, contract_id, cost_center_id FROM journal_lines WHERE entry_id = ? ORDER BY account_code`, [entryId]);
const entryOf = (db: DB, srcType: string, srcId: string) => (srcType === 'rent'
  ? db.get<{ id: string }>(`SELECT journal_entry_id AS id FROM contract_payments WHERE id = ?`, [srcId])!.id
  : db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = ? AND src_id = ?`, [srcType, srcId])!.id);

function world() {
  const db = memDb();
  const p1 = addProperty(db, { name: 'عقار الأبعاد الأول' });
  const p2 = addProperty(db, { name: 'عقار الأبعاد الثاني' });
  const u1 = addUnit(db, p1, { unit_no: 'D-1' });
  const u2 = addUnit(db, p2, { unit_no: 'D-2' });
  const c1 = confirmContract(db, contractInput(u1, { tenant: 'مستأجر أبعاد أول', idNumber: '1000008001', phone: '0500008001', depositHalalas: 0 }));
  const c2 = confirmContract(db, contractInput(u2, { tenant: 'مستأجر أبعاد ثانٍ', idNumber: '1000008002', phone: '0500008002', depositHalalas: 0 }));
  addCostCenter(db, 'cc-ops', 'تشغيل');
  return { db, p1, p2, u1, u2, c1, c2 };
}
const pay = (db: DB, c: string, amount: number) => {
  const i = db.get<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!;
  return recordRentPayment(db, c, { installmentId: i.id, period: i.due_date, date: i.due_date, lines: [{ method: 'cash', amountHalalas: amount }], discountHalalas: 0, notes: '' });
};

test('قيد التحصيل بأبعاد عقده ووحدته وعقاره · ومركز التكلفة من الشاشة، وافتراضه «عام»', () => {
  const { db, p1, u1, c1, c2 } = world();
  const a = pay(db, c1, 100000);
  for (const l of linesOf(db, entryOf(db, 'rent', a))) {
    expect([l.property_id, l.unit_id, l.contract_id, l.cost_center_id]).toEqual([p1, u1, c1, GENERAL_COST_CENTER]);
  }
  const b = withCostCenter('cc-ops', () => pay(db, c2, 100000));
  expect(linesOf(db, entryOf(db, 'rent', b)).every((l) => l.cost_center_id === 'cc-ops' && l.contract_id === c2)).toBe(true);
});

test('المشترى والفاتورة بعقارهما ووحدتهما · والعاكس بأبعاد أصله سطراً بسطر', () => {
  const { db, p1, p2, u2 } = world();
  const pur = withCostCenter('cc-ops', () => savePurchase(db, { supplier: 'مورد أبعاد', date: '2026-03-01', due: '2026-03-31', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null, exempt: true, excludeFromVat: false, subtotalHalalas: 5000, taxHalalas: 0, totalHalalas: 5000, propertyId: p1 }));
  const pe = entryOf(db, 'purchase', pur);
  expect(linesOf(db, pe).every((l) => l.property_id === p1 && l.unit_id === null && l.cost_center_id === 'cc-ops')).toBe(true);
  const inv = saveInvoice(db, { customer: 'عميل أبعاد', customerVat: '', issue: '2026-03-02', due: '2026-03-30', notes: '', unitId: u2, propertyId: p2, lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 10000, taxPct: 0 }] }, 'مستحقة');
  expect(linesOf(db, entryOf(db, 'invoice', inv)).every((l) => l.property_id === p2 && l.unit_id === u2)).toBe(true);
  const rev = reverseEntryById(db, pe, 'عكس اختبار')!;
  expect(linesOf(db, rev.id).map((l) => [l.property_id, l.cost_center_id])).toEqual(linesOf(db, pe).map((l) => [l.property_id, l.cost_center_id]));
});

test('القيد المرحّل: مبالغه وحساباته مجمّدة كما كانت · وأبعاده وحدها تُعدَّل', () => {
  const { db, c1, p2 } = world();
  const e = entryOf(db, 'rent', pay(db, c1, 50000));
  expect(() => db.run(`UPDATE journal_lines SET debit_halalas = debit_halalas + 1 WHERE entry_id = ?`, [e])).toThrow('قيد مرحّل لا يُعدَّل');
  expect(() => db.run(`UPDATE journal_lines SET account_code = '1100' WHERE entry_id = ?`, [e])).toThrow('قيد مرحّل لا يُعدَّل');
  db.run(`UPDATE journal_lines SET property_id = ? WHERE entry_id = ?`, [p2, e]);
  expect(linesOf(db, e).every((l) => l.property_id === p2)).toBe(true);
});

test('القيود القديمة: الأداة تعرض ما عُرف مصدره وما لم يُعرف · وتملأ المعروف بكلمة المالك ولا تمسّ غيره', () => {
  const { db, p1, u1, c1 } = world();
  const e = entryOf(db, 'rent', pay(db, c1, 70000));
  const manual = postManualEntry(db, { date: '2026-02-01', memo: 'قيد يدوي مصطنع', lines: [{ account: '1100', debit: 1000, credit: 0 }, { account: '3100', debit: 0, credit: 1000 }] })!;
  // كأنهما من إصدارٍ قبل الأبعاد
  db.run(`UPDATE journal_lines SET property_id = NULL, unit_id = NULL, contract_id = NULL, cost_center_id = NULL`);
  const plan = planDimsBackfill(db);
  expect(plan.known.map((k) => k.entryId)).toContain(e);
  expect(plan.unknown.map((k) => k.entryId)).toContain(manual.id);
  expect(linesOf(db, e)[0].property_id).toBeNull(); // العرض لا يطبّق شيئاً
  expect(applyDimsBackfill(db, plan)).toBe(plan.known.length);
  expect(linesOf(db, e).every((l) => l.property_id === p1 && l.unit_id === u1 && l.contract_id === c1 && l.cost_center_id === GENERAL_COST_CENTER)).toBe(true);
  expect(linesOf(db, manual.id).every((l) => l.property_id === null && l.cost_center_id === null)).toBe(true);
  expect(planDimsBackfill(db).known).toEqual([]);
});

test('التقارير تقبل التصفية بكل بُعد · وتقرير المصروفات والإيرادات حسب مركز التكلفة', () => {
  const { db, p1, p2, c1, c2 } = world();
  pay(db, c1, 100000);
  withCostCenter('cc-ops', () => pay(db, c2, 60000));
  const rev = (dims?: object) => accountMovement(db, '4200', null, null, dims as never).credit;
  expect(rev()).toBe(160000);
  expect(rev({ propertyId: p1 })).toBe(100000);
  expect(rev({ propertyId: p2 })).toBe(60000);
  expect(rev({ costCenterId: 'cc-ops' })).toBe(60000);
  expect(rev({ contractId: c1, costCenterId: 'cc-ops' })).toBe(0);
  const tb = trialBalance(db, null, null, { propertyId: p2 });
  expect(tb.find((r) => r.code === '4200')!.creditHalalas).toBe(60000);
  const income = financialStatementBlock(db, 'income', null, '2027-12-31', { propertyId: p1 });
  expect(JSON.stringify(income)).toContain('100000');
  const cc = costCenterReport(db, null, null);
  expect(cc.map((r) => [r.name, r.revenue])).toEqual([['عام', 100000], ['تشغيل', 60000]]);
});

test('مراكز التكلفة: «عام» لا يُحذف ولا يُكرَّر اسم · والمحذوف يخرج من القائمة وسطوره باقية', () => {
  const { db, c2 } = world();
  expect(() => deleteCostCenter(db, GENERAL_COST_CENTER)).toThrow('لا يُحذف');
  expect(() => db.run(`UPDATE cost_centers SET deleted_at = 'x' WHERE id = ?`, [GENERAL_COST_CENTER])).toThrow('لا يُحذف');
  expect(() => addCostCenter(db, 'cc-dup', 'تشغيل')).toThrow('بهذا الاسم');
  const e = entryOf(db, 'rent', withCostCenter('cc-ops', () => pay(db, c2, 1000)));
  deleteCostCenter(db, 'cc-ops');
  expect(costCenters(db).map((c) => c.name)).toEqual(['عام']);
  expect(linesOf(db, e)[0].cost_center_id).toBe('cc-ops');
});

test('ملء أبعاد القديم على جهاز المالك يصل إلى الجهاز الآخر · ولا يمسّ مبلغاً · ومستندٌ بلا أبعاد لا يمحوها', async () => {
  const { MemoryRemote } = await import('./helpers/memoryRemote');
  const { enableSync, syncOnce } = await import('@/sync/engine');
  const { getMeta } = await import('@/repos/settings');
  const { db: A, p1, c1 } = world();
  const r = new MemoryRemote();
  enableSync(A, 'U-DIMS');
  const pid = pay(A, c1, 90000);
  const e = entryOf(A, 'rent', pid);
  A.run(`UPDATE journal_lines SET property_id = NULL, unit_id = NULL, contract_id = NULL, cost_center_id = NULL WHERE entry_id = ?`, [e]);
  await syncOnce(A, r, getMeta(A, 'device_id')!);
  const B = memDb();
  enableSync(B, 'U-DIMS');
  await syncOnce(B, r, getMeta(B, 'device_id')!);
  expect(linesOf(B, e)[0].property_id).toBeNull();
  applyDimsBackfill(A, planDimsBackfill(A));
  await syncOnce(A, r, getMeta(A, 'device_id')!);
  await syncOnce(B, r, getMeta(B, 'device_id')!);
  expect(linesOf(B, e).every((l) => l.property_id === p1 && l.contract_id === c1)).toBe(true);
  const sum = (db: DB) => db.get<{ d: number }>(`SELECT SUM(debit_halalas) AS d FROM journal_lines WHERE entry_id = ?`, [e])!.d;
  expect(sum(B)).toBe(sum(A));
  // مستندٌ من إصدارٍ قديم بلا أبعاد · لا يمحو ما وصل
  const doc = (r as unknown as { docs: Map<string, { lines?: Array<Record<string, unknown>>; u: string }> }).docs.get('journal_entries__' + e)!;
  r.inject({ ...(doc as object), lines: doc.lines!.map(({ property_id, unit_id, contract_id, cost_center_id, asset_id, ...rest }) => rest), u: '2099-01-01T00:00:00.000Z', dev: 'old-device' } as never);
  await syncOnce(B, r, getMeta(B, 'device_id')!);
  expect(linesOf(B, e).every((l) => l.property_id === p1)).toBe(true);
});

test('ما لا يُعرف مصدره يبقى بلا أبعاد بإقرار المالك فيخرج من المراجعة · ووصف التصفية · والتدفق مصفّى', async () => {
  const { acknowledgeUnknownDims, dimsLabel } = await import('@/domain/accounting/dimensions');
  const { accountPeriodChange } = await import('@/domain/accounting/ledger');
  const { db, p1, p2, c1 } = world();
  const manual = postManualEntry(db, { date: '2026-02-01', memo: 'قيد يدوي مصطنع', lines: [{ account: '1100', debit: 1000, credit: 0 }, { account: '3100', debit: 0, credit: 1000 }] })!;
  db.run(`UPDATE journal_lines SET cost_center_id = NULL WHERE entry_id = ?`, [manual.id]);
  expect(planDimsBackfill(db).unknown.map((u) => u.entryId)).toEqual([manual.id]);
  expect(acknowledgeUnknownDims(db, [manual.id])).toBe(1);
  expect(planDimsBackfill(db).unknown).toEqual([]);
  expect(linesOf(db, manual.id).every((l) => l.property_id === null && l.cost_center_id === GENERAL_COST_CENTER)).toBe(true);
  expect(dimsLabel(db, {})).toBe('');
  expect(dimsLabel(db, { propertyId: p1, costCenterId: 'cc-ops' })).toBe('العقار: عقار الأبعاد الأول · مركز التكلفة: تشغيل');
  pay(db, c1, 40000);
  expect(accountPeriodChange(db, '4200', null, null, { propertyId: p1 })).toBe(40000);
  expect(accountPeriodChange(db, '4200', null, null, { propertyId: p2 })).toBe(0);
});

test('مركز العملية المنتظرة يبقى حتى تنتهي · ثم يعود «عام»', async () => {
  const { currentCostCenter } = await import('@/domain/accounting/dimensions');
  let seen = '';
  await withCostCenter('cc-ops', async () => { await Promise.resolve(); seen = currentCostCenter(); });
  expect(seen).toBe('cc-ops');
  expect(currentCostCenter()).toBe(GENERAL_COST_CENTER);
  expect(() => withCostCenter('cc-ops', () => { throw new Error('x'); })).toThrow('x');
  expect(currentCostCenter()).toBe(GENERAL_COST_CENTER);
});

test('مركز محذوفٌ يظهر باسمه في تقرير المراكز موسوماً بالحذف', () => {
  const { db, c2 } = world();
  withCostCenter('cc-ops', () => pay(db, c2, 2000));
  deleteCostCenter(db, 'cc-ops');
  expect(costCenterReport(db, null, null).map((r) => r.name)).toEqual(['تشغيل (محذوف)']);
});

describe('العملية بضغطة بلا نموذج ترث مركز مستندها الأصلي (قرار المالك ٢٠٢٦-١٠-٠٧)', () => {
  const ccOf = (db: DB, srcType: string, srcId: string) => db.get<{ c: string }>(
    `SELECT l.cost_center_id AS c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.src_type = ? AND e.src_id = ? ORDER BY e.created_at DESC LIMIT 1`, [srcType, srcId])!.c;

  test('تحصيل المطالبة من المطالبة · وإلغاء الحجز من الحجز · والشاشة إن اختارت تغلب', async () => {
    const { saveClaim, collectClaim } = await import('@/domain/claims');
    const { createReservation, cancelReservation } = await import('@/domain/reservations');
    const { db, c1, p2 } = world();
    const vacant = addUnit(db, p2, { unit_no: 'D-9' });
    const cl = withCostCenter('cc-ops', () => saveClaim(db, { contractId: c1, amountHalalas: 5000, reason: 'مطالبة مصطنعة', date: '2026-03-01' }));
    collectClaim(db, cl, '2026-03-05');
    expect(ccOf(db, 'claim_collect', cl)).toBe('cc-ops');
    const rv = withCostCenter('cc-ops', () => createReservation(db, { unitId: vacant, name: 'حاجز مصطنع', phone: '0500008009', depositHalalas: 1000, expiryDate: '2026-12-31' }));
    cancelReservation(db, rv, true, '2026-03-06');
    expect(ccOf(db, 'reservation_forfeit', rv)).toBe('cc-ops');
    // الشاشة اختارت «عام» صراحةً فلا يُورَث
    const cl2 = withCostCenter('cc-ops', () => saveClaim(db, { contractId: c1, amountHalalas: 3000, reason: 'مطالبة مصطنعة ثانية', date: '2026-03-02' }));
    withCostCenter(GENERAL_COST_CENTER, () => collectClaim(db, cl2, '2026-03-07'));
    expect(ccOf(db, 'claim_collect', cl2)).toBe(GENERAL_COST_CENTER);
  });

  test('الفاتورة التي تصدر لاحقاً ترث مركزها المحفوظ عند حفظها · وما لا أصل له «عام»', async () => {
    const { db, p1 } = world();
    const id = withCostCenter('cc-ops', () => saveInvoice(db, { customer: 'عميل مصطنع', customerVat: '', issue: '2026-03-02', due: '2026-03-30', notes: '', propertyId: p1, lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 10000, taxPct: 0 }] }, 'مسودة'));
    const { setInvoiceStatus } = await import('@/domain/invoices');
    setInvoiceStatus(db, id, 'مستحقة');
    expect(ccOf(db, 'invoice', id)).toBe('cc-ops');
    const m = postManualEntry(db, { date: '2026-02-01', memo: 'قيد مصطنع', lines: [{ account: '1100', debit: 10, credit: 0 }, { account: '3100', debit: 0, credit: 10 }] })!;
    expect(linesOf(db, m.id)[0].cost_center_id).toBe(GENERAL_COST_CENTER);
  });
});
