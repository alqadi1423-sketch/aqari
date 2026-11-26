/**
 * المدقق A2 · الجولة الرابعة عشرة · على 52f19cb · «الأقدم إنشاءً يغلب» في صفوف الكشف (إصلاح Z1-4) يمحو ما اعتمده الجهاز الذي قرأ الملف
 * بعد الآخر · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditA2.laterReader.test.ts
 *
 * A2-4 · متوسط · src/sync/engine.ts:1781-1784 (keepLocal: سطرٌ وارد أحدث إنشاءً من نسخته هنا لا يُطبَّق أياً كان ما فيه، ويرفع جهاز المالك
 * نسخته) مع engine.ts:1867-1869 (recreated: الأقدم إنشاءً يغلب التعارض) وsrc/domain/bankStatement/store.ts:48-59 (معرّف السطر الحتمي من
 * بصمته): هاتف المالك يقرأ كشف أكتوبر صباحاً بلا اتصال ولا يعتمد شيئاً · ولوحه، بلا اتصال أيضاً، يقرأ الملف نفسه بعد ذلك فيعتمد حوالة ماجد
 * تحصيلاً لقسط أكتوبر ويستبعد رسماً بسببه · عند المزامنة نسخة الهاتف «المفتوحة» أقدم إنشاءً فتغلب على الجهازين: السطران «مفتوحان» بلا حركةٍ
 * ولا سبب، وحركة التحصيل «في الدفاتر وحدها» · وZ1-4 أصلح الاتجاه الآخر وحده (الأقدم هو الذي اعتمد)، فصار ما يحفظه أيُّ جهازٍ قرأ الملف
 * أولاً يمحو اعتماد غيره.
 * لماذا يهم: Y3 جعل الملف الواحد على جهازين بلا اتصال كشفاً واحداً بسطوره ليلتقي ما يُعمل عليهما (DESIGN §١٣.٢٢)؛ والاعتماد والاستبعاد
 * الصريحان يضيعان بلا تعارضٍ ظاهر بحسب أيّ الجهازين قرأ أولاً، والسبب المكتوب لا يعود باقتراح.
 * السلوك الصحيح: السطر الذي عُدّل على أحد الجهازين لا تمحوه نسخةٌ لم تُعدَّل لأنها أقدم إنشاءً: الحوالة مطابَقةٌ بحركة تحصيلها والرسم
 * مستبعَدٌ بسببه على الجهازين، ولا شيء «في الدفاتر وحدها».
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync } from './helpers/rederive';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, excludeLine, reconciliation } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import type { DB } from '@/db/adapter';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('A2-4 · [متوسط] الهاتف يقرأ كشف أكتوبر ولا يعتمد، واللوح يقرؤه بعده فيعتمد ويستبعد: بعد المزامنة الاعتماد والاستبعاد باقيان على الجهازين', async () => {
  const p = await pair();
  const bank = addBank(p.owner, 'بنك مصطنع A2-4', 0);
  const prop = addProperty(p.owner, { name: 'عقار مصطنع A2-4' });
  confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: 'A24-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000002144', phone: '0500002144', valueHalalas: 1200000, cycle: 'شهرية',
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
  // الهاتف بلا اتصال: يقرأ الكشف صباحاً ولا يعتمد شيئاً
  saveStatement(p.owner, bank, oct(), { name: 'oct-a24.csv', hash: 'a24' });
  await wait(5);
  // واللوح بلا اتصال: يقرأ الملف نفسه بعده، ويعتمد الحوالة ويستبعد الرسم
  saveStatement(p.dev, bank, oct(), { name: 'oct-a24.csv', hash: 'a24' });
  const s = collectionSuggestions(p.dev, bank);
  expect(s.map((x) => [x.line.date, x.level])).toEqual([['2026-10-02', 'ready']]);
  const { txId } = approveCollection(p.dev, s[0].line.id, s[0].target);
  const fee = p.dev.get<{ id: string }>(`SELECT id FROM bank_statement_lines WHERE date = '2026-10-05'`)!.id;
  excludeLine(p.dev, fee, 'رسمٌ يستردّه البنك (مصطنع)');
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
