/**
 * المدقق الخارجي X · الجولة الثانية عشرة · زمن اقتراحات التحصيل بعد إصلاح V١٠ (src/domain/bankStatement/collect.ts collectionSuggestions):
 * الشاشة (app/bankStatement.tsx) تحسبه متزامناً على خيط الواجهة في كل عرضٍ وبعد كل اعتماد · يسقط على الشيفرة الحالية (7ef3f8e) ويصف
 * السلوك الصحيح · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditX.perf.test.ts
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';

describe('X7 · [منخفض] الفهرس بالمبلغ لا يجعل الزمن خطياً: النافذة ±45 يوماً تمرّ على كل قسطٍ بالمبلغ نفسه، والمجموعات تُبنى بنسخ المصفوفة ([...a, x])، فالزمن يكبر بمكعب عدد الوحدات (collect.ts:103 و132-135 و173)', () => {
  // بأرقام هذا الجهاز (Node): مئة وحدة 0.37 ثانية، ومئتان 1.3، وثلاثمئة 3.3 (ثلاثة أضعاف البيانات تسعة أضعاف الزمن) · وmatchSuggestions
  // بالبناء نفسه (store.ts:96 و122) ثانيتان لثلاثمئة وحدة · وHermes على الجوال أبطأ بأضعاف، والشاشة تعيد الحساب بعد كل «اعتماد»
  test('عمارةٌ من ثلاثمئة وحدةٍ بإيجارٍ واحد وسنةٌ من الإيداعات المفتوحة (3,600): الاقتراحات في أقل من ثانيةٍ ونصف كحدّ V١٠', () => {
    const UNITS = 300;
    const dates: string[] = [];
    for (let m = 1; m <= 12; m++) for (let i = 0; i < UNITS; i++) dates.push(`2026-${String(m).padStart(2, '0')}-${String(1 + (i % 9)).padStart(2, '0')}`);
    dates.sort();
    let bal = 0;
    const rows = dates.map((d, i) => { bal += 150000; return [d.replace(/-/g, '/'), 'حوالة واردة مصطنعة ' + (i % UNITS), '', '1,500.00', (bal / 100).toFixed(2)]; });
    const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'], ...rows]);
    if (!r.ok) throw new Error('لم يُقرأ: ' + r.error);
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع للمدقق X', 0);
    const p = addProperty(db, { name: 'عمارة مصطنعة للمدقق X' });
    for (let i = 0; i < UNITS; i++) {
      confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'X7-' + i }), {
        tenant: 'مستأجر مصطنع ' + i, idNumber: String(1000007000 + i), phone: '05' + String(20000000 + i),
        valueHalalas: 1800000, cycle: 'شهرية', start: '2026-01-01', end: '2026-12-31', depositHalalas: 0,
      }));
    }
    saveStatement(db, bank, r, { name: 'year.pdf', hash: 'x7' });
    const t0 = Date.now();
    const c = collectionSuggestions(db, bank);
    const ms = Date.now() - t0;
    expect(c.length).toBeGreaterThan(3000);
    // الواقع: نحو 3,300 ms · الصحيح: فهرسٌ يصل إلى المرشحين وحدهم (أقدم القائم لكل عقد، وما يستحق في أسبوع السطر) ومجموعاتٌ تُبنى بالإضافة
    expect(ms < 1500 ? 'ok' : ms + 'ms').toBe('ok');
    db.close();
  });
});
