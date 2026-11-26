/**
 * المدقق B2 · الجولة الرابعة عشرة · على 52f19cb · فضّ التعادل بين قيدين من المصدر نفسه في الوارد (Z2-6) يحبسه قيدٌ مزوَّر · بياناتٌ
 * مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditB2.pendingHold.test.ts
 *
 * B2-6 · متوسط · src/domain/accounting/deriveSources.ts:1328 (r.pending(...).some(id => reversed_by || id < e.id) → انتظار) مع
 * deriveSources.ts:1281-1282 (reversedIssue: عاكسٌ لا وجود له → انتظار) وsrc/sync/engine.ts:1806-1813 (صفّ المطالبة «محصَّلة» ينتظر قيداً
 * في الوارد): عضوٌ أمين يعتمد إيداع ماجد تحصيلاً لمطالبته من الكشف · ومزوِّرٌ يرفع قيد «claim_collect» للمطالبة نفسها يسمّي عاكساً لا
 * وجود له · قيده لا يُطبَّق ولا يُرفض (ينتظر عاكسه ثلاثين يوماً)، وقيد الأمين ينتظره لأن في الوارد قيداً «معكوساً» من مصدره، وصفّ
 * المطالبة «محصَّلة» ينتظر قيده، وحركة البنك وسطر الكشف ينتظران معه · على جهاز المالك المطالبة مفتوحة والبنك صفر والكشف 1,000 شهراً
 * كاملاً، ثم يُرفض الانتظار بترتيبه فيضيع التحصيل الصحيح نهائياً إن جاء دوره أولاً.
 * لماذا يهم: مستندٌ واحد لا يمرّ بأي فحص يجمّد تحصيلات الأعضاء لأي مطالبةٍ أو فاتورة (ويتكرر لكل واحدة)، والمستأجر يُطالَب بما دفع.
 * السلوك الصحيح: قيدٌ في الوارد لا يُطبَّق (عاكسه لا وجود له) لا يحبس قيد غيره: التحصيل الصحيح يُطبَّق في الدورة نفسها، والمطالبة
 * «محصَّلة» والبنك 1,000 ولا شيء ينتظر من مستندات الأمين.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { sync, ownerPulls, MEMBER, UID, forge } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync } from '@/sync/engine';
import { confirmContract } from '@/domain/contracts/service';
import { saveClaim } from '@/domain/claims';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';

test('B2-6 · [متوسط] قيد تحصيلٍ مزوَّر للمطالبة نفسها يسمّي عاكساً وهمياً: تحصيل العضو الصحيح من الكشف يُطبَّق ولا ينتظره', async () => {
  const r = new MemoryRemote();
  const owner = memDb(); const m = memDb();
  for (const d of [owner, m]) enableSync(d, UID);
  const bank = addBank(owner, 'بنك مصطنع B26', 0);
  const prop = addProperty(owner, { name: 'عقار مصطنع B26' });
  const c = confirmContract(owner, contractInput(addUnit(owner, prop, { unit_no: 'B26-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000003601', phone: '0500003601', valueHalalas: 1800000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const claim = saveClaim(owner, { contractId: c, amountHalalas: 100000, reason: 'صيانة مصطنعة', date: '2026-10-01' });
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/03', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(owner, bank, g, { name: 'b26.csv', hash: 'b26' });
  await sync(owner, r); await sync(m, r); await sync(m, r);
  const dev = getMeta(m, 'device_id');

  // العضو الأمين يعتمد الإيداع تحصيلاً للمطالبة ويرفعه
  const s = collectionSuggestions(m, bank)[0];
  expect(s.target).toEqual({ kind: 'claim', claimId: claim });
  approveCollection(m, s.line.id, s.target);
  await sync(m, r);
  for (const d of [...r.docs.values()]) if (d.dev === dev) r.inject({ ...d, by: MEMBER });
  // والمزوِّر: قيد «claim_collect» للمطالبة نفسها بسطور قيد الأمين، يسمّي عاكساً لا وجود له
  const honest = [...r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'claim_collect')!;
  r.inject(forge(honest, { k: 'zz-b26-forged', reversed_by: 'b26-no-such-reversal', lines: honest.lines! }));
  for (let i = 0; i < 3; i++) await ownerPulls(owner, r);

  const view = {
    claim: owner.get<{ status: string }>(`SELECT status FROM claims WHERE id = ?`, [claim])!.status,
    bank: bankBalance(owner, bank),
    honestApplied: !!owner.get(`SELECT 1 FROM journal_entries WHERE id = ? AND status = 'مرحّل'`, [honest.k]),
    honestWaiting: owner.all<{ pk: string }>(`SELECT pk FROM sync_inbox WHERE pk != 'zz-b26-forged' ORDER BY tbl`).map((x) => x.pk).length,
  };
  // (الواقع: قيد الأمين وحركته وصفّ المطالبة وسطر الكشف كلها تنتظر، والمطالبة مفتوحة والبنك صفر)
  expect(view).toEqual({ claim: 'محصَّلة', bank: 100000, honestApplied: true, honestWaiting: 0 });
  owner.close(); m.close();
});
