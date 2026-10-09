/**
 * دراسة القائم (2026-10-09، فجوة عالية): التحصيل بالشيك أو البطاقة كان يفشل دائماً · الشاشة تعرض الطريقتين، وجدول سطور
 * الدفع لا يقبل إلا «تحويل» و«نقد». الشيك والبطاقة يستقران في حساب بنكي، فالسطر بنكيٌّ ببنكه، واسم الطريقة في بيان
 * الدفعة وحركة البنك · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';

test.each([['cheque', 'شيك'], ['card', 'بطاقة']] as const)('التحصيل بـ%s يُسجَّل في بنكه وباسم طريقته', (method, label) => {
  const db = memDb();
  const bank = addBank(db, 'بنك تحصيل مصطنع');
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار تحصيل مصطنع' })),
    { tenant: 'مستأجر تحصيل مصطنع', idNumber: '1000000501', phone: '0500000501', depositHalalas: 0 }));
  const inst = db.get<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  const pid = recordRentPayment(db, cid, { installmentId: inst.id, period: 'الأول', date: inst.due_date,
    lines: [{ method, bankId: bank, amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  expect(db.get(`SELECT method, bank_id AS b FROM payment_lines WHERE payment_id = ?`, [pid])).toEqual({ method: 'bank', b: bank });
  expect(db.get<{ l: string }>(`SELECT method_label AS l FROM contract_payments WHERE id = ?`, [pid])!.l).toContain(label);
  expect(bankBalance(db, bank)).toBe(50000);
  db.close();
});
