/**
 * المدقق Z1 · الجولة الثالثة عشرة · معرّف السطر من بصمته (src/domain/bankStatement/store.ts:44 و64-67 · إصلاح Y3 وX2) يجعل حفظ الكشف على
 * جهازٍ ثانٍ تعديلاً لصفٍّ قائم · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditZ1.lateImport.test.ts
 *
 * Z1-4 · متوسط · src/domain/bankStatement/store.ts:64-67 (السطر الجديد بالمعرّف الحتمي مفتوحاً بوقت الحفظ) مع «الأحدث يغلب» في
 * src/sync/engine.ts (applyOne): المالك يقرأ كشف أكتوبر على هاتفه، ويعتمد تحصيل حوالة ماجد (دفعةٌ وقيدٌ وحركة بنك، والسطر مطابَقٌ بها)
 * ويستبعد رسماً بسببه، ويرفع · وجهازه الآخر (لوحٌ لم يتزامن منذ الصباح) يقرأ الملف نفسه بعد ذلك: سطوره بالمعرّفات نفسها «مفتوحة» وأحدث
 * وقتاً، فتغلب في السحابة وعلى الهاتف: السطر يعود مفتوحاً بلا حركة، والاستبعاد وسببه يضيعان، وحركة التحصيل «في الدفاتر وحدها» ·
 * وقبل db011e7 كان الكشف يتضاعف (X2) والمطابقة باقية؛ وصار الالتقاء يمحوها · والكشف المتداخل من ملفٍ آخر كذلك (البصمة لا الملف).
 * لماذا يهم: اعتمادٌ واستبعادٌ صريحان يضيعان بلا تعارضٍ ظاهر لمجرد أن جهازاً آخر قرأ الكشف، والسبب المكتوب لا يعود باقتراح.
 * السلوك الصحيح: حفظ سطرٍ موجودٍ في السحابة على جهازٍ آخر لا يمحو حاله: يبقى المطابَق مطابَقاً بحركته والمستبعَد بسببه على الجهازين.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync } from './helpers/rederive';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, excludeLine, reconciliation } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import type { DB } from '@/db/adapter';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Z1-4 · [متوسط] الملف نفسه يُقرأ على جهازٍ آخر بعد اعتماد سطوره: سطوره المفتوحة الأحدث تمحو المطابقة والاستبعاد (store.ts:64-67)', () => {
  test('هاتف المالك يعتمد ويستبعد، ولوحه يقرأ الملف نفسه بعده: بعد المزامنة الحوالة مطابَقةٌ بحركة تحصيلها والرسم مستبعَدٌ بسببه على الجهازين', async () => {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع Z1-4', 0);
    const prop = addProperty(p.owner, { name: 'عقار مصطنع Z1-4' });
    confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: 'Z1-4' }), {
      tenant: 'ماجد المصطنع', idNumber: '1000000944', phone: '0500000944', valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    const oct = () => {
      const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
        ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00'], ['2026/10/05', 'رسوم مصطنعة', '5.00', '', '995.00']]);
      if (!r.ok) throw new Error(r.error);
      return r;
    };
    // الهاتف: يقرأ ويعتمد ويستبعد ويرفع
    saveStatement(p.owner, bank, oct(), { name: 'oct-z1-4.csv', hash: 'z1-4' });
    const s = collectionSuggestions(p.owner, bank);
    expect(s.map((x) => [x.line.date, x.level])).toEqual([['2026-10-02', 'ready']]);
    const { txId } = approveCollection(p.owner, s[0].line.id, s[0].target);
    const fee = p.owner.get<{ id: string }>(`SELECT id FROM bank_statement_lines WHERE date = '2026-10-05'`)!.id;
    excludeLine(p.owner, fee, 'رسمٌ يستردّه البنك (مصطنع)');
    await sync(p.owner, p.r);
    await wait(5);
    // اللوح (لم يتزامن بعد) يقرأ الملف نفسه
    saveStatement(p.dev, bank, oct(), { name: 'oct-z1-4.csv', hash: 'z1-4' });
    for (let i = 0; i < 3; i++) { await sync(p.dev, p.r); await sync(p.owner, p.r); }

    const view = (db: DB) => ({
      lines: db.all<{ d: string; status: string; tx: string | null; note: string }>(
        `SELECT date AS d, status, bank_tx_id AS tx, note FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY date`, [bank]),
      onlyInBooks: reconciliation(db, bank, '2026-10').onlyInBooks.length,
    });
    // (الواقع: السطران «مفتوحان» بلا حركةٍ ولا سبب على الجهازين، وحركة التحصيل في الدفاتر وحدها)
    const want = {
      lines: [
        { d: '2026-10-02', status: 'matched', tx: txId, note: '' },
        { d: '2026-10-05', status: 'excluded', tx: null, note: 'رسمٌ يستردّه البنك (مصطنع)' },
      ],
      onlyInBooks: 0,
    };
    expect({ phone: view(p.owner), tablet: view(p.dev) }).toEqual({ phone: want, tablet: want });
    p.close();
  });
});
