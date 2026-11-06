/**
 * المراجعة الشاملة (الالتزام ac76adc) · الأولوية الرابعة: البنود ٢٤ و٢٥ و٢٦ · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, cancelContract } from '@/domain/contracts/service';
import { financialStatementBlock } from '@/domain/finStatements';
import { saveClaim } from '@/domain/claims';

test('٢٤ إلغاء العقد بخصمٍ يزيد على التأمين: المحفوظ في العقد ما خُصم من التأمين لا المُدخَل (والزائد مطالبة)', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'D-1' });
  const cid = confirmContract(db, contractInput(u, { depositHalalas: 200000, start: '2026-01-01', end: '2026-12-31' }));
  const r = cancelContract(db, cid, { date: '2026-03-01', reason: 'سبب مصطنع', installmentsFate: 'cancel', settle: true,
    deductionHalalas: 300000, refundHalalas: 0, deductionReason: 'أضرار مصطنعة' });
  expect(r.excessClaimCreated).toBe(true);
  expect(db.get<{ d: number }>(`SELECT cancel_deduction_halalas AS d FROM contracts WHERE id = ?`, [cid])!.d).toBe(200000);
  db.close();
});
