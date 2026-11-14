/**
 * المدقق Z2 · الجولة الثالثة عشرة · على db011e7 · التحصيل من الكشف يمحوه تعديلٌ متزامن للمستند على جهاز عضو · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditZ2.collectedFinal.test.ts
 *
 * حارس db011e7 (engine.ts:1715-1723 · Y1 وY2) يمنع اتجاهاً واحداً: نسخةٌ تُحيي دفعةً ملغاة، أو تجعل الفاتورة «مدفوعة» بقيدٍ معكوس ·
 * ولا يمنع الاتجاه الآخر: نسخةٌ كُتبت على جهازٍ لم يصله التحصيل بعد (المستند عنده مفتوح) تغلب صفّ المستند المحصَّل لأنها الأحدث،
 * فيبقى قيد التحصيل وحركة بنكه حيّين والمستند يقول «لم يُحصَّل» · وصفّ المطالبة لا حارس له أصلاً.
 *
 * Z2-3 · عالٍ · src/sync/engine.ts:1715-1723 (لا شيء للمطالبات) · src/domain/claims.ts:84-95 (collectClaim) و97-111 (deleteClaim) و37-57
 * (saveClaim): المالك يعتمد إيداعاً تحصيلاً لمطالبة (قيد 1100/1250 وحركة بنك، والمطالبة «محصَّلة») · والعضو بلا اتصال، والمطالبة عنده
 * مفتوحة، يحذفها أو يعدّل مبلغها (يعكس قيدها ويرحّل غيره) · صفّ العضو الأحدث يغلب على الجهازين: المطالبة «مفتوحة» محذوفةً أو بمبلغٍ
 * جديد، وتحصيلها حيٌّ في الدفتر والبنك · «ذمم المطالبات = المطالبات المفتوحة» أحمر (−1,000 / 0، أو 200 / 1,200).
 * لماذا يهم: المطالبة المحصَّلة لا تُحذف ولا يُعدَّل مبلغها (claims.ts نفسه يمنعهما) · والمستأجر يُطالَب ثانيةً بـ1,200 دفع منها 1,000، أو
 * يضيع أثر تحصيلٍ حقيقي من شاشة المطالبات.
 * السلوك الصحيح: التحصيل نهائي كالإلغاء: المطالبة على جهاز المالك «محصَّلة» بمبلغها، والفحوص خضراء.
 *
 * Z2-4 · عالٍ · src/sync/engine.ts:1720-1721 (حارس الفاتورة باتجاهٍ واحد) · src/domain/invoices.ts:278-316 (setInvoiceStatus): المالك
 * يعتمد إيداعاً تحصيلاً لفاتورة («مدفوعة» بقيد تحصيلها) · والعضو بلا اتصال، والفاتورة عنده مستحقة، يجعلها «متأخرة» · صفّه الأحدث يغلب:
 * الفاتورة «متأخرة» بلا قيد تحصيل، وقيد تحصيلها وحركة بنكه حيّان · «ذمم الفواتير = الفواتير المصدرة غير المحصّلة» أحمر (0 / 575) ·
 * وتحصيلها ثانيةً (payInvoice أو إيداعٌ آخر) لا يعكس الأول لأن الصف لا يسمّيه، فيُحصَّل مرتين.
 * لماذا يهم: العميل يُطالَب بفاتورةٍ سدّدها، والتقارير تعرضها متأخرة والمال في البنك.
 * السلوك الصحيح: الفاتورة على جهاز المالك «مدفوعة» بقيد تحصيلها الحيّ، والفحوص خضراء.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { confirmContract } from '@/domain/contracts/service';
import { saveClaim, deleteClaim } from '@/domain/claims';
import { saveInvoice, setInvoiceStatus } from '@/domain/invoices';
import { integrityChecks } from '@/domain/accounting/integrity';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';
import type { MemoryRemote } from './helpers/memoryRemote';
import type { DB } from '@/db/adapter';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HEAD = ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'];
function grid(rows: string[][]) {
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], HEAD, ...rows]);
  if (!r.ok) throw new Error(r.error);
  return r;
}
/** ما كتبه الجهاز الثاني بكاتبه العضو، ثم جولات مزامنة حتى يستقر الجهازان */
async function settle(p: { owner: DB; dev: DB; r: MemoryRemote }) {
  const devId = getMeta(p.dev, 'device_id');
  for (let i = 0; i < 2; i++) {
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    for (const d of [...p.r.docs.values()]) if (d.dev === devId && d.by !== MEMBER) p.r.inject({ ...d, by: MEMBER });
    await ownerPulls(p.owner, p.r);
  }
}
const failing = (db: DB) => integrityChecks(db).filter((x) => !x.ok).map((x) => x.name);

describe('Z2-3 · [عالٍ] مطالبةٌ حُصّلت من الكشف يمحو تحصيلَها حذفُها أو تعديلُها على جهاز عضوٍ لم يصله التحصيل (engine.ts:1715 · لا حارس للمطالبات)', () => {
  async function collected(tag: string) {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع ' + tag, 0);
    const prop = addProperty(p.owner, { name: 'عقار مصطنع ' + tag });
    const c = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: tag + '-1' }), {
      tenant: 'ماجد المصطنع', idNumber: '1000002301', phone: '0500002301', valueHalalas: 1800000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
    const claim = saveClaim(p.owner, { contractId: c, amountHalalas: 100000, reason: 'صيانة مصطنعة', date: '2026-10-01' });
    saveStatement(p.owner, bank, grid([['2026/10/03', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]), { name: tag + '.csv', hash: tag });
    await settle(p);
    // المالك يعتمد الإيداع تحصيلاً للمطالبة · والعضو بلا اتصال لا يعرف
    const s = collectionSuggestions(p.owner, bank)[0];
    expect(s.target).toEqual({ kind: 'claim', claimId: claim });
    approveCollection(p.owner, s.line.id, s.target);
    await wait(5);
    return { p, c, claim };
  }
  const claimState = (db: DB, id: string) => db.get<{ amount: number; status: string; deleted: number }>(
    `SELECT amount_halalas AS amount, status, deleted_at IS NOT NULL AS deleted FROM claims WHERE id = ?`, [id])!;

  test('العضو يحذف المطالبة (مفتوحةً عنده): على جهاز المالك تبقى «محصَّلة» والفحوص خضراء', async () => {
    const { p, claim } = await collected('Z23a');
    deleteClaim(p.dev, claim);
    await settle(p);
    // (الواقع: المطالبة «مفتوحة» ومحذوفة وتحصيلها حيّ، و«ذمم المطالبات = المطالبات المفتوحة» أحمر −1,000 / 0)
    expect({ claim: claimState(p.owner, claim), failing: failing(p.owner) })
      .toEqual({ claim: { amount: 100000, status: 'محصَّلة', deleted: 0 }, failing: [] });
    p.close();
  });

  test('العضو يعدّل مبلغ المطالبة إلى 1,200 (مفتوحةً عنده): على جهاز المالك تبقى «محصَّلة» بـ1,000 والفحوص خضراء', async () => {
    const { p, c, claim } = await collected('Z23b');
    saveClaim(p.dev, { contractId: c, amountHalalas: 120000, reason: 'صيانة مصطنعة', date: '2026-10-01' }, claim);
    await settle(p);
    // (الواقع: المطالبة «مفتوحة» بـ1,200 وتحصيل 1,000 حيّ، فيُطالَب المستأجر بها كاملة، و«ذمم المطالبات» أحمر 200 / 1,200)
    expect({ claim: claimState(p.owner, claim), failing: failing(p.owner) })
      .toEqual({ claim: { amount: 100000, status: 'محصَّلة', deleted: 0 }, failing: [] });
    p.close();
  });
});

describe('Z2-4 · [عالٍ] فاتورةٌ حُصّلت من الكشف تعود «متأخرة» بلا تحصيل حين يغيّر عضوٌ لم يصله التحصيل حالتها (engine.ts:1720 · الحارس باتجاهٍ واحد)', () => {
  test('العضو يجعل الفاتورة «متأخرة» (مستحقةً عنده): على جهاز المالك تبقى «مدفوعة» بقيد تحصيلها والفحوص خضراء', async () => {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع Z2-4', 0);
    const inv = saveInvoice(p.owner, { customer: 'نجم المصطنع', customerVat: '', issue: '2026-10-01', due: '2026-10-15', notes: '',
      lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 50000, taxPct: 15 }] }, 'مستحقة');
    const invNo = p.owner.get<{ no: string }>(`SELECT no FROM invoices WHERE id = ?`, [inv])!.no;
    saveStatement(p.owner, bank, grid([['2026/10/12', 'سداد فاتورة ' + invNo, '', '575.00', '575.00']]), { name: 'z24.csv', hash: 'z24' });
    await settle(p);
    const s = collectionSuggestions(p.owner, bank)[0];
    expect(s.target).toEqual({ kind: 'invoice', invoiceId: inv });
    approveCollection(p.owner, s.line.id, s.target);
    const pj = p.owner.get<{ pj: string }>(`SELECT payment_journal_entry_id AS pj FROM invoices WHERE id = ?`, [inv])!.pj;
    await wait(5);
    // العضو بلا اتصال، والفاتورة عنده مستحقة تجاوزت استحقاقها
    setInvoiceStatus(p.dev, inv, 'متأخرة');
    await settle(p);

    const v = p.owner.get<{ status: string; pj: string | null }>(`SELECT status, payment_journal_entry_id AS pj FROM invoices WHERE id = ?`, [inv])!;
    // (الواقع: «متأخرة» بلا قيد تحصيل وقيد التحصيل وحركة بنكه حيّان، و«ذمم الفواتير = الفواتير المصدرة غير المحصّلة» أحمر 0 / 575)
    expect({ ...v, failing: failing(p.owner) }).toEqual({ status: 'مدفوعة', pj, failing: [] });
    p.close();
  });
});
