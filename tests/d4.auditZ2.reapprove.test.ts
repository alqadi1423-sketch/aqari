/**
 * المدقق Z2 · الجولة الثالثة عشرة · على db011e7 · بعد إلغاء تحصيلٍ من الكشف لا يُقترح الإيداع للتحصيل ثانيةً، ويُقترح «جاهزاً» لمطابقته
 * بحركة التحصيل الملغى · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditZ2.reapprove.test.ts
 *
 * Z2-9 · متوسط · src/domain/bankStatement/store.ts:102-105 (matchSuggestions: كل حركةٍ حيّة غير مطابَقة مرشّحة، ولو كان قيدها معكوساً
 * وقابلتها حركة الإلغاء السالبة) مع src/domain/bankStatement/collect.ts:68-73 (collectionSuggestions يُسقط كل سطرٍ له حركةٌ مرشّحة):
 * المالك يعتمد إيداع 2 أكتوبر لقسط ماجد، ثم يتبيّن أنه لغيره فيفكّ المطابقة ويلغي الدفعة ليعتمده للهدف الصحيح (المسار الذي بُني له رقم
 * الاعتماد attempt في approveCollection · W1 وX3) · لكن حركة التحصيل الملغى (+1,000) تبقى حيّة غير مطابَقة، فيقترحها matchSuggestions
 * للسطر «جاهزة» (88: المبلغ واليوم والاسم والوحيدة)، ويُسقط collectionSuggestions السطر لأن له حركةً مرشّحة · فلا اقتراح تحصيلٍ للإيداع
 * بعدها أبداً، و«اعتماد الجاهزة» في المطابقة يربطه بالتحصيل الملغى: الإيداع «مطابَق» والدفاتر لا تنسبه لأحد، والبنك في الدفاتر صفر والكشف
 * 1,000، والتقرير يعرض «في الدفاتر وحدها» سحباً بـ−1,000 لم يخرج من البنك.
 * لماذا يهم: مسار «ألغِ ثم اعتمد ثانيةً» الذي صُمّم له رقم الاعتماد لا يصل إليه المستخدم من الشاشة، والشاشة تدفعه إلى إخفاء إيداعٍ غير منسوب.
 * السلوك الصحيح: حركةُ قيدٍ معكوس (تحصيلٌ أُلغي) لا تُقترح لمطابقة الإيداع، فيعود السطر في اقتراحات التحصيل.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { memDb } from './helpers/testDb';
import { confirmContract } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, unmatchLine, matchSuggestions } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';

test('Z2-9 · اعتمادٌ ثم فكّ المطابقة وإلغاء الدفعة: الإيداع يعود في اقتراحات التحصيل ولا يُقترح لمطابقته بحركة التحصيل الملغى', () => {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع Z2-9', 0);
  const prop = addProperty(db, { name: 'عقار مصطنع Z2-9' });
  const c = confirmContract(db, contractInput(addUnit(db, prop, { unit_no: 'Z29-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000002901', phone: '0500002901', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(db, bank, g, { name: 'z29-oct.csv', hash: 'z29' });
  const s = collectionSuggestions(db, bank)[0];
  const { txId } = approveCollection(db, s.line.id, s.target);
  const pay = db.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [c])!.id;
  // كمسار W١ في d6.bankStatementCollect: فكّ المطابقة ثم إلغاء الدفعة
  unmatchLine(db, s.line.id);
  cancelPayment(db, pay, { date: '2026-10-02', reason: 'الإيداع لغير هذا القسط' });

  const view = {
    matchedToCancelled: matchSuggestions(db, bank).filter((x) => x.line.id === s.line.id && x.tx.id === txId).map((x) => x.level),
    collectAgain: collectionSuggestions(db, bank).filter((x) => x.line.id === s.line.id).length,
  };
  // (الواقع: «جاهزة» لمطابقة الإيداع بحركة التحصيل الملغى، ولا اقتراح تحصيلٍ له)
  expect(view).toEqual({ matchedToCancelled: [], collectAgain: 1 });
  db.close();
});
