/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ٣: الإلغاء يكتب تاريخه في end، والاستحقاق كان يقسم قيمة العقد على المدة حتى end
 * فيضيع مقام المدة الكاملة ويتضخم إيراد ما قبل الإلغاء · الآن original_end مقام النصيب (الهجرة ٤٨)، والإلغاء لا يمسّه ·
 * بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, cancelContract, recordRentPayment } from '@/domain/contracts/service';
import { periodRevenueAccrual } from '@/domain/accrual';
import { DISCOUNT_REDUCES_INSTALLMENT } from '@/domain/contracts/installments';
import { openNodeDb } from '@/db/nodeAdapter';
import { migrate } from '@/db/migrations';
import { MIGRATIONS } from '@/db/schema';
import { seed } from '@/db/seed';

const cancel = (date: string) => ({ date, reason: 'سبب مصطنع', installmentsFate: 'cancel' as const, settle: false,
  deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });

test('٣ عقد ١٢٬٠٠٠ لسنة أُلغي في ٣١ مارس: إيراد الربع الأول ٢٬٩٥٨٫٩٠ لا ١٢٬٠٠٠', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'C-1' });
  const cid = confirmContract(db, contractInput(u, { valueHalalas: 1200000, start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  cancelContract(db, cid, cancel('2026-03-31'));
  expect(db.get<{ e: string }>(`SELECT end AS e FROM contracts WHERE id = ?`, [cid])!.e).toBe('2026-03-31');
  // ١٢٠٠٠٠٠ × ٩٠ ÷ ٣٦٥ = ٢٩٥٨٩٠
  expect(periodRevenueAccrual(db, '2026-01-01', '2026-03-31')).toBe(295890);
  expect(periodRevenueAccrual(db, '2026-04-01', '2026-12-31')).toBe(0);
  db.close();
});

test('٣ والتنزيل من القسط يُطرح بمقام مدة قسطه لا بمدة مقصوصة بالإلغاء', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'C-2' });
  const cid = confirmContract(db, contractInput(u, { valueHalalas: 1200000, cycle: 'ربع سنوية', start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  const q2 = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? AND due_date = '2026-04-01'`, [cid])!.id;
  // تنزيل ٩١٠٠ على قسط الربع الثاني (٩١ يوماً: ١٠٠ لكل يوم)
  recordRentPayment(db, cid, { installmentId: q2, period: '2026-04-01', date: '2026-04-01', lines: [{ method: 'cash', amountHalalas: 100000 }],
    discountHalalas: 9100, discountKind: DISCOUNT_REDUCES_INSTALLMENT, notes: '' });
  cancelContract(db, cid, cancel('2026-05-15'));
  const full = periodRevenueAccrual(db, '2026-04-01', '2026-06-30');
  // نصيب العقد من ١ أبريل إلى ١٥ مايو (٤٥ يوماً) بمقام السنة، ناقص نصيب التنزيل من الأيام نفسها بمقام ٩١ يوماً (٤٥٠٠)
  const contractShare = Math.round((1200000 * 135) / 365) - Math.round((1200000 * 90) / 365);
  expect(full).toBe(contractShare - 4500);
  db.close();
});

test('٣ الهجرة ٤٨ تعبّئ original_end: من end للقائم، ومن جدول الأقساط للملغى قبلها', () => {
  const db = openNodeDb(':memory:');
  // القاعدة بإصدار ٤٧ كما كانت قبل البند
  db.exec('PRAGMA foreign_keys = OFF');
  for (let v = 0; v < 47; v++) db.exec(MIGRATIONS[v]);
  db.exec('PRAGMA user_version = 47');
  db.exec('PRAGMA foreign_keys = ON');
  seed(db);
  const p = addProperty(db, { name: 'عقار مصطنع' });
  const live = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'M-1' }), { start: '2026-01-01', end: '2026-12-31', depositHalalas: 0, idNumber: '1000000081' }));
  const old = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'M-2' }), { start: '2026-01-31', end: '2027-01-30', depositHalalas: 0, idNumber: '1000000082' }));
  const late = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'M-3' }), { cycle: 'ربع سنوية', start: '2026-03-01', end: '2027-02-28', depositHalalas: 0, idNumber: '1000000083' }));
  // الإلغاء كما كان قبل البند: تاريخه في end
  const oldCancel = (id: string, d: string) => db.run(`UPDATE contracts SET status = 'ملغى', cancel_date = ?, end = ? WHERE id = ?`, [d, d, id]);
  oldCancel(old, '2026-04-10');
  oldCancel(late, '2026-09-01');
  migrate(db);
  const oe = (id: string) => db.get<{ e: string | null }>(`SELECT original_end AS e FROM contracts WHERE id = ?`, [id])!.e;
  expect(oe(live)).toBe('2026-12-31');
  expect(oe(old)).toBe('2027-01-30');
  expect(oe(late)).toBe('2027-02-28');
  db.close();
});

test('٣ وما يغيّر نهاية عقدٍ غير ملغى يغيّر original_end معه · والإلغاء لا يمسّه', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'C-3' });
  const cid = confirmContract(db, contractInput(u, { start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  const oe = () => db.get<{ e: string | null }>(`SELECT original_end AS e FROM contracts WHERE id = ?`, [cid])!.e;
  expect(oe()).toBe('2026-12-31');
  db.run(`UPDATE contracts SET end = '2027-06-30' WHERE id = ?`, [cid]);
  expect(oe()).toBe('2027-06-30');
  cancelContract(db, cid, cancel('2026-05-01'));
  expect(oe()).toBe('2027-06-30');
  db.close();
});
