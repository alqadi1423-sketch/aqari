/**
 * قرار المالك 2026-10-09 (ثانياً · المسائل الثلاث ١): «لا مسترد أكبر من الباقي بعد الخصم» · بيانات مصطنعة.
 * الزيادة على التأمين لا تأتي إلا من خصمٍ يتجاوزه، فتصير مطالبة، ولا يُردّ للمستأجر شيءٌ معها.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, saveDepositSettlement, cancelContract } from '@/domain/contracts/service';
import type { DB } from '@/db/adapter';

function contract(db: DB, n: number) {
  const u = addUnit(db, addProperty(db, { name: 'عقار سقف مصطنع ' + n }), { unit_no: 'R-' + n });
  return confirmContract(db, contractInput(u, { tenant: 'مستأجر سقف مصطنع', idNumber: '1000000803', phone: '0500000803',
    valueHalalas: 600000, start: '2026-01-01', end: '2026-06-30', depositHalalas: 100000 }));
}
const settle = (deductionHalalas: number, refundHalalas: number) =>
  ({ date: '2026-07-05', deductionHalalas, deductionReason: 'إصلاح مصطنع', refundHalalas, notes: '' });

test('المسترد لا يزيد على الباقي بعد الخصم', () => {
  const db = memDb();
  const a = contract(db, 1);
  expect(() => saveDepositSettlement(db, a, settle(30000, 100000))).toThrow();
  expect(db.get(`SELECT 1 AS x FROM deposit_settlements WHERE contract_id = ?`, [a])).toBeUndefined();
  saveDepositSettlement(db, a, settle(30000, 70000));
  const b = contract(db, 2);
  expect(() => saveDepositSettlement(db, b, settle(120000, 10000))).toThrow();
  // خصمٌ يتجاوز التأمين بلا مسترد: الزيادة مطالبة كما قرّر المالك في #27
  saveDepositSettlement(db, b, settle(120000, 0));
  expect(db.get(`SELECT amount_halalas AS a FROM claims WHERE contract_id = ? AND deleted_at IS NULL`, [b])).toEqual({ a: 20000 });
  db.close();
});

test('وفي الإلغاء بتسوية: المسترد فوق الباقي يُرفض والعقد يبقى', () => {
  const db = memDb();
  const c = contract(db, 3);
  expect(() => cancelContract(db, c, { date: '2026-03-10', reason: 'إلغاء مصطنع', installmentsFate: 'cancel', settle: true,
    deductionHalalas: 50000, refundHalalas: 60000, deductionReason: 'إصلاح مصطنع' })).toThrow();
  expect(db.get(`SELECT status FROM contracts WHERE id = ?`, [c])).not.toEqual({ status: 'ملغى' });
  db.close();
});
