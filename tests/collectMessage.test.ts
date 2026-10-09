/**
 * دراسة القائم (2026-10-09) · إصلاح فوري بقرار المالك: «رموز القوالب في رسائل التحصيل» · رسالة التحصيل تُملأ بالدالة نفسها
 * التي تعرض المعاينة، فلا يصل رمزٌ إلى المستأجر حرفياً · وقرار المالك 2026-10-05 (٤.١٠): «والتنبيهات تعتمد الموعد المتفق
 * والمهلة، بدالة واحدة مشتركة مع شاشة التحصيل» · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, setInstallmentSchedule } from '@/domain/contracts/service';
import { collectionMessage } from '@/domain/templates';
import { dfmt } from '@/domain/dates';

test('رسالة التحصيل تملأ كل رموز القالب وبالموعد المتفق', () => {
  const db = memDb();
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار رسالة مصطنع' }), { unit_no: 'W-1' }),
    { tenant: 'مستأجر رسالة مصطنع', idNumber: '1000000734', phone: '0500000734', start: '2026-01-01', depositHalalas: 0 }));
  const i = db.get<{ id: string; due_date: string; amount_halalas: number }>(
    `SELECT id, due_date, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  setInstallmentSchedule(db, i.id, { agreedDate: '2026-01-20', graceUntil: null, reason: 'اتفاق مصطنع' });
  const body = '{المستأجر} {الاسم} {رقم_العقد} {المبلغ} {المتبقي} {التاريخ} {تاريخ الاستحقاق} {أيام_التأخير} {الوحدة} {المنشأة}';
  const out = collectionMessage(db, body, { installmentId: i.id, contractId: cid, tenant: 'مستأجر رسالة مصطنع', unitNo: 'W-1' });
  expect(out).not.toMatch(/[{}]/);
  expect(out).toContain('مستأجر رسالة مصطنع');
  expect(out).toContain(dfmt('2026-01-20'));
  db.close();
});
