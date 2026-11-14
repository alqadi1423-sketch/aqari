/**
 * المراجعة الشاملة 2026-11-13 · المراجع A1 (دورة الإيجار) · بيانات مصطنعة كلها.
 *
 * A1-8 · متوسط · src/domain/tenants.ts:38-42 (findOrCreateTenant: البحث بالاسم حين لا هوية في العقد)
 *   السيناريو: مستأجر «خالد مصطنع» بهوية 1000000984 له عقد ورصيد دائن ٥٠٠ (فائض تحصيل) · ثم يُوثَّق عقدٌ آخر لشخصٍ آخر
 *   بالاسم نفسه بلا رقم هوية (الهوية ليست إلزامية في التوثيق).
 *   النتيجة اليوم: العقد الثاني يُربط صامتاً بالمستأجر الأول صاحب الهوية: ملفه يجمع العقدين، ورصيده الدائن ٥٠٠ يظهر عند تحصيل
 *   العقد الثاني ويُستعمل لسداد أقساط شخصٍ آخر (applyTenantCredit)، وكشف الحساب واحد لشخصين.
 *   لماذا يهم: قرار المالك 2026-08-20 «ابحث بالهوية أولاً · وُجد فاربط، لم يوجد فأنشئ … واعرض المتشابهات لأقرّرها أنا»،
 *   وقراره 2026-10-09 جعل «ربط المستأجر بالاسم يدمج شخصين» من الإصلاحات الفورية · والمال هنا ينتقل بين شخصين.
 *   السلوك الصحيح: عقدٌ بلا هوية لا يُربط صامتاً بمستأجرٍ له هوية · يُنشأ له مستأجر ويظهر في «مستأجرون متشابهون» ليقرّر المالك.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, tenantCreditOf } from '@/domain/contracts/service';

test.failing('A1-8 عقدٌ بلا هوية لا يُربط بالاسم بمستأجرٍ آخر له هوية ولا يرى رصيده', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار أسماء مصطنع' });
  const c1 = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'T-1' }), { tenant: 'خالد مصطنع', idNumber: '1000000984',
    phone: '0500000984', valueHalalas: 1200000, depositHalalas: 0 }));
  const t1 = db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [c1])!.t;
  db.run(`UPDATE tenants SET credit_halalas = 50000 WHERE id = ?`, [t1]); // رصيد دائن مصطنع للأول
  const c2 = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'T-2' }), { tenant: 'خالد مصطنع', idNumber: '',
    phone: '0500000992', valueHalalas: 600000, depositHalalas: 0 }));
  const t2 = db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [c2])!.t;
  expect(t2).not.toBe(t1);
  expect(tenantCreditOf(db, c2)).toBe(0);
  db.close();
});
