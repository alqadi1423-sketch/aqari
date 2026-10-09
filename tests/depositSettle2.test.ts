/**
 * مراجعة التثبيت #26 و#27 و#28 · تسوية التأمين · بيانات مصطنعة:
 *  #٢٦ قرار المالك: «الخصم من تأمين «طرف آخر»: لا قيد عند الخصم، ويُسجَّل قبضاً إن وصل المال للمكتب.»
 *  #٢٧ قرار المالك: «تسوية لا تساوي التأمين: الزيادة مطالبة تلقائية، والنقص لا يُحفظ حتى يُوزَّع.»
 *  #٢٨ تسوية العقد القديم بعد ترحيل تأمينه إلى المجدَّد لا تُتاح
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, saveDepositSettlement, renewContract, cancelContract } from '@/domain/contracts/service';
import { deleteClaim } from '@/domain/claims';
import { postEntry, postDepositDeduct, postDepositRefund } from '@/domain/accounting/post';

/** سحبٌ من النقدية بقيدٍ مصطنع (كمسحوبات المالك) */
const postEntryOut = (db: import('@/db/adapter').DB, amount: number) =>
  postEntry(db, { date: '2026-07-10', memo: 'سحب مصطنع', lines: [{ account: '3100', debit: amount, credit: 0 }, { account: '1100', debit: 0, credit: amount }] });
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
  // قرار المالك 2026-10-09: «لا مسترد أكبر من الباقي بعد الخصم» · فالزيادة من خصمٍ يتجاوز التأمين وحده
  saveDepositSettlement(db, c, settle({ deductionHalalas: 130000, refundHalalas: 0 }) as never);
  expect(accountBalance(db, '2400')).toBe(0);
  expect(db.get(`SELECT amount_halalas AS a, source AS s, status AS st FROM claims WHERE contract_id = ?`, [c]))
    .toEqual({ a: 30000, s: 'تسوية تأمين', st: 'مفتوحة' });
  // تعديل الزيادة: مطالبتها تُحذف من المطالبات أولاً (بصلاحيتها)، ثم تُعدَّل التسوية فتُنشأ الجديدة ولا تتكرر
  expect(() => saveDepositSettlement(db, c, settle({ deductionHalalas: 140000, refundHalalas: 0 }) as never)).toThrow();
  const cl = db.get<{ id: string }>(`SELECT id FROM claims WHERE contract_id = ? AND deleted_at IS NULL`, [c])!.id;
  deleteClaim(db, cl);
  saveDepositSettlement(db, c, settle({ deductionHalalas: 140000, refundHalalas: 0 }) as never);
  expect(db.all(`SELECT amount_halalas AS a FROM claims WHERE contract_id = ? AND deleted_at IS NULL`, [c])).toEqual([{ a: 40000 }]);
  expect(accountBalance(db, '2400')).toBe(0);
  // والزيادة نفسها لا تتطلب شيئاً
  saveDepositSettlement(db, c, settle({ deductionHalalas: 140000, refundHalalas: 0 }) as never);
  expect(db.all(`SELECT amount_halalas AS a FROM claims WHERE contract_id = ? AND deleted_at IS NULL`, [c])).toEqual([{ a: 40000 }]);
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

test('N1 لا تسوية في إلغاء عقدٍ رُحِّل تأمينه · ولا في إلغاء عقدٍ سُوّي تأمينه', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 500000, date: '2026-01-01' });
  const c = contract(db, 'المكتب');
  renewContract(db, c, { start: '2026-07-01', end: '2027-06-30', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  expect(() => cancelContract(db, c, { date: '2026-07-05', reason: 'إلغاء مصطنع', installmentsFate: 'keep', settle: true,
    deductionHalalas: 30000, refundHalalas: 70000, deductionReason: '' })).toThrow();
  expect(accountBalance(db, '2400')).toBe(100000);
  const d = contract(db, 'المكتب');
  saveDepositSettlement(db, d, settle({ deductionHalalas: 30000, refundHalalas: 70000 }) as never);
  expect(() => cancelContract(db, d, { date: '2026-07-06', reason: 'إلغاء مصطنع', installmentsFate: 'keep', settle: true,
    deductionHalalas: 30000, refundHalalas: 70000, deductionReason: '' })).toThrow();
  db.close();
});

test('N2 عقدٌ أُلغي بتسوية قبل صفّها: تسجيل التسوية يعكس قيودها الحيّة فلا ترحيل مرتين', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 500000, date: '2026-01-01' });
  const c = contract(db, 'المكتب');
  cancelContract(db, c, { date: '2026-03-01', reason: 'إلغاء مصطنع', installmentsFate: 'cancel', settle: true,
    deductionHalalas: 30000, refundHalalas: 70000, deductionReason: 'إصلاح مصطنع' });
  db.run(`DELETE FROM deposit_settlements WHERE contract_id = ?`, [c]); // كعقدٍ أُلغي قبل صفّ التسوية
  const cash = accountBalance(db, '1100');
  saveDepositSettlement(db, c, settle({ deductionHalalas: 30000, refundHalalas: 70000 }) as never);
  expect([accountBalance(db, '2400'), accountBalance(db, '4300'), accountBalance(db, '1100')]).toEqual([0, 30000, cash]);
  db.close();
});

test('E2 تعديل التسوية لا يُنزل النقدية تحت الصفر بعكس مقبوضٍ سُحب', () => {
  const db = memDb();
  const c = contract(db, 'طرف آخر');
  saveDepositSettlement(db, c, settle({ deductionHalalas: 30000, refundHalalas: 70000, deductReceived: true }) as never);
  expect(accountBalance(db, '1100')).toBe(30000);
  postEntryOut(db, 30000);
  expect(() => saveDepositSettlement(db, c, settle({ deductionHalalas: 30000, refundHalalas: 70000, deductReceived: false }) as never)).toThrow();
  expect(accountBalance(db, '1100')).toBe(0);
  db.close();
});

test('E3 قيود تسويتين حيّتان (بيانات قديمة) تُعكسان كلتاهما عند التعديل', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 500000, date: '2026-01-01' });
  const c = contract(db, 'المكتب');
  cancelContract(db, c, { date: '2026-03-01', reason: 'إلغاء مصطنع', installmentsFate: 'cancel', settle: true,
    deductionHalalas: 30000, refundHalalas: 70000, deductionReason: 'إصلاح مصطنع' });
  // كما كان قبل صفّ التسوية: إلغاءٌ بتسوية ثم «تسجيل التسوية» فوقه بلا عكس
  db.run(`DELETE FROM deposit_settlements WHERE contract_id = ?`, [c]);
  postDepositDeduct(db, { id: c, contract_no: '' }, 30000, '2026-03-02');
  postDepositRefund(db, { id: c, contract_no: '' }, 70000, '2026-03-02');
  expect(accountBalance(db, '2400')).toBe(-100000);
  saveDepositSettlement(db, c, settle({ deductionHalalas: 30000, refundHalalas: 70000 }) as never);
  expect([accountBalance(db, '2400'), accountBalance(db, '4300')]).toEqual([0, 30000]);
  db.close();
});

