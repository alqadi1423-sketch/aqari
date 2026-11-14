/**
 * المراجعة الشاملة 2026-11-13 · المراجع A1 (دورة الإيجار) · بيانات مصطنعة كلها.
 *
 * A1-5 · متوسط · src/domain/contracts/paid.ts:47 (recomputeInstallments يستثني «ملغية») · src/domain/contracts/cancelPayment.ts:159-169
 *        (المعاينة تعد بمسدَّدٍ صفر) و238 · src/domain/stats.ts:204-210 (قيمة الملغى)
 *   السيناريو: عقد ١٢٬٠٠٠ بأقساط ربع سنوية ٣٬٠٠٠ · سُدّد قسط الربع الأول كاملاً · ودُفع ١٬٠٠٠ من قسط 2026-04-01 مقدماً في 2026-03-20 · أُلغي العقد في
 *   2026-03-25 بإلغاء الدفعات بعده، فصار القسط «ملغية» ومسدَّده ١٬٠٠٠ · ثم أُلغيت دفعة الـ١٬٠٠٠ لأنها سُجّلت خطأً.
 *   النتيجة اليوم: القيد عُكس والإيراد صفر، لكن مسدَّد القسط يبقى ١٬٠٠٠ (لا يُعاد حسابه لأنه «ملغية»)، مع أن معاينة الإلغاء
 *   عرضت «بعد: ٠» · فبطاقة «عقود ملغية» تقول ٨٬٠٠٠ والصحيح ٩٬٠٠٠ (ثلاثة أقساط ملغاة)، و«المسدَّد» في تفاصيل القسط ١٬٠٠٠ بلا دفعة،
 *   وأداة الفائض تطرح ١٬٠٠٠ «مسدَّداً ميتاً» لا وجود له فتُخفي فائضاً حقيقياً على العقد نفسه،
 *   وكشف حساب المستأجر يُظهر عليه ديناً ١٬٠٠٠ بسطر «قسط ملغى · المسدَّد منه» بلا دفعة تقابله (src/domain/statement.ts:36-41).
 *   لماذا يهم: المسدَّد المخزَّن لا يطابق الدفعات والدفتر (قرار المالك 2026-10-03: «مسدَّد القسط … يُحسب دائماً من الدفعات»).
 *   السلوك الصحيح: المسدَّد يُعاد حسابه من الدفعات للقسط الملغى أيضاً، والحالة «ملغية» تبقى كما هي.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, cancelContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment, planCancelPayment } from '@/domain/contracts/cancelPayment';
import { ownerCashIn } from '@/domain/cashOps';
import { contractCancelledValue } from '@/domain/stats';
import { accountBalance } from '@/domain/accounting/ledger';
import { tenantStatementRows } from '@/domain/statement';
import type { ContractRow } from '@/domain/contracts/rules';

test.failing('A1-5 إلغاء دفعة قسطٍ ملغى يعيد مسدَّده صفراً كما وعدت المعاينة', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 500000, date: '2026-01-01' });
  const u = addUnit(db, addProperty(db, { name: 'عقار إلغاء مصطنع' }), { unit_no: 'Q-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر إلغاء مصطنع', idNumber: '1000000950',
    valueHalalas: 1200000, cycle: 'ربع سنوية', start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  // قسط الربع الأول مسدَّد كاملاً في وقته، فلا دين حقيقياً على المستأجر
  const q1 = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? AND due_date = '2026-01-01'`, [cid])!.id;
  recordRentPayment(db, cid, { installmentId: q1, period: '', date: '2026-01-01',
    lines: [{ method: 'cash', amountHalalas: 300000 }], discountHalalas: 0, notes: '' });
  const q2 = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? AND due_date = '2026-04-01'`, [cid])!.id;
  const pid = recordRentPayment(db, cid, { installmentId: q2, period: '', date: '2026-03-20',
    lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  cancelContract(db, cid, { date: '2026-03-25', reason: 'إنهاء مصطنع', installmentsFate: 'cancel', settle: false,
    deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });
  expect(db.get(`SELECT status, paid_halalas AS paid FROM contract_installments WHERE id = ?`, [q2])).toEqual({ status: 'ملغية', paid: 100000 });

  const plan = planCancelPayment(db, pid, '2026-03-26');
  expect(plan.installments.find((i) => i.id === q2)!.toPaid).toBe(0); // المعاينة: بعد الإلغاء صفر
  cancelPayment(db, pid, { date: '2026-03-26', reason: 'سُجّلت خطأً' });
  expect(accountBalance(db, '4200')).toBe(300000); // قسط الربع الأول وحده

  // اليوم: يبقى ١٠٠٠٠٠
  expect(Number(db.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = ?`, [q2])!.p)).toBe(0);
  // قيمة الملغى: الأقساط الثلاثة الملغاة كاملة ٩٬٠٠٠ (اليوم ٨٬٠٠٠)
  const c = db.get<ContractRow>(`SELECT * FROM contracts WHERE id = ?`, [cid])!;
  expect(contractCancelledValue(db, c)).toBe(900000);
  // وكشف حساب المستأجر (وثيقة تُسلَّم له) لا يُظهر ديناً: لا دفعة حيّة ولا قسطاً حلّ عليه (اليوم: مدين ١٬٠٠٠ «قسط ملغى · المسدَّد منه»)
  const balance = tenantStatementRows(db, cid, '2026-11-13').reduce((s, r) => s + r.debitHalalas - r.creditHalalas, 0);
  expect(balance).toBe(0);
  db.close();
});
