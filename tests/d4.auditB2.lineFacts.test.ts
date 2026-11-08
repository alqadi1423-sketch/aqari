/**
 * المدقق B2 · الجولة الرابعة عشرة · على 52f19cb · وقائع سطر الكشف (بنكه ومبلغه) يغيّرها عضوٌ فيقبلها جهاز المالك · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditB2.lineFacts.test.ts
 *
 * B2-9 · متوسط · src/sync/engine.ts:946-1015 (statementLineFix يحكم على المطابقة بـ bank_id وamount_halalas من المستند الوارد نفسه، ولا
 * يقارنهما بالسطر هنا) وengine.ts:2005 (upsertRow بلا أعمدةٍ مجمَّدة لسطر الكشف، بخلاف FROZEN_COLS للدفعات · engine.ts:1322):
 * التطبيق لا يغيّر بعد القراءة بنك السطر ولا مبلغه ولا تاريخه ولا بصمته (وقائع من البنك) · لكن عضواً بـ«البنوك ٣» (قواعد السحابة تجيز له
 * تعديل السطر · rulesGen.ts:184) يعيد كتابة سطر إيداع ماجد 1,000 في البنك الأول سطراً في البنك الثاني بـ500 مطابَقاً بحركة تحصيل
 * سالم هناك · فيقبله جهاز المالك كما هو: الإيداع يختفي من كشف البنك الأول (الختامي صفر، ولا شيء «في الكشف وحده»، و«غير مفسَّر» صفر)
 * ويظهر في البنك الثاني بلا كشف · وكذلك تعيد «إعادة الربط بحركة التحصيل الباقي» (engine.ts:997) ربط السطر ببنك المستند ومبلغه لا ببنكه.
 * لماذا يهم: كشف البنك دليلٌ خارجي؛ تعديل وقائعه بمزامنةٍ يمحو إيداعاً حقيقياً من المطابقة بلا أثر (أخفى من الاستبعاد الذي يُبقي
 * السطر بسببه ظاهراً)، والمالك يرى بنكه مطابَقاً.
 * السلوك الصحيح: وقائع السطر على جهاز المالك كما قُرئت: يبقى في البنك الأول بـ1,000، ولا يُطابَق بحركةٍ من بنكٍ آخر، ويظهر «في الكشف
 * وحده» حتى يُحصَّل.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { sync, ownerPulls, MEMBER, UID } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync } from '@/sync/engine';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';
import { getMeta } from '@/repos/settings';

test('B2-9 · [متوسط] عضوٌ ينقل سطر إيداعٍ إلى بنكٍ آخر بمبلغٍ آخر مطابَقاً بحركةٍ هناك: على جهاز المالك يبقى السطر في بنكه بمبلغه «في الكشف وحده»', async () => {
  const r = new MemoryRemote();
  const owner = memDb(); const m = memDb();
  for (const d of [owner, m]) enableSync(d, UID);
  const b1 = addBank(owner, 'بنك أول مصطنع B29', 0);
  const b2 = addBank(owner, 'بنك ثانٍ مصطنع B29', 0);
  const prop = addProperty(owner, { name: 'عقار مصطنع B29' });
  const c = confirmContract(owner, contractInput(addUnit(owner, prop, { unit_no: 'B29-1' }), {
    tenant: 'سالم المصطنع', idNumber: '1000004001', phone: '0500004001', valueHalalas: 600000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  // تحصيل سالم 500 في البنك الثاني (حركةٌ حيّة غير مطابَقة)
  const inst = owner.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!.id;
  recordRentPayment(owner, c, { installmentId: inst, period: 'أكتوبر', date: '2026-10-05', lines: [{ method: 'bank', bankId: b2, amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  const tx2 = owner.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ?`, [b2])!.id;
  // كشف البنك الأول: إيداع ماجد 1,000
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(owner, b1, g, { name: 'b29.csv', hash: 'b29' });
  await sync(owner, r); await sync(m, r); await sync(m, r);
  const L = owner.get<{ id: string }>(`SELECT id FROM bank_statement_lines`)!.id;

  // العضو («البنوك ٣») يعيد كتابة السطر: البنك الثاني، 500، مطابَقاً بحركة سالم
  const ld = [...r.docs.values()].find((d) => d.t === 'bank_statement_lines' && d.k === L)!;
  r.inject({ ...ld, by: MEMBER, op: 'banks', dev: getMeta(m, 'device_id')!, u: new Date().toISOString(),
    d: { ...ld.d, bank_id: b2, amount_halalas: 50000, status: 'matched', bank_tx_id: tx2, matched_at: new Date().toISOString() } });
  await ownerPulls(owner, r);

  const line = owner.get<{ bank: string; amount: number; tx: string | null }>(
    `SELECT bank_id AS bank, amount_halalas AS amount, bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [L])!;
  const view = {
    inFirstBank: line.bank === b1,
    amount: Number(line.amount),
    onSecondBankTx: line.tx === tx2,
    firstOnlyInStatement: reconciliation(owner, b1, '2026-10').onlyInStatement.map((x) => x.amount),
  };
  // (الواقع: السطر في البنك الثاني بـ500 مطابَقٌ بحركة سالم، وكشف البنك الأول بلا سطور: ختاميه صفر ولا شيء «في الكشف وحده»)
  expect(view).toEqual({ inFirstBank: true, amount: 100000, onSecondBankTx: false, firstOnlyInStatement: [100000] });
  owner.close(); m.close();
});
