/**
 * مراجعة التثبيت #23 · المتأخرات في ملف المستأجر وتقرير الوحدة · بيانات مصطنعة:
 * القرار ٤.١٠: «المتبقي يطرح الخصم … بدالة واحدة» · والقرار ٤.٩: «متأخرات العقد الملغى قابلة للتحصيل»
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment, cancelContract } from '@/domain/contracts/service';
import { tenantProfile } from '@/domain/tenants';
import { unitReportData } from '@/domain/reportData';
import { DISCOUNT_AFTER_DUE } from '@/domain/contracts/installments';

test('#٢٣ المتبقي = ما حلّ ناقص المسدَّد ناقص الخصم، ومنه أقساط العقد الملغى القائمة', () => {
  const db = memDb();
  const bank = addBank(db);
  const p = addProperty(db, { name: 'عقار متأخرات مصطنع' });
  const u = addUnit(db, p, { unit_no: 'K-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر متأخرات مصطنع', idNumber: '1000000173', phone: '0500000111',
    valueHalalas: 1200000, cycle: 'شهرية', start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  // يناير: ٨٠٠ مقبوض و٢٠٠ خصم «بعد الاستحقاق» ← لا شيء عليه · فبراير ومارس قائمان
  recordRentPayment(db, cid, { installmentId: insts[0], period: 'يناير', date: '2026-01-05', notes: '',
    discountHalalas: 20000, discountKind: DISCOUNT_AFTER_DUE, lines: [{ method: 'bank', bankId: bank, amountHalalas: 80000 }] });
  // ثم يُلغى العقد وتبقى أقساطه السابقة لإلغائه مستحقة
  cancelContract(db, cid, { date: '2026-03-20', reason: 'إلغاء مصطنع', installmentsFate: 'keep', settle: false, deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });
  const tid = db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [cid])!.t;
  expect(tenantProfile(db, tid, '2026-03-31')!.totals.outstanding).toBe(200000);
  expect(unitReportData(db, u, null, '2026-03-31')!.installments.outstanding).toBe(200000);
  db.close();
});
