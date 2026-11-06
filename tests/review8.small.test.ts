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

test('٢٥ الميزانية بفرق هللة واحدة غير متوازنة', () => {
  const db = memDb();
  db.run(`UPDATE accounts SET opening_halalas = 1 WHERE code = '1100'`);
  const b = financialStatementBlock(db, 'balance', null, '2026-12-31');
  const last = b.totals![b.totals!.length - 1];
  expect(String(last[0])).toMatch(/غير متوازنة/);
  db.close();
});

test('٢٦ المطالبة بمبلغ كسري أو سالب مرفوضة ولا تُرحَّل', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'D-2' });
  const cid = confirmContract(db, contractInput(u, { depositHalalas: 0 }));
  const entries = () => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n);
  const before = entries();
  for (const amount of [-5000, 1500.5, Number.NaN]) {
    expect(() => saveClaim(db, { contractId: cid, amountHalalas: amount, reason: 'مطالبة مصطنعة', date: '2026-02-01' })).toThrow();
  }
  expect(entries()).toBe(before);
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM claims`)!.n)).toBe(0);
  saveClaim(db, { contractId: cid, amountHalalas: 1500, reason: 'مطالبة مصطنعة', date: '2026-02-01' });
  expect(entries()).toBe(before + 1);
  db.close();
});
