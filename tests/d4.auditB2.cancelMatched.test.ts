/**
 * المدقق B2 · الجولة الرابعة عشرة · على 52f19cb · إلغاء دفعةٍ حُصّلت من الكشف يُبقي إيداعها «مطابَقاً» بحركة التحصيل الملغى · بياناتٌ
 * مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditB2.cancelMatched.test.ts
 *
 * B2-7 · متوسط · src/domain/contracts/cancelPayment.ts:198-238 (cancelPaymentNow يعكس القيد ويكتب الحركة السالبة ولا يمسّ سطر الكشف
 * المطابَق بحركة الدفعة، ولا مانع له في planCancelPayment) مع src/domain/bankStatement/store.ts:102-105 (Z2-9: حركة القيد المعكوس لا تُقترح
 * لسطرٍ مفتوح وحده) وsrc/sync/engine.ts:1004 (statementLineFix لا يفكّ سطراً حركته لقيدٍ معكوس): المالك يعتمد إيداع ماجد لقسط أكتوبر من
 * الكشف، ثم يلغي الدفعة من شاشة التحصيل (الإيداع لمستأجرٍ آخر) كما ألغاها العضو «أ» في Z1-1 · السطر يبقى «مطابَقاً» بحركة التحصيل
 * الملغى، فلا يعود في اقتراحات التحصيل أبداً، والتقرير يعدّه مطابَقاً ويفسّر الفرق بحركة الإلغاء السالبة «في الدفاتر وحدها»: البنك في
 * الدفاتر صفر والكشف 1,000 و«غير مفسَّر» صفر، فلا يظهر أن الإيداع لم يُنسب لأحد.
 * لماذا يهم: مسار «ألغِ ثم اعتمد للهدف الصحيح» الذي بُني له رقم الاعتماد (W1 وX3 وZ2-9) لا يصل إليه من ألغى من شاشة الدفعة، وإيداعٌ حقيقي
 * يختفي من قائمة العمل بمطابقةٍ لتحصيلٍ أُلغي.
 * السلوك الصحيح: إلغاء الدفعة يعيد سطر الكشف المطابَق بحركتها مفتوحاً (أو يمنع الإلغاء قبل فكّه): السطر مفتوح، ويُقترح للتحصيل ثانيةً.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { memDb } from './helpers/testDb';
import { confirmContract } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';

test('B2-7 · [متوسط] إلغاء دفعةٍ حُصّلت من الكشف (بلا فكّ المطابقة أولاً): السطر يعود مفتوحاً ويُقترح للتحصيل ثانيةً', () => {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع B27', 0);
  const prop = addProperty(db, { name: 'عقار مصطنع B27' });
  const c = confirmContract(db, contractInput(addUnit(db, prop, { unit_no: 'B27-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000003701', phone: '0500003701', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(db, bank, g, { name: 'b27.csv', hash: 'b27' });
  const s = collectionSuggestions(db, bank)[0];
  approveCollection(db, s.line.id, s.target);
  const pay = db.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [c])!.id;
  // الإلغاء من شاشة الدفعة: الإيداع لمستأجرٍ آخر
  cancelPayment(db, pay, { date: '2026-10-02', reason: 'الإيداع لمستأجرٍ آخر (مصطنع)' });

  const rec = reconciliation(db, bank, '2026-10');
  const view = {
    line: db.get<{ status: string }>(`SELECT status FROM bank_statement_lines WHERE id = ?`, [s.line.id])!.status,
    collectAgain: collectionSuggestions(db, bank).filter((x) => x.line.id === s.line.id).length,
    onlyInStatement: rec.onlyInStatement.map((x) => x.amount),
  };
  // (الواقع: السطر «مطابَق» بحركة التحصيل الملغى، ولا اقتراح تحصيلٍ له، والتقرير لا يعرضه «في الكشف وحده»)
  expect(view).toEqual({ line: 'open', collectAgain: 1, onlyInStatement: [100000] });
  db.close();
});
