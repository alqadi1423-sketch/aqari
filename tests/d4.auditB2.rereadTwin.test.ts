/**
 * المدقق B2 · الجولة الرابعة عشرة · على 52f19cb · الكشف يُحذف ويُعاد على جهاز، والعضو بلا اتصال اعتمد الإيداع من سطره القديم · بياناتٌ
 * مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditB2.rereadTwin.test.ts
 *
 * B2-4 · عالٍ · src/sync/engine.ts:1820-1826 (الحارس بمعرّف السطر stmt_line_id لا بالإيداع: بصمته line_key) مع
 * src/domain/bankStatement/collect.ts:229-237 (بذرة الاعتماد «stmt:سطر:الهدف» بمعرّف السطر) وsrc/domain/bankStatement/store.ts:47-58
 * (إعادة القراءة بعد الحذف بمعرّفاتٍ جديدة · Z1-5) وengine.ts:953-960 (التوأم يُحذف): العضو بلا اتصال يعتمد إيداع ماجد لقسط أكتوبر من
 * السطر L · والمالك (لم يُعتمد عنده شيء) يحذف الكشف ويعيد قراءة الملف نفسه فيأخذ السطر معرّفاً جديداً L' ويعتمد الإيداع نفسه لقسط أكتوبر
 * نفسه · المعرّفان مختلفان فلا يلتقي الاعتمادان (W1) ولا يرفض الحارسُ الثاني: دفعتان حيّتان لقسطٍ واحد من إيداعٍ واحد، والسطر القديم
 * يُحذف توأماً فتبقى حركته «في الدفاتر وحدها» · البنك في الدفاتر 2,000 والكشف 1,000، وفائض 1,000 يُعرض للرد على المستأجر نقداً،
 * وفحوص السلامة كلها خضراء.
 * لماذا يهم: هو Z2-1 بطريقٍ لم يغطّه إصلاحه (ولا حتى للهدف نفسه): حذف الكشف وإعادته مسارٌ مدعوم، والإيراد والبنك ضعفهما، والفائض يُرد
 * مالاً حقيقياً.
 * السلوك الصحيح: الإيداع الواحد (البصمة نفسها) يسند تحصيلاً واحداً في دفاتر المالك: البنك 1,000، ودفعةٌ حيّة واحدة، ولا حركة «في
 * الدفاتر وحدها»، ولا فائض.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { sync, ownerPulls, MEMBER, UID } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync } from '@/sync/engine';
import { confirmContract } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';
import { contractSurpluses } from '@/domain/ledgerReview';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, reconciliation, deleteStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('B2-4 · [عالٍ] المالك يحذف الكشف ويعيده ويعتمد الإيداع، والعضو اعتمده بلا اتصال من سطره القديم: دفاتر المالك بتحصيلٍ واحد منه', async () => {
  const r = new MemoryRemote();
  const owner = memDb(); const m = memDb();
  for (const d of [owner, m]) enableSync(d, UID);
  const bank = addBank(owner, 'بنك مصطنع B24', 0);
  const prop = addProperty(owner, { name: 'عقار مصطنع B24' });
  const c = confirmContract(owner, contractInput(addUnit(owner, prop, { unit_no: 'B24-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000003401', phone: '0500003401', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  const st = saveStatement(owner, bank, g, { name: 'b24.csv', hash: 'b24' });
  await sync(owner, r); await sync(m, r); await sync(m, r);
  const dev = getMeta(m, 'device_id');
  const mark = () => { for (const d of [...r.docs.values()]) if (d.dev === dev && d.by !== MEMBER) r.inject({ ...d, by: MEMBER }); };

  // العضو بلا اتصال يعتمد الإيداع لقسط أكتوبر (السطر L)
  const sm = collectionSuggestions(m, bank)[0];
  approveCollection(m, sm.line.id, sm.target);
  // والمالك يحذف الكشف (لا مطابَق فيه عنده) ويعيد قراءة الملف نفسه، فيعتمد الإيداع للقسط نفسه (السطر L')
  deleteStatement(owner, st.statementId);
  await wait(5);
  saveStatement(owner, bank, g, { name: 'b24.csv', hash: 'b24' });
  const so = collectionSuggestions(owner, bank)[0];
  expect(so.line.id !== sm.line.id && JSON.stringify(so.target) === JSON.stringify(sm.target)).toBe(true);
  approveCollection(owner, so.line.id, so.target);
  for (let i = 0; i < 3; i++) { await sync(owner, r); await sync(m, r); mark(); await ownerPulls(owner, r); }

  const view = {
    bank: bankBalance(owner, bank),
    livePayments: Number(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL`, [c])!.n),
    onlyInBooks: reconciliation(owner, bank, '2026-10').onlyInBooks.map((x) => x.amount),
    surplus: contractSurpluses(owner).map((x) => x.amount),
  };
  // (الواقع: البنك 2,000 ودفعتان حيّتان لقسطٍ واحد، وتحصيل العضو «في الدفاتر وحدها» 1,000، وفائض 1,000 للرد)
  expect(view).toEqual({ bank: 100000, livePayments: 1, onlyInBooks: [], surplus: [] });
  owner.close(); m.close();
});
