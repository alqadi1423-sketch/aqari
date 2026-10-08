/**
 * مراجعة التثبيت #15 و#16 و#25 · تسوية التأمين · بيانات مصطنعة:
 *  #١٥ الإلغاء بتسوية يكتب صف التسوية، فتسجيلها بعده تعديلٌ لا ترحيلٌ ثانٍ
 *  #٢٥ والخصم من تأمين لدى المنصة عند الإلغاء يُقفل من 1260 كالتسوية
 *  #١٦ والتجديد ينقل جهة قبض التأمين واسمها
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, cancelContract, saveDepositSettlement, renewContract } from '@/domain/contracts/service';
import { ownerCashIn } from '@/domain/cashOps';
import { accountBalance } from '@/domain/accounting/ledger';
import type { DB } from '@/db/adapter';

function contract(db: DB, holder: string, end = '2026-12-31') {
  const u = addUnit(db, addProperty(db, { name: 'عقار تأمين مصطنع' }), { unit_no: 'D-' + holder.length });
  return confirmContract(db, { ...contractInput(u, { tenant: 'مستأجر تأمين مصطنع', idNumber: '1000000124', phone: '0500000081',
    valueHalalas: 1200000, start: '2026-01-01', end, depositHalalas: 100000 }), depositHolder: holder, depositHolderName: holder === 'طرف آخر' ? 'جهة مصطنعة' : '' } as never);
}

test('#١٥ تسجيل التسوية بعد إلغاءٍ بتسوية لا يرحّلها ثانية', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 500000, date: '2026-01-01' });
  const cid = contract(db, 'المكتب');
  cancelContract(db, cid, { date: '2026-03-01', reason: 'إلغاء مصطنع', installmentsFate: 'cancel', settle: true,
    deductionHalalas: 30000, refundHalalas: 70000, deductionReason: 'إصلاح مصطنع' });
  const cash = accountBalance(db, '1100');
  expect(accountBalance(db, '2400')).toBe(0);
  // الشاشة تعرض «تسجيل التسوية» للملغى · والحفظ بالقيم نفسها تعديلٌ لا ترحيلٌ ثانٍ
  saveDepositSettlement(db, cid, { date: '2026-03-01', deductionHalalas: 30000, deductionReason: 'إصلاح مصطنع', refundHalalas: 70000, notes: '' });
  expect(accountBalance(db, '2400')).toBe(0);
  expect(accountBalance(db, '1100')).toBe(cash);
  expect(accountBalance(db, '4300')).toBe(30000);
  db.close();
});

test('#٢٥ الخصم من تأمين لدى المنصة عند الإلغاء يُقفل من 1260 كما في التسوية', () => {
  const db = memDb();
  const cid = contract(db, 'منصة إيجار');
  const before = accountBalance(db, '1260');
  cancelContract(db, cid, { date: '2026-03-01', reason: 'إلغاء مصطنع', installmentsFate: 'cancel', settle: true,
    deductionHalalas: 30000, refundHalalas: 70000, deductionReason: 'إصلاح مصطنع' });
  // المردود من المنصة يُقفل منها، والمخصوم يستقر في محفظة إيجار فلا يبقى في 1260 شيء
  expect(accountBalance(db, '1260')).toBe(before - 100000);
  db.close();
});

test('#١٦ التجديد ينقل جهة قبض التأمين واسمها', () => {
  const db = memDb();
  const cid = contract(db, 'طرف آخر', '2026-06-30');
  const nid = renewContract(db, cid, { start: '2026-07-01', end: '2027-06-30', valueHalalas: 1200000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  expect(db.get(`SELECT deposit_holder AS h, deposit_holder_name AS n FROM contracts WHERE id = ?`, [nid])).toEqual({ h: 'طرف آخر', n: 'جهة مصطنعة' });
  db.close();
});
