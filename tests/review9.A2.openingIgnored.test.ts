/**
 * A2.5 · متوسط · src/domain/accounting/chart.ts:27 (saveAccount)
 *
 * السيناريو (بيانات مصطنعة): المالك يضع افتتاحي 1100 = ٥٠٬٠٠٠٫٠٠، ثم يسجّل «إيداع المالك» ١٠٫٠٠ (فيُستعمل 3100 في قيد)، ثم يرى
 * تنبيه «الأرصدة الافتتاحية غير متوازنة · تُصحَّح بإكمال الطرف الناقص» فيفتح رأس المال 3100 ويكتب افتتاحيه ٥٠٬٠٠٠٫٠٠ ويحفظ.
 * الخطأ: الحفظ ينجح بلا رسالة، والافتتاحي يبقى صفراً (العمود يُسقط من UPDATE لأن الحساب «مستخدَم»)، والتنبيه باقٍ أبداً.
 *
 * لماذا يهم: «لا تُصحّح صامتاً … أظهر الفرق واعرض القرار» (قرار المالك 2026-08-19) · والمالك لا يملك طريقاً لإكمال الطرف الناقص
 * لأي حسابٍ مرّ عليه قيد، فتبقى الميزانية غير متوازنة.
 * السلوك الصحيح: إما يُحفظ الافتتاحي كما أُدخل (الافتتاحي ليس قيداً مرحّلاً فلا يمسّ سطراً، ويُسجَّل قبل وبعد في سجل العمليات)،
 * وإما يُرفض برسالة صريحة · لا نجاحٌ صامت يُسقط ما أدخله المالك.
 */
import { memDb } from './helpers/testDb';
import { saveAccount, openingDifference } from '@/domain/accounting/chart';
import { ownerCashIn } from '@/domain/cashOps';

test.failing('A2.5 افتتاحي حسابٍ مستخدَم: لا يُسقط صامتاً', () => {
  const db = memDb();
  saveAccount(db, { code: '1100', name: 'النقدية والبنوك', type: 'أصل', openingHalalas: 5000000 }, '1100');
  ownerCashIn(db, { amountHalalas: 1000, date: '2026-06-01' });
  expect(openingDifference(db)).toBe(5000000);
  let threw = false;
  try {
    saveAccount(db, { code: '3100', name: 'رأس المال', type: 'حقوق ملكية', openingHalalas: 5000000 }, '3100');
  } catch {
    threw = true;
  }
  const opening = Number(db.get<{ o: number }>(`SELECT opening_halalas AS o FROM accounts WHERE code = '3100'`)!.o);
  // إما حُفظ كما أُدخل، وإما رُفض برسالة · والخطأ أن ينجح الحفظ ويبقى صفراً
  expect(threw || opening === 5000000).toBe(true);
  db.close();
});
