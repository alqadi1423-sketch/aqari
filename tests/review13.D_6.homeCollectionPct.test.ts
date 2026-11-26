/**
 * المراجعة الشاملة 2026-11-13 · D-6 · متوسط · app/(tabs)/index.tsx («نسبة التحصيل») · بيانات مصطنعة كلها.
 *
 * السيناريو: عقد (أ) سدّد ٦ من ١٢ قسطاً بألف · وعقد (ب) سدّد ٢ ثم أُلغي وأُلغيت أقساطه العشرة الباقية (تبقى مبالغها).
 *   الرئيسية: 8000 ÷ 24000 = 33% · وشاشة التحصيل: الملغاة ليست مستحقة فـ 8000 ÷ 14000 = 57% · رقمان بالاسم نفسه،
 *   والضغط على رقم الرئيسية يفتح شاشة التحصيل على الرقم الآخر.
 * الصحيح: الرئيسية تأخذ النسبة من collectKpis نفسها التي تعرضها شاشة التحصيل.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, cancelContract, recordRentPayment } from '@/domain/contracts/service';
import { allInstallments, collectKpis } from '@/domain/stats';
import type { DB } from '@/db/adapter';

const T = '2027-12-15';

function payMonths(db: DB, cid: string, n: number) {
  const ids = db.all<{ id: string; due_date: string }>(
    `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT ?`, [cid, n]);
  for (const r of ids) {
    recordRentPayment(db, cid, { installmentId: r.id, period: '', date: r.due_date,
      lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
}

test('D-6 الأقساط الملغاة لا تدخل نسبة التحصيل · والرئيسية تأخذها من collectKpis', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار مصطنع D6' });
  const a = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'D6-A' }), {
    tenant: 'مستأجر مصطنع أ', idNumber: '1000000611', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2027-01-01', end: '2027-12-31', depositHalalas: 0 }));
  const b = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'D6-B' }), {
    tenant: 'مستأجر مصطنع ب', idNumber: '1000000612', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2027-01-01', end: '2027-12-31', depositHalalas: 0 }));
  payMonths(db, a, 6);
  payMonths(db, b, 2);
  cancelContract(db, b, { date: '2027-02-15', reason: 'إنهاء مصطنع', installmentsFate: 'cancel', settle: false,
    deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });
  const insts = allInstallments(db, T);
  expect(insts.filter((x) => x.status === 'ملغية')).toHaveLength(10);
  // الحساب القديم في الرئيسية: كل الأقساط بالملغاة · 8000 ÷ 24000
  const naiveDue = insts.reduce((s, x) => s + x.amount, 0);
  const naivePaid = insts.reduce((s, x) => s + x.paid, 0);
  expect(Math.round((naivePaid / naiveDue) * 100)).toBe(33);
  // رقم شاشة التحصيل: 8000 ÷ 14000
  expect(collectKpis(insts, T).collectionPct).toBe(57);
  db.close();
});

test('D-6 بطاقة «نسبة التحصيل» في الرئيسية تقرأ collectKpis لا قسمةً على كل الأقساط', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', '(tabs)', 'index.tsx'), 'utf8');
  expect(src).not.toMatch(/data\.totalPaid\s*\/\s*data\.totalDue/);
  expect(src).toMatch(/collectKpis\(\s*insts\s*,\s*T0\s*\)\.collectionPct/);
  const kpi = src.slice(src.indexOf('label="نسبة التحصيل"'));
  expect(kpi.slice(0, 200)).toMatch(/data\.collectionPct/);
});
