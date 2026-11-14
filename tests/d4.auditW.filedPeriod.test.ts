/**
 * المدقق W · الجولة الحادية عشرة · اقتراح تحصيلٍ «جاهز» لإيداعٍ في ربعٍ قُدِّم إقراره · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditW.filedPeriod.test.ts
 *
 * W6 · منخفض · src/domain/bankStatement/collect.ts:52-159 (collectionSuggestions): الاقتراح لا يعرف الفترة المقدَّم إقرارها، والاعتماد
 * يسجّل التحصيل بتاريخ السطر فيرفضه recordRentPayment وcollectClaim وpayInvoice (isFiledDate/requireOpenPeriod · القرار ٦) حتماً ·
 * والسطور تُرتَّب بالتاريخ، فكشفٌ يبدأ في ربعٍ مقدَّم يجعل أول «جاهزٍ» فيه ممتنعاً، و«اعتماد الجاهزة» (app/bankStatement.tsx:
 * approveCollect) يتوقف عند أول رفض فلا يُعتمد شيءٌ مما بعده وهو صحيح.
 * لماذا يهم: «جاهزة للاعتماد» وعدٌ بأن الاعتماد يصحّ، والقائمة المعروضة تُسقط الدفعة كلها لسطرٍ واحد.
 * السلوك الصحيح: ما يُعرض «جاهزاً» يُعتمد بلا رفض (سطرٌ في فترةٍ مقدَّمة لا يُقترح، أو يُعرض «تحتاج مراجعة» بسببه).
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { fileVatReturn } from '@/domain/vatFilings';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';

describe('W6 · «جاهزة» لإيداعٍ في ربعٍ قُدِّم إقراره', () => {
  test('كل اقتراحٍ «جاهز» يُعتمد بلا رفض', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع W6', 0);
    const prop = addProperty(db, { name: 'عقار مصطنع W6' });
    confirmContract(db, contractInput(addUnit(db, prop, { unit_no: 'W6-1' }), {
      tenant: 'سالم المصطنع', idNumber: '1000000961', phone: '0500000961', valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-09-01', end: '2027-08-31', depositHalalas: 0,
    }));
    const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/09/02', 'حوالة واردة سالم', '', '1,000.00', '1,000.00'],
      ['2026/10/02', 'حوالة واردة سالم', '', '1,000.00', '2,000.00']]);
    if (!r.ok) throw new Error(r.error);
    saveStatement(db, bank, r, { name: 'w6.csv', hash: 'w6' });
    // قُدِّم إقرار الربع الثالث (يوليو–سبتمبر)
    fileVatReturn(db, 2026, 3, '2026-10-20');
    const ready = collectionSuggestions(db, bank).filter((s) => s.level === 'ready');
    expect(ready.length).toBeGreaterThan(0);
    // كما يفعل «اعتماد الجاهزة»: بالترتيب، وأول رفضٍ يوقف ما بعده
    const failed: string[] = [];
    for (const s of ready) {
      try { approveCollection(db, s.line.id, s.target); } catch (e) { failed.push(s.line.date + ': ' + (e as Error).message); }
    }
    expect(failed).toEqual([]);
    db.close();
  });
});
