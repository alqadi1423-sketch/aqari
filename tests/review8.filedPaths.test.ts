/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ٩: كل مسار ترحيلٍ أو نقدٍ بتاريخٍ يختاره المستخدم يُرفض في ربعٍ قُدِّم إقراره،
 * ولا يُكتب منه شيء · ويُقبل التاريخ نفسه في فترةٍ مفتوحة (الاختبار الإيجابي) · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput, addBank } from './helpers/fixtures';
import { confirmContract, applyTenantCredit, renewContract } from '@/domain/contracts/service';
import { filedDiff } from '@/domain/vatFilings';
import { contractInput as ci } from './helpers/fixtures';
import { saveInvoice, payInvoice } from '@/domain/invoices';
import { savePurchase, payPurchase, payPurchaseSplit, markVatRefunded, markVatRejected, TS_DEDUCTIBLE, type PurchaseInput } from '@/domain/purchases';
import { saveClaim, collectClaim } from '@/domain/claims';
import { createReservation, cancelReservation } from '@/domain/reservations';
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { recordManualBankTx, ownerCashIn } from '@/domain/cashOps';
import { createPendingAsset, setAssetCost, transferAsset, disposeAsset, sellAsset } from '@/domain/assets/service';
import { fileVatReturn } from '@/domain/vatFilings';
import type { DB } from '@/db/adapter';

const FILED = '2026-03-20';
const OPEN = '2026-04-20';
const pur = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد ضريبي مصطنع', date: '2026-02-10', due: '2026-03-10', category: 'صيانة', incorpItem: '', amortize: false,
  amortizeMonths: null, exempt: false, excludeFromVat: false, taxStatus: TS_DEDUCTIBLE,
  subtotalHalalas: 10000, taxHalalas: 1500, totalHalalas: 11500, ...over,
} as PurchaseInput);
const writes = (db: DB) => Number(db.get<{ n: number }>(
  `SELECT (SELECT COUNT(*) FROM journal_entries) + (SELECT COUNT(*) FROM bank_tx) + (SELECT COUNT(*) FROM contract_payments) AS n`)!.n);

function world() {
  const db = memDb();
  // يُقدّم إقرار الربع الأول فهي مسجّلة، و«قابلة للخصم» لها وحدها (التوجيه الرابع ٣ · ٤ · القاعدة ٩٩)
  db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
  db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S1', 'مورد ضريبي مصطنع', '300000000000003', '2026-01-01')`);
  const bank = addBank(db, 'بنك مصطنع', 5_000_000);
  ownerCashIn(db, { amountHalalas: 5_000_000, date: '2026-01-02' });
  const p = addProperty(db, { name: 'عقار مصطنع' });
  const u = addUnit(db, p, { unit_no: 'F-1' });
  const free = addUnit(db, p, { unit_no: 'F-2' });
  const cid = confirmContract(db, contractInput(u, { start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  db.run(`UPDATE tenants SET credit_halalas = 50000 WHERE id = (SELECT tenant_id FROM contracts WHERE id = ?)`, [cid]);
  const inst = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  const invoice = saveInvoice(db, { customer: 'عميل مصطنع', customerVat: '', issue: '2026-02-10', due: '2026-02-10', notes: '',
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 10000, taxPct: 15, taxCode: 'S' }] }, 'مستحقة');
  const purchase = savePurchase(db, pur());
  const purchase2 = savePurchase(db, pur({ date: '2026-02-11' }));
  const claim = saveClaim(db, { contractId: cid, amountHalalas: 20000, reason: 'مطالبة مصطنعة', date: '2026-02-12' });
  const rsv = createReservation(db, { unitId: free, name: 'حاجز مصطنع', phone: '0500000091', depositHalalas: 30000, expiryDate: '2026-12-01' });
  const asset = createPendingAsset(db, { name: 'أصل مصطنع', category: '1410', unitId: u } as never);
  setAssetCost(db, asset, { costHalalas: 120000, purchaseDate: '2026-01-05', lifeMonths: 12, today: '2026-01-05' });
  const asset2 = createPendingAsset(db, { name: 'أصل مصطنع ثانٍ', category: '1410', unitId: u } as never);
  setAssetCost(db, asset2, { costHalalas: 120000, purchaseDate: '2026-01-05', lifeMonths: 12, today: '2026-01-05' });
  fileVatReturn(db, 2026, 1, '2026-04-15');
  return { db, bank, cid, inst, invoice, purchase, purchase2, claim, rsv, u, free, asset, asset2 };
}

type W = ReturnType<typeof world>;
const PATHS: Array<[string, (w: W, date: string) => unknown]> = [
  ['سداد فاتورة شراء', (w, d) => payPurchase(w.db, w.purchase, 'cash', null, d)],
  ['سداد فاتورة شراء مقسَّماً', (w, d) => payPurchaseSplit(w.db, w.purchase, [{ method: 'cash', amountHalalas: 11500 }], d)],
  ['استرداد ضريبة المدخلات', (w, d) => markVatRefunded(w.db, w.purchase, d)],
  ['رفض استرداد الضريبة', (w, d) => markVatRejected(w.db, w.purchase2, d)],
  ['تحصيل فاتورة', (w, d) => payInvoice(w.db, w.invoice, { method: 'cash', bankId: null, date: d })],
  ['تحصيل مطالبة', (w, d) => collectClaim(w.db, w.claim, d)],
  ['مطالبة جديدة', (w, d) => saveClaim(w.db, { contractId: w.cid, amountHalalas: 1000, reason: 'مطالبة مصطنعة', date: d })],
  ['إلغاء حجز بمصادرة العربون', (w, d) => cancelReservation(w.db, w.rsv, true, d)],
  ['إلغاء حجز بردّ العربون', (w, d) => cancelReservation(w.db, w.rsv, false, d)],
  ['تقبيل بعمولة', (w, d) => recordKeyMoneyDeal(w.db, { unitId: w.free, outgoing: 'طرف مصطنع أ', incoming: 'طرف مصطنع ب', amountHalalas: 900000,
    date: d, commissionHalalas: 10000, method: 'cash', notes: '' })],
  ['رسوم بنكية يدوية', (w, d) => recordManualBankTx(w.db, { kind: 'fee', bankId: w.bank, amountHalalas: 500, date: d, descr: 'رسوم مصطنعة' })],
  ['وارد بنكي يدوي', (w, d) => recordManualBankTx(w.db, { kind: 'income', bankId: w.bank, amountHalalas: 500, date: d, descr: 'وارد مصطنع' })],
  ['سداد من الرصيد الدائن', (w, d) => applyTenantCredit(w.db, w.cid, { installmentId: w.inst, amountHalalas: 10000, date: d })],
  ['نقل أصل', (w, d) => transferAsset(w.db, w.asset, { unitId: w.free, date: d, today: '2026-05-01' })],
  ['استبعاد أصل', (w, d) => disposeAsset(w.db, w.asset, { date: d, reason: 'سبب مصطنع', today: '2026-05-01' })],
  ['بيع أصل', (w, d) => sellAsset(w.db, w.asset2, { date: d, amountHalalas: 50000, method: 'cash', today: '2026-05-01' })],
];

test.each(PATHS)('٩ %s بتاريخٍ في ربعٍ مقدَّم مرفوض ولا يكتب شيئاً · وفي فترةٍ مفتوحة يُقبل', (_name, run) => {
  const w = world();
  const before = writes(w.db);
  expect(() => run(w, FILED)).toThrow(/قُدِّم|مقدَّم|إقرار/);
  expect(writes(w.db)).toBe(before);
  run(w, OPEN);
  expect(writes(w.db)).toBeGreaterThan(before);
  w.db.close();
});

test('٩ (التحقق المستقل) عقدٌ يُوثَّق متأخراً ببدايةٍ في ربعٍ مقدَّم: تأمينه وعربونه المحوَّل ودفعاته بتاريخ التصحيح لا في الفترة المجمَّدة', () => {
  const w = world();
  const u = addUnit(w.db, addProperty(w.db, { name: 'عقار مصطنع ثانٍ' }), { unit_no: 'G-1' });
  const rsv = createReservation(w.db, { unitId: u, name: 'حاجز مصطنع ثانٍ', phone: '0500000092', depositHalalas: 30000, expiryDate: '2026-12-01' });
  const q1 = () => Number(w.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE date <= '2026-03-31'`)!.n);
  const before = q1();
  confirmContract(w.db, { ...ci(u, { start: '2026-02-01', end: '2027-01-31', depositHalalas: 100000, idNumber: '1000000093' }), reservationId: rsv } as never);
  expect(q1()).toBe(before);
  expect(filedDiff(w.db, 2026, 1)).toEqual([]);
  w.db.close();
});

test('٩ (التحقق المستقل) تجديدٌ ببدايةٍ في ربعٍ مقدَّم: نقل التأمين والتأمين الإضافي بتاريخ التصحيح', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 5_000_000, date: '2025-01-02' });
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'H-1' });
  const cid = confirmContract(db, ci(u, { start: '2025-01-01', end: '2025-12-31', depositHalalas: 100000 }));
  fileVatReturn(db, 2026, 1, '2026-04-15');
  const q1 = () => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE date >= '2026-01-01' AND date <= '2026-03-31'`)!.n);
  const before = q1();
  renewContract(db, cid, { start: '2026-01-01', end: '2026-12-31', valueHalalas: 2400000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 50000, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  expect(q1()).toBe(before);
  db.close();
});
