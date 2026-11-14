/**
 * المراجعة الشاملة 2026-11-13 · المراجع A1 (دورة الإيجار) · بيانات مصطنعة كلها.
 *
 * A1-7 · متوسط · src/domain/contracts/service.ts:235-334 (confirmContract لا يفحص التأمين) و551 (renewContract يجمع الإضافي السالب) ·
 *        src/domain/reservations.ts:22-41 (createReservation لا يفحص العربون) · src/domain/money.ts:24 (toHalalas يقبل «-»)
 *   السيناريو: مبلغ سالب يُكتب في خانة رقمية (لوحة الأرقام في أندرويد فيها «-»):
 *     - تأمين عقدٍ جديد «-1000» · عربون حجز «-500» · «تأمين إضافي» في التجديد «-400» مع ترحيل تأمين ١٬٠٠٠.
 *   النتيجة اليوم: يُحفظ كلٌّ منها بلا رفض: العقد بتأمين −١٬٠٠٠ بلا قيد، والحجز بعربون −٥٠٠ بلا قيد، والعقد المجدَّد بتأمين ٦٠٠
 *   ودفتره ١٬٠٠٠ (رُحِّل كاملاً) · ففحصا المطابقة الثالث والعاشر يحمرّان، و٤٠٠ تعلق في 2400 لا تسوية تبلغها.
 *   لماذا يهم: أخطاء إدخال تصير التزامات معلّقة لا تُصحَّح (العقد الموثَّق لا يُعدَّل)، وقيمة العقد السالبة تُرفض برسالة محفّز
 *   تقنية «المسدَّد يتجاوز مبلغ القسط أو سالب» لا بجملة تقول السبب والقيمة (قرار المالك 2026-08-19).
 *   السلوك الصحيح: كل مبلغٍ مالي في العقد والتجديد والحجز عددٌ صحيح غير سالب، والسالب يُرفض قبل أي كتابة برسالة تذكر الحقل.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, renewContract, RuleViolation } from '@/domain/contracts/service';
import { createReservation } from '@/domain/reservations';

test.failing('A1-7 تأمين سالب في توثيق العقد يُرفض', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار سالب مصطنع' }), { unit_no: 'S-1' });
  expect(() => confirmContract(db, contractInput(u, { tenant: 'مستأجر سالب مصطنع', idNumber: '1000000968',
    valueHalalas: 1200000, start: '2026-01-01', end: '2026-12-31', depositHalalas: -100000 }))).toThrow(RuleViolation);
  db.close();
});

test.failing('A1-7 عربون حجز سالب يُرفض', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار سالب مصطنع' }), { unit_no: 'S-2' });
  expect(() => createReservation(db, { unitId: u, name: 'حاجز مصطنع', phone: '', depositHalalas: -50000, expiryDate: '2027-01-01' })).toThrow();
  db.close();
});

test.failing('A1-7 تأمين إضافي سالب في التجديد يُرفض', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار سالب مصطنع' }), { unit_no: 'S-3' });
  const a = confirmContract(db, contractInput(u, { tenant: 'مستأجر سالب مصطنع', idNumber: '1000000976',
    valueHalalas: 1200000, start: '2026-01-01', end: '2026-12-31', depositHalalas: 100000 }));
  expect(() => renewContract(db, a, { start: '2027-01-01', end: '2027-12-31', valueHalalas: 1200000, cycle: 'شهرية',
    carryDeposit: true, extraDepositHalalas: -40000, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' })).toThrow(RuleViolation);
  db.close();
});
