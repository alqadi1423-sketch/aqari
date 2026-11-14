/**
 * المدقق A2 · الجولة الرابعة عشرة · على 52f19cb · إصلاح Z2-1 (الإيداع الواحد يسند تحصيلاً واحداً) يرفض قيد تحصيل الفاتورة ويطبّق صفّها ·
 * بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditA2.invoiceRow.test.ts
 *
 * A2-1 · عالٍ · src/sync/engine.ts:1820-1826 (قيدٌ حيٌّ ثانٍ من عضوٍ لسطر الكشف نفسه يُرفض) مع engine.ts:1809-1819 (حارسٌ لصفّ المطالبة
 * «محصَّلة» بلا قيدها وحده) وengine.ts:1986-2008 (صفّ الفاتورة يُطبَّق كما هو): المالك يسجّل بلا اتصال مطالبة صيانةٍ على ماجد بـ575 ويعتمد
 * حوالة ماجد (575) تحصيلاً لها، والعضو الذي لا يعرف المطالبة يعتمد الحوالة نفسها تحصيلاً للفاتورة المستحقة الوحيدة بـ575 · جهاز المالك
 * يرفض قيد العضو (invoice_pay) وحركة بنكه كما أراد Z2-1، لكن صفّ الفاتورة الوارد «مدفوعة» يسمّي القيد المرفوض فيُطبَّق: الفاتورة على جهاز
 * المالك «مدفوعة» ولا قيد تحصيلٍ لها في دفاتره، والذمة 575 قائمة في 1200، و«ذمم الفواتير = الفواتير المصدرة غير المحصّلة» أحمر · وجهاز
 * المالك لا يرفع نسخته فتبقى «مدفوعة» في السحابة وعلى أجهزة الأعضاء (للمطالبة وحدها يُرفع صفّ المالك).
 * لماذا يهم: العميل لا يُطالَب بفاتورةٍ لم يسدّدها، وشاشة الفواتير تخفي ذمةً قائمة في الدفتر، وفحص السلامة أحمر بعد اعتمادين مشروعين.
 * السلوك الصحيح: صفّ الفاتورة الذي يسمّي تحصيلاً رُفض لا يُطبَّق (كصفّ المطالبة): تبقى «مستحقة» بلا قيد تحصيل على جهاز المالك، والفحوص خضراء.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { confirmContract } from '@/domain/contracts/service';
import { saveClaim } from '@/domain/claims';
import { saveInvoice } from '@/domain/invoices';
import { integrityChecks } from '@/domain/accounting/integrity';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';
import type { MemoryRemote } from './helpers/memoryRemote';
import type { DB } from '@/db/adapter';

/** جولات مزامنة حتى يستقر الجهازان · وما كتبه الجهاز الثاني بكاتبه العضو */
async function settle(p: { owner: DB; dev: DB; r: MemoryRemote }) {
  const devId = getMeta(p.dev, 'device_id');
  for (let i = 0; i < 3; i++) {
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    for (const d of [...p.r.docs.values()]) if (d.dev === devId && d.by !== MEMBER) p.r.docs.set(d.id, { ...d, by: MEMBER });
    await ownerPulls(p.owner, p.r);
  }
}

test('A2-1 · [عالٍ] المالك يعتمد الحوالة لمطالبة والعضو للفاتورة: على جهاز المالك تبقى الفاتورة «مستحقة» بلا تحصيل والفحوص خضراء', async () => {
  const p = await pair();
  const bank = addBank(p.owner, 'بنك مصطنع A2-1', 0);
  const prop = addProperty(p.owner, { name: 'عقار مصطنع A2-1' });
  const c = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: 'A21-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000002111', phone: '0500002111', valueHalalas: 1800000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const inv = saveInvoice(p.owner, { customer: 'شركة نجم المصطنعة', customerVat: '', issue: '2026-10-01', due: '2026-10-15', notes: '',
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 50000, taxPct: 15 }] }, 'مستحقة');
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/03', 'حوالة واردة ماجد', '', '575.00', '575.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(p.owner, bank, g, { name: 'a21-oct.csv', hash: 'a21' });
  await settle(p);

  // المالك بلا اتصال: مطالبة صيانةٍ على ماجد بـ575، واقتراحه للحوالة المطالبة (باسم ماجد)
  const claim = saveClaim(p.owner, { contractId: c, amountHalalas: 57500, reason: 'صيانة مصطنعة', date: '2026-10-01' });
  const so = collectionSuggestions(p.owner, bank)[0];
  expect(so.target).toEqual({ kind: 'claim', claimId: claim });
  approveCollection(p.owner, so.line.id, so.target);
  // والعضو لا يعرف المطالبة: اقتراحه للحوالة نفسها الفاتورة المستحقة الوحيدة بمبلغها
  const sd = collectionSuggestions(p.dev, bank)[0];
  expect([sd.line.id, sd.target]).toEqual([so.line.id, { kind: 'invoice', invoiceId: inv }]);
  approveCollection(p.dev, sd.line.id, sd.target);
  await settle(p);

  const v = p.owner.get<{ status: string; pj: string | null }>(`SELECT status, payment_journal_entry_id AS pj FROM invoices WHERE id = ?`, [inv])!;
  const state = {
    claim: p.owner.get<{ s: string }>(`SELECT status AS s FROM claims WHERE id = ?`, [claim])!.s,
    invoice: v.status,
    payEntryInBooks: !!(v.pj && p.owner.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [v.pj])),
    failing: integrityChecks(p.owner).filter((x) => !x.ok).map((x) => x.name),
  };
  // (الواقع: الفاتورة «مدفوعة» تسمّي قيد العضو المرفوض ولا قيد لها في الدفاتر، و«ذمم الفواتير = الفواتير المصدرة غير المحصّلة» أحمر)
  expect(state).toEqual({ claim: 'محصَّلة', invoice: 'مستحقة', payEntryInBooks: false, failing: [] });
  p.close();
});
