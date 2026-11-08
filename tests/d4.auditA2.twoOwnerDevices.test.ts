/**
 * المدقق A2 · الجولة الرابعة عشرة · على 52f19cb · حارس Z2-1 (قيدٌ حيٌّ ثانٍ لسطر الكشف نفسه) يرفض نسخة العضو وحدها، وعلى الجهاز الذي
 * سبق إليه قيدٌ آخر وحده · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditA2.twoOwnerDevices.test.ts
 *
 * A2-2 · عالٍ · src/sync/engine.ts:1820-1826 (الحارس بشرط byMember وبما هنا لحظة الوصول): للمالك جهازان (هاتفٌ ولوح) · العضو سجّل قسط
 * أكتوبر نقداً في المكتب فاعتمد حوالة ماجد لقسط نوفمبر ورفع، وهاتف المالك سحبها فقبلها (لا قيد آخر للسطر عنده) · ولوح المالك، بلا اتصال
 * منذ الصباح، يعتمد الحوالة نفسها لأكتوبر (اقتراحه) · عند المزامنة يرفض اللوح قيد العضو لأن قيده سبق إليه، ويصل قيد اللوح إلى الهاتف فلا
 * يُفحص لأنه من المالك: في دفاتر الهاتف تحصيلان بنكيان من إيداعٍ واحد (البنك 2,000 والكشف 1,000، وتحصيلٌ «في الدفاتر وحدها»، وأكتوبر
 * مسدَّدٌ نقداً ومن الإيداع)، وفي دفاتر اللوح تحصيلٌ واحد · جهازا المالك نفسه يختلفان بلا رجعة، والقيد المرفوض باقٍ في السحابة.
 * لماذا يهم: ما أراده Z2-1 (الإيداع الواحد يسند تحصيلاً واحداً) يتحقق على جهازٍ دون آخر بحسب ترتيب الوصول، وأيّ جهازٍ ثانٍ للمالك (أو
 * هاتفٌ جديد) يرى دفاتر أخرى · والفائض يُعرض للرد على المستأجر.
 * السلوك الصحيح: قاعدةٌ واحدة لا يغيّرها ترتيب الوصول ولا كاتب القيد: على جهازي المالك تحصيلٌ بنكيٌّ واحد من الإيداع، والبنك 1,000، ولا
 * شيء «في الدفاتر وحدها».
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { sync, MEMBER, UID } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync } from '@/sync/engine';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

// حدٌّ معروف موثَّق (DESIGN §١٣.٢٢ · القرار ٦٣): جهازا المالك يكتبان بلا حَكَمٍ بينهما، فلا يُحسم «أيّ القيدين سبق» إلا بمرجعٍ واحد للترتيب
// (البند ٥ · ٢، ينتظر قرار البنية) · test.failing يسقط حين يُصلح فيُذكَّر به
test.failing('A2-2 · [عالٍ] العضو يعتمد الحوالة لنوفمبر ويقبلها هاتف المالك، ولوح المالك يعتمدها لأكتوبر: على الجهازين تحصيلٌ بنكيٌّ واحد', async () => {
  const r = new MemoryRemote();
  const phone = memDb(); const tablet = memDb(); const member = memDb();
  for (const d of [phone, tablet, member]) enableSync(d, UID);
  const mid = getMeta(member, 'device_id');
  /** ما كتبه جهاز العضو بكاتبه العضو (بوقته في السحابة) */
  const asMember = () => { for (const d of [...r.docs.values()]) if (d.dev === mid && d.by !== MEMBER) r.docs.set(d.id, { ...d, by: MEMBER }); };
  const bank = addBank(phone, 'بنك مصطنع A2-2', 0);
  const prop = addProperty(phone, { name: 'عقار مصطنع A2-2' });
  const c = confirmContract(phone, contractInput(addUnit(phone, prop, { unit_no: 'A22-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000002122', phone: '0500002122', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(phone, bank, g, { name: 'a22-oct.csv', hash: 'a22' });
  for (let i = 0; i < 2; i++) { await sync(phone, r); await sync(tablet, r); await sync(member, r); asMember(); }
  await sync(phone, r);

  // العضو: أكتوبر نقداً في المكتب، فاقتراحه للحوالة قسط نوفمبر · يعتمده ويرفع، ويسحبه هاتف المالك
  const [oct, nov] = member.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 2`, [c]).map((x) => x.id);
  recordRentPayment(member, c, { installmentId: oct, period: 'أكتوبر', date: '2026-10-01', lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  const sm = collectionSuggestions(member, bank)[0];
  expect(sm.target).toEqual({ kind: 'installments', contractId: c, installmentIds: [nov] });
  approveCollection(member, sm.line.id, sm.target);
  await sync(member, r); asMember();
  await sync(phone, r); await sync(phone, r);
  expect(bankBalance(phone, bank)).toBe(100000);

  // لوح المالك بلا اتصال منذ الصباح: اقتراحه للحوالة نفسها قسط أكتوبر
  const st = collectionSuggestions(tablet, bank)[0];
  expect([st.line.id, st.target]).toEqual([sm.line.id, { kind: 'installments', contractId: c, installmentIds: [oct] }]);
  approveCollection(tablet, st.line.id, st.target);
  for (let i = 0; i < 3; i++) { await sync(tablet, r); await sync(phone, r); await sync(member, r); asMember(); }

  const books = (db: DB) => ({
    bank: bankBalance(db, bank),
    bankPayments: Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL AND method_label != 'نقداً'`, [c])!.n),
    onlyInBooks: reconciliation(db, bank, '2026-10').onlyInBooks.length,
  });
  // في الكشف إيداعٌ واحد بـ1,000
  // (الواقع: الهاتف بتحصيلين بنكيين والبنك 2,000 وتحصيلٌ «في الدفاتر وحدها»، واللوح بتحصيلٍ واحد)
  const want = { bank: 100000, bankPayments: 1, onlyInBooks: 0 };
  expect({ phone: books(phone), tablet: books(tablet) }).toEqual({ phone: want, tablet: want });
  phone.close(); tablet.close(); member.close();
});
