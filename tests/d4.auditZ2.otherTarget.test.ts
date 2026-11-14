/**
 * المدقق Z2 · الجولة الثالثة عشرة · على db011e7 · الإيداع الواحد يُعتمد على جهازين لهدفين مختلفين · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditZ2.otherTarget.test.ts
 *
 * Z2-1 · عالٍ · src/domain/bankStatement/collect.ts:227-235 (approveCollection: البذرة «stmt:سطر:الهدف:الاعتماد») مع
 * src/sync/engine.ts:937-981 (statementLineCheck) وcollect.ts:85-93 (المطالبات والفواتير بلا ترتيب، فالتعادل بترتيب rowid):
 * إصلاح W1 يدمج اعتمادَي الجهازين للسطر نفسه إن كان الهدف نفسه وحده · فإن اعتمد جهازان السطر نفسه لهدفين مختلفين اختلفت البذرة
 * والمعرّفات، فيبقى في دفاتر المالك تحصيلان كاملان من إيداعٍ واحد: السطر يأخذ إحدى الحركتين (الأحدث يغلب) والأخرى حيّةٌ «في
 * الدفاتر وحدها»، ورصيد البنك في الدفاتر ضعف الكشف، وفحوص السلامة خضراء · والهدفان يختلفان طبيعياً:
 *  أ) جهاز العضو الثاني سجّل نقداً قسط أكتوبر فصار اقتراحه للإيداع قسط نوفمبر، والأول لا يعرف النقد فيعتمده لأكتوبر «جاهزاً»:
 *     قسط أكتوبر مسدَّد مرتين (نقداً ومن الإيداع) فيُعرض فائضه 1,000 للرد على المستأجر.
 *  ب) بالبيانات نفسها على الجهازين: مطالبتان متساويتان للمستأجر نفسه أُنشئت كلٌّ منهما على جهاز، فترتيبهما (rowid) معكوسٌ بين
 *     الجهازين ويقترح كلٌّ منهما للإيداع مطالبةً غير التي يقترحها الآخر · فتُحصَّل المطالبتان من إيداعٍ واحد.
 * لماذا يهم: «اعتماد الجاهزة» على جهازين لموظفَين يعالجان الكشف نفسه يضاعف التحصيل بصمت (ما أصلحه W1 للهدف نفسه)، والإيراد
 * والذمم والبنك كلها خطأ، والفائض يُرد نقداً حقيقياً.
 * السلوك الصحيح: الإيداع الواحد يسند تحصيلاً واحداً في دفاتر المالك أياً كان هدف كل جهاز: الثاني يُرفض (أو يُلغى أثره) فرصيد البنك
 * في الدفاتر = الكشف، ولا حركة تحصيلٍ «في الدفاتر وحدها».
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { sync, ownerPulls, MEMBER, UID } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync } from '@/sync/engine';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { saveClaim } from '@/domain/claims';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const HEAD = ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'];
function grid(rows: string[][]) {
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], HEAD, ...rows]);
  if (!r.ok) throw new Error(r.error);
  return r;
}
/** جهاز المالك وجهازا عضوين على الحساب نفسه · ما يكتبه العضوان يُعلَّم بكاتبه العضو */
function trio() {
  const r = new MemoryRemote();
  const owner = memDb(); const m1 = memDb(); const m2 = memDb();
  for (const d of [owner, m1, m2]) enableSync(d, UID);
  return { r, owner, m1, m2, close: () => { owner.close(); m1.close(); m2.close(); } };
}
type Trio = ReturnType<typeof trio>;
async function settle(p: Trio) {
  const ids = [getMeta(p.m1, 'device_id'), getMeta(p.m2, 'device_id')];
  for (let i = 0; i < 3; i++) {
    await sync(p.owner, p.r);
    await sync(p.m1, p.r);
    await sync(p.m2, p.r);
    for (const d of [...p.r.docs.values()]) if (ids.includes(d.dev) && d.by !== MEMBER) p.r.inject({ ...d, by: MEMBER });
    await ownerPulls(p.owner, p.r);
  }
}
/** دفاتر المالك أمام الكشف: رصيد البنك، وحركات التحصيل «في الدفاتر وحدها» */
const books = (db: DB, bank: string) => ({
  bank: bankBalance(db, bank),
  onlyInBooks: reconciliation(db, bank, '2026-10').onlyInBooks.map((x) => x.descr),
});

describe('Z2-1 · [عالٍ] الإيداع الواحد يُعتمد على جهازين لهدفين مختلفين فيُسجَّل تحصيلين (collect.ts:227 · W1 للهدف نفسه وحده)', () => {
  test('أ) العضو الأول يعتمده لقسط أكتوبر «جاهزاً»، والثاني (سجّل أكتوبر نقداً) لقسط نوفمبر: دفاتر المالك بتحصيلٍ واحد من الإيداع', async () => {
    const p = trio();
    const bank = addBank(p.owner, 'بنك مصطنع Z2-1', 0);
    const prop = addProperty(p.owner, { name: 'عقار مصطنع Z2-1' });
    const c = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: 'Z21-1' }), {
      tenant: 'ماجد المصطنع', idNumber: '1000002101', phone: '0500002101', valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
    saveStatement(p.owner, bank, grid([['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]), { name: 'z21-oct.csv', hash: 'z21a' });
    await settle(p);

    // العضو الثاني بلا اتصال: المستأجر دفع أكتوبر نقداً في المكتب
    const oct = p.m2.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!.id;
    recordRentPayment(p.m2, c, { installmentId: oct, period: 'أكتوبر', date: '2026-10-01', lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
    const s1 = collectionSuggestions(p.m1, bank);
    const s2 = collectionSuggestions(p.m2, bank);
    // السطر نفسه، والهدف مختلف: أكتوبر «جاهز» على الأول ونوفمبر على الثاني
    expect(s1.length === 1 && s2.length === 1 && s1[0].line.id === s2[0].line.id).toBe(true);
    expect([s1[0].level, s1[0].target.kind === 'installments' && s1[0].target.installmentIds[0] === oct,
      s2[0].target.kind === 'installments' && s2[0].target.installmentIds[0] !== oct]).toEqual(['ready', true, true]);
    approveCollection(p.m1, s1[0].line.id, s1[0].target);
    approveCollection(p.m2, s2[0].line.id, s2[0].target);
    await settle(p);

    const bankPayments = Number(p.owner.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL AND method_label != 'نقداً'`, [c])!.n);
    // في الكشف إيداعٌ واحد بـ1,000
    // (الواقع: دفعتان بنكيتان حيّتان من الإيداع نفسه، والبنك 2,000، وتحصيلٌ «في الدفاتر وحدها»، وقسط أكتوبر مسدَّد مرتين وفائضه للرد)
    expect({ ...books(p.owner, bank), bankPayments }).toEqual({ bank: 100000, onlyInBooks: [], bankPayments: 1 });
    p.close();
  });

  test('ب) مطالبتان متساويتان أُنشئت كلٌّ منهما على جهاز: كلٌّ يعتمد الإيداع لمطالبةٍ غير الأخرى، ودفاتر المالك بتحصيلٍ واحد منه', async () => {
    const p = trio();
    const bank = addBank(p.owner, 'بنك مصطنع Z2-1ب', 0);
    const prop = addProperty(p.owner, { name: 'عقار مصطنع Z2-1ب' });
    const c = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: 'Z21-2' }), {
      tenant: 'ماجد المصطنع', idNumber: '1000002102', phone: '0500002102', valueHalalas: 1800000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
    saveStatement(p.owner, bank, grid([['2026/10/03', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]), { name: 'z21-b.csv', hash: 'z21b' });
    await settle(p);
    // كلٌّ ينشئ مطالبته قبل أن تصله الأخرى
    saveClaim(p.m1, { contractId: c, amountHalalas: 100000, reason: 'صيانة مصطنعة', date: '2026-10-01' });
    saveClaim(p.m2, { contractId: c, amountHalalas: 100000, reason: 'غرامة مصطنعة', date: '2026-10-01' });
    await settle(p);

    // البيانات نفسها على الجهازين، والاقتراح للسطر نفسه بمطالبتين مختلفتين
    const s1 = collectionSuggestions(p.m1, bank);
    const s2 = collectionSuggestions(p.m2, bank);
    expect(s1[0].line.id === s2[0].line.id && s1[0].target.kind === 'claim' && s2[0].target.kind === 'claim').toBe(true);
    expect(JSON.stringify(s1[0].target) === JSON.stringify(s2[0].target)).toBe(false);
    approveCollection(p.m1, s1[0].line.id, s1[0].target);
    approveCollection(p.m2, s2[0].line.id, s2[0].target);
    await settle(p);

    const collected = Number(p.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM claims WHERE status = 'محصَّلة'`)!.n);
    // (الواقع: المطالبتان «محصَّلة» من إيداعٍ واحد، والبنك 2,000، وتحصيلٌ «في الدفاتر وحدها»)
    expect({ ...books(p.owner, bank), collected }).toEqual({ bank: 100000, onlyInBooks: [], collected: 1 });
    p.close();
  });
});
