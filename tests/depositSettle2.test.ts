/**
 * مراجعة التثبيت #26 و#27 و#28 · تسوية التأمين · بيانات مصطنعة:
 *  #٢٦ قرار المالك: «الخصم من تأمين «طرف آخر»: لا قيد عند الخصم، ويُسجَّل قبضاً إن وصل المال للمكتب.»
 *  #٢٧ قرار المالك: «تسوية لا تساوي التأمين: الزيادة مطالبة تلقائية، والنقص لا يُحفظ حتى يُوزَّع.»
 *  #٢٨ تسوية العقد القديم بعد ترحيل تأمينه إلى المجدَّد لا تُتاح
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, saveDepositSettlement, renewContract } from '@/domain/contracts/service';
import { ownerCashIn } from '@/domain/cashOps';
import { accountBalance } from '@/domain/accounting/ledger';
import type { DB } from '@/db/adapter';

function contract(db: DB, holder: string, end = '2026-06-30') {
  const u = addUnit(db, addProperty(db, { name: 'عقار تسوية مصطنع' }), { unit_no: 'Z-' + holder.length });
  return confirmContract(db, { ...contractInput(u, { tenant: 'مستأجر تسوية مصطنع', idNumber: '1000000199', phone: '0500000131',
    valueHalalas: 600000, start: '2026-01-01', end, depositHalalas: 100000 }), depositHolder: holder, depositHolderName: holder === 'طرف آخر' ? 'جهة مصطنعة' : '' } as never);
}
const settle = (over: Partial<{ deductionHalalas: number; refundHalalas: number; deductReceived: boolean }>) => ({
  date: '2026-07-05', deductionHalalas: 0, deductionReason: 'إصلاح مصطنع', refundHalalas: 0, notes: '', ...over,
});

test('#٢٦ الخصم من تأمين «طرف آخر» بلا قيد · ويُسجَّل قبضاً إن وصل للمكتب', () => {
  const db = memDb();
  const a = contract(db, 'طرف آخر');
  saveDepositSettlement(db, a, settle({ deductionHalalas: 30000, refundHalalas: 70000 }) as never);
  expect([accountBalance(db, '2400'), accountBalance(db, '4300'), accountBalance(db, '1100')]).toEqual([0, 0, 0]);
  const b = contract(db, 'طرف آخر');
  saveDepositSettlement(db, b, settle({ deductionHalalas: 30000, refundHalalas: 70000, deductReceived: true }) as never);
  expect([accountBalance(db, '2400'), accountBalance(db, '4300'), accountBalance(db, '1100')]).toEqual([0, 30000, 30000]);
  db.close();
});

test('#٢٧ النقص عن التأمين لا يُحفظ · والزيادة مطالبة تلقائية', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 500000, date: '2026-01-01' });
  const c = contract(db, 'المكتب');
  expect(() => saveDepositSettlement(db, c, settle({ deductionHalalas: 30000, refundHalalas: 50000 }) as never)).toThrow();
  expect(db.get(`SELECT 1 FROM deposit_settlements WHERE contract_id = ?`, [c])).toBeUndefined();
  saveDepositSettlement(db, c, settle({ deductionHalalas: 80000, refundHalalas: 50000 }) as never);
  expect(accountBalance(db, '2400')).toBe(0);
  expect(db.get(`SELECT amount_halalas AS a, source AS s, status AS st FROM claims WHERE contract_id = ?`, [c]))
    .toEqual({ a: 30000, s: 'تسوية تأمين', st: 'مفتوحة' });
  // تعديلها لا يكرر المطالبة
  saveDepositSettlement(db, c, settle({ deductionHalalas: 90000, refundHalalas: 50000 }) as never);
  expect(db.all(`SELECT amount_halalas AS a FROM claims WHERE contract_id = ? AND deleted_at IS NULL`, [c])).toEqual([{ a: 40000 }]);
  expect(accountBalance(db, '2400')).toBe(0);
  db.close();
});

test('#٢٨ لا تسوية لعقدٍ رُحِّل تأمينه إلى المجدَّد', () => {
  const db = memDb();
  const c = contract(db, 'المكتب');
  renewContract(db, c, { start: '2026-07-01', end: '2027-06-30', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  expect(() => saveDepositSettlement(db, c, settle({ refundHalalas: 100000 }) as never)).toThrow();
  db.close();
});
