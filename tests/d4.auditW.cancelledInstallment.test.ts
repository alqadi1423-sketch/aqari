/**
 * المدقق W · الجولة الحادية عشرة · اعتماد أقساطٍ متتالية صار أحدها «ملغية» بعد عرض الاقتراح · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditW.cancelledInstallment.test.ts
 *
 * W3 · متوسط · src/domain/bankStatement/collect.ts:174-179: الاعتماد يتحقق من المبلغ بمجموع متبقّي الأقساط المختارة كلها بلا شرط
 * حالتها (COLLECTIBLE_INSTALLMENT_SQL الذي يبني به الاقتراح يستبعد «ملغية»)، وrecordBulkRentPayment (contracts/service.ts:921) يوزّع
 * على غير الملغاة وحدها ويجعل الباقي «فائضاً» رصيداً دائناً للمستأجر (2410) · فاقتراحٌ بقسطين عُرض ثم أُلغي العقد (من الجهاز نفسه أو
 * وصل إلغاؤه بالمزامنة والشاشة مفتوحة، أو «اعتماد الجاهزة» بقائمةٍ أُخذت قبل الإلغاء) يُعتمد «ناجحاً»: نصف الإيداع إيرادٌ للقسط القائم،
 * ونصفه التزامٌ للمستأجر لم يطلبه أحد، بلا رسالة · والقسط الواحد الملغى يُرفض (recordRentPayment) فالمساران يختلفان.
 * لماذا يهم: «كله أو لا شيء» و«ما لا يصحّ يُرفض ولا يمسّ شيئاً» (رأس collect.ts) لا يتحققان، والمال يقع في حسابٍ غير الذي اعتمده
 * المستخدم.
 * السلوك الصحيح: قسطٌ «ملغية» في الهدف (أو لعقدٍ صار ملغى لا يُحصَّل عليه) يُرفض به الاعتماد كله ولا يُسجَّل شيء.
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, cancelContract } from '@/domain/contracts/service';
import { accountBalance, bankBalance } from '@/domain/accounting/ledger';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';

describe('W3 · الأقساط المتتالية وفيها قسطٌ ألغي بعد الاقتراح', () => {
  test('الاعتماد يُرفض ولا يمسّ شيئاً، ولا يذهب نصف الإيداع رصيداً دائناً للمستأجر', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع W3', 0);
    const prop = addProperty(db, { name: 'عقار مصطنع W3' });
    const c = confirmContract(db, contractInput(addUnit(db, prop, { unit_no: 'W3-1' }), {
      tenant: 'ماجد المصطنع', idNumber: '1000000931', phone: '0500000931', valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
    const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/02', 'حوالة واردة ماجد', '', '2,000.00', '2,000.00']]);
    if (!r.ok) throw new Error(r.error);
    saveStatement(db, bank, r, { name: 'w3-oct.csv', hash: 'w3' });
    const [sg] = collectionSuggestions(db, bank);
    // اقتراح «جاهز»: قسطا أكتوبر ونوفمبر بتحويلٍ واحد
    expect([sg.target.kind, sg.target.kind === 'installments' ? sg.target.installmentIds.length : 0, sg.level]).toEqual(['installments', 2, 'ready']);

    // ثم يُلغى العقد من 20 أكتوبر وتُلغى أقساطه القادمة (نوفمبر فما بعده)
    cancelContract(db, c, { date: '2026-10-20', reason: 'مغادرة مصطنعة', installmentsFate: 'cancel', settle: false,
      deductionHalalas: 0, deductionReason: '', refundHalalas: 0 } as Parameters<typeof cancelContract>[2]);
    expect(db.get<{ s: string }>(`SELECT status AS s FROM contract_installments WHERE contract_id = ? AND due_date = '2026-11-01'`, [c])!.s).toBe('ملغية');

    let threw = false;
    try { approveCollection(db, sg.line.id, sg.target); } catch { threw = true; }
    // الصحيح: يُرفض (قسط نوفمبر ملغى) · والواقع: يُعتمد وألفٌ منه رصيدٌ دائن للمستأجر في 2410
    expect({ threw, credit2410: accountBalance(db, '2410'), bank: bankBalance(db, bank) }).toEqual({ threw: true, credit2410: 0, bank: 0 });
    db.close();
  });
});
