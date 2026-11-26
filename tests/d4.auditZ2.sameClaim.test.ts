/**
 * المدقق Z2 · الجولة الثالثة عشرة · على db011e7 · المطالبة الواحدة تُحصَّل على جهازَي عضوين (نقداً، ومن إيداع الكشف) · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditZ2.sameClaim.test.ts
 *
 * Z2-6 · متوسط · src/domain/accounting/deriveSources.ts:1322-1327 (memberSourceIssue: قيدٌ آخر من المصدر نفسه في الوارد ⇒ «ينتظر») مع
 * src/sync/engine.ts:2084-2097 (الانتظار ثلاثون يوماً ثم الرفض): العضو الأول يحصّل مطالبة ماجد نقداً في المكتب، والثاني بلا اتصال يعتمد
 * إيداع الكشف تحصيلاً لها · يصل جهازَ المالك صفّ المطالبة «محصَّلة» (الأحدث) وقيدا تحصيلٍ لها (claim_collect) معاً · كلٌّ منهما ينتظر
 * الآخر لأنه «من المصدر نفسه في الوارد»، فلا يُطبَّق أيٌّ منهما ثلاثين يوماً: المطالبة «محصَّلة» ولا قيد تحصيلٍ لها، و«ذمم المطالبات =
 * المطالبات المفتوحة» أحمر، والبنك صفر وسطر الكشف مفتوح (حركته تنتظر قيدها) · ثم يُرفض أحدهما بطول الانتظار وينجو الآخر بحسب ترتيب
 * المعالجة لا بحسب أيهما يسمّيه صفّ المطالبة · والفاتورة تُحصَّل على جهازين كذلك (invoice_pay) فتنتظر بالطريقة نفسها.
 * لماذا يهم: شهرٌ كامل يعرض فيه جهاز المالك مطالبةً محصَّلة بلا مال وفحص سلامةٍ أحمر، لتحصيلٍ واحدٍ مشروع على الأقل وصل في يومه.
 * السلوك الصحيح: يُطبَّق في المزامنة نفسها التحصيل الذي يسمّيه صفّ المطالبة (بتاريخ collected_at) ويُرفض الآخر، فالفحوص خضراء.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { sync, ownerPulls, MEMBER, UID } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync } from '@/sync/engine';
import { confirmContract } from '@/domain/contracts/service';
import { saveClaim, collectClaim } from '@/domain/claims';
import { integrityChecks } from '@/domain/accounting/integrity';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';

test('Z2-6 · [متوسط] المطالبة نفسها تُحصَّل نقداً على جهاز عضو ومن إيداع الكشف على جهاز عضوٍ آخر: جهاز المالك يطبّق تحصيلاً واحداً في المزامنة نفسها والفحوص خضراء', async () => {
  const r = new MemoryRemote();
  const owner = memDb(); const m1 = memDb(); const m2 = memDb();
  for (const d of [owner, m1, m2]) enableSync(d, UID);
  const ids = [getMeta(m1, 'device_id'), getMeta(m2, 'device_id')];
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await sync(owner, r); await sync(m1, r); await sync(m2, r);
      for (const d of [...r.docs.values()]) if (ids.includes(d.dev) && d.by !== MEMBER) r.inject({ ...d, by: MEMBER });
      await ownerPulls(owner, r);
    }
  };
  const bank = addBank(owner, 'بنك مصطنع Z2-6', 0);
  const prop = addProperty(owner, { name: 'عقار مصطنع Z2-6' });
  const c = confirmContract(owner, contractInput(addUnit(owner, prop, { unit_no: 'Z26-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000002601', phone: '0500002601', valueHalalas: 1800000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const claim = saveClaim(owner, { contractId: c, amountHalalas: 100000, reason: 'صيانة مصطنعة', date: '2026-10-01' });
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/03', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(owner, bank, g, { name: 'z26-oct.csv', hash: 'z26' });
  await settle();

  // بلا اتصال: الأول يحصّلها نقداً، والثاني يعتمد الإيداع لها
  collectClaim(m1, claim, '2026-10-02');
  const s = collectionSuggestions(m2, bank)[0];
  expect(s.target).toEqual({ kind: 'claim', claimId: claim });
  approveCollection(m2, s.line.id, s.target);
  await settle();

  const state = {
    claim: owner.get<{ s: string }>(`SELECT status AS s FROM claims WHERE id = ?`, [claim])!.s,
    collections: Number(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE src_type = 'claim_collect' AND src_id = ? AND status = 'مرحّل'`, [claim])!.n),
    failing: integrityChecks(owner).filter((x) => !x.ok).map((x) => x.name),
  };
  // (الواقع: «محصَّلة» ولا قيد تحصيلٍ لها، وقيدا التحصيل ينتظر كلٌّ منهما الآخر في الوارد، و«ذمم المطالبات» أحمر 1,000 / 0)
  expect(state).toEqual({ claim: 'محصَّلة', collections: 1, failing: [] });
  owner.close(); m1.close(); m2.close();
});
