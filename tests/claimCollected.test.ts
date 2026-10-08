/**
 * مراجعة التثبيت #22 · المطالبة المحصَّلة · بيانات مصطنعة:
 * القاعدة ٩٠: «كل سجل تعلّق به بيانات أو مستندات أو عقود أو مبالغ لا يُحذف» · فلا تُحذف المحصَّلة ولا يتغيّر مبلغها
 * أو تاريخها أو عقدها بلا قيد (قيداها مرحّلان)
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { saveClaim, collectClaim, deleteClaim } from '@/domain/claims';
import { accountBalance } from '@/domain/accounting/ledger';

test('#٢٢ المحصَّلة لا تُحذف ولا يتغيّر مبلغها أو تاريخها أو عقدها · وسببها يُعدَّل', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مطالبة مصطنع' }), { unit_no: 'M-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر مطالبة مصطنع', idNumber: '1000000165', phone: '0500000101', depositHalalas: 0 }));
  const id = saveClaim(db, { contractId: cid, amountHalalas: 15000, reason: 'إصلاح مصطنع', date: '2026-02-10' });
  collectClaim(db, id, '2026-02-20');
  const rev = accountBalance(db, '4300');
  expect(() => deleteClaim(db, id)).toThrow();
  expect(() => saveClaim(db, { contractId: cid, amountHalalas: 20000, reason: 'إصلاح مصطنع', date: '2026-02-10' }, id)).toThrow();
  expect(() => saveClaim(db, { contractId: cid, amountHalalas: 15000, reason: 'إصلاح مصطنع', date: '2026-03-01' }, id)).toThrow();
  saveClaim(db, { contractId: cid, amountHalalas: 15000, reason: 'إصلاح باب مصطنع', date: '2026-02-10' }, id);
  expect(db.get(`SELECT amount_halalas AS a, reason AS r, deleted_at AS d FROM claims WHERE id = ?`, [id]))
    .toEqual({ a: 15000, r: 'إصلاح باب مصطنع', d: null });
  expect(accountBalance(db, '4300')).toBe(rev);
  db.close();
});
