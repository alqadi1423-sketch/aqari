/**
 * المراجعة الشاملة 2026-11-13 · E-10 (قرار المالك س٣٠): رقم سند القبض متسلسلٌ من العدّاد مثل بقية المستندات (`RCP-2026-0001`) بدل
 * المشتق من المعرّف · يُحفظ مع الدفعة عند تسجيلها من كتل الجهاز (الهجرة ٦٥: contract_payments.receipt_no)، ويُبحث به، ويبقى رقم ما طُبع
 * قبل التغيير كما هو · بيانات مصطنعة، والمبالغ بالهللات.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { addBlock, planBlocks, blockRequests, SERIES } from '@/domain/numbering';
import { receiptNoOf, paymentsByReceipt } from '@/domain/receipts';
import { SCHEMA_VERSION, MIGRATIONS } from '@/db/schema';
import { generateOrgRules } from '@/domain/access/rulesGen';

function payOne(db: ReturnType<typeof memDb>, date = '2026-02-03') {
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: '3' }),
    { start: '2026-01-01', end: '2026-12-31', valueHalalas: 1_200_000, depositHalalas: 0 }));
  const inst = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  return recordRentPayment(db, cid, { installmentId: inst.id, date, period: '', discountHalalas: 0, notes: '',
    lines: [{ method: 'cash', amountHalalas: 100_000 }] });
}

test('E-10 الهجرة ٦٥: عمود رقم السند في الدفعات', () => {
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(65);
  expect(MIGRATIONS[64]).toMatch(/receipt_no/);
});

test('E-10 جهازان بلا اتصال بكتلتين من العدّاد: رقمان مختلفان متسلسلان، والطباعة بالمحفوظ', () => {
  expect(SERIES).toContain('RCP');
  // العدّاد يحجز للجهازين كتلتين لا تتداخلان
  const a = planBlocks({}, [{ series: 'RCP', size: 200, floor: 0, gap: 0 }]);
  const b = planBlocks(a.next, [{ series: 'RCP', size: 200, floor: 0, gap: 0 }]);
  const db1 = memDb(); const db2 = memDb();
  addBlock(db1, 'RCP', a.out[0].lo, a.out[0].hi);
  addBlock(db2, 'RCP', b.out[0].lo, b.out[0].hi);
  const p1 = payOne(db1); const p2 = payOne(db2);
  const n1 = db1.get<{ n: string }>(`SELECT receipt_no n FROM contract_payments WHERE id = ?`, [p1])!.n;
  const n2 = db2.get<{ n: string }>(`SELECT receipt_no n FROM contract_payments WHERE id = ?`, [p2])!.n;
  expect(n1).toBe('RCP-2026-0001');
  expect(n2).toBe('RCP-2026-0201');
  expect(receiptNoOf(db1, p1)).toBe(n1);
  // والدفعة التالية على الجهاز نفسه تكمل كتلته
  const p3 = payOne(db1, '2026-03-03');
  expect(receiptNoOf(db1, p3)).toBe('RCP-2026-0002');
  db1.close(); db2.close();
});

test('E-10 بلا كتلة (جهازٌ بلا مزامنة): تسلسل الجهاز نفسه · والسند القديم بلا رقمٍ يُطبع بالمشتق كما طُبع', () => {
  const db = memDb();
  const p1 = payOne(db);
  expect(receiptNoOf(db, p1)).toBe('RCP-2026-0001');
  db.run(`UPDATE contract_payments SET receipt_no = NULL WHERE id = ?`, [p1]);
  expect(receiptNoOf(db, p1)).toBe('RCP-' + p1.slice(0, 8).toUpperCase());
  db.close();
});

test('E-10 البحث برقم السند (الجديد والقديم المشتق) يجد قسطه', () => {
  const db = memDb();
  const p1 = payOne(db);
  const inst = db.get<{ i: string }>(`SELECT installment_id i FROM contract_payments WHERE id = ?`, [p1])!.i;
  expect([...paymentsByReceipt(db, 'rcp-2026-0001')]).toEqual([inst]);
  db.run(`UPDATE contract_payments SET receipt_no = NULL WHERE id = ?`, [p1]);
  expect([...paymentsByReceipt(db, 'RCP-' + p1.slice(0, 8))]).toEqual([inst]);
  expect(paymentsByReceipt(db, 'مستأجر').size).toBe(0);
  db.close();
});

test('E-10 الجهاز يطلب كتلة سندات، وقواعد العدّاد تقبل السلسلة', () => {
  const db = memDb();
  expect(blockRequests(db).map((r) => r.series)).toContain('RCP');
  const rules = generateOrgRules();
  expect(rules).toMatch(/hasOnly\(\['JE', 'EJ', 'PUR', 'INV', 'RCP'\]\)/);
  expect(rules).toMatch(/memberJump\(d, b, 'RCP'/);
  db.close();
});
