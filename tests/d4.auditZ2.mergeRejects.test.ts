/**
 * المدقق Z2 · الجولة الثالثة عشرة · على db011e7 · إصلاح Y5 لا يشمل قيد الاعتماد الذي عُكس في السحابة قبل أن يرفعه الجهاز الثاني ·
 * بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditZ2.mergeRejects.test.ts
 *
 * Z2-8 · منخفض · src/sync/engine.ts:1743-1763 (التعارض على القيد المرحّل: نسخة الجهاز الأحدث «تغلب» فتُرفع) مع engine.ts:2510-2515
 * (finalDenied ⇒ «نهائي في السحابة · نسخة هذا الجهاز تختلف عنها ولم تُرفع») وengine.ts:361-364 (sameContent: يتجاهل وقت الإنشاء وحده،
 * والرقم مسمّى بـ cloudJournalNo): المالك يعتمد الإيداع ثم يلغي الدفعة (يُعكس قيدها في السحابة: reversed_by)، والعضو بلا اتصال يعتمد
 * الاقتراح نفسه بعده بالمعرّفات نفسها · حارس Y1 يُبقي الإلغاء والدفاتر سليمة، لكن قيد العضو يختلف عن نسخة السحابة بـ reversed_by وحده
 * (ثم يأخذه حين يصله العاكس) فيغلب لأنه أحدث، فيُرفع ويُرفض، ويبقى على جهاز العضو «مرفوض» دائمٌ لتحصيلٍ التقى سليماً · والفاتورة كذلك.
 * لماذا يهم: ما أصلحه Y5: إنذاراتٌ كاذبة في عدّاد «المرفوض» تُغرق الحقيقية التي وُضع لها.
 * السلوك الصحيح: نسخةٌ لا تختلف عن السحابة إلا بربط العاكس الذي في السحابة (ورقمٍ مسمّى ووقت إنشاء) تُعدّ متفقة: لا تُرفع ولا تُسجَّل مرفوضة.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { confirmContract } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { syncStatus } from '@/sync/engine';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Z2-8 · [منخفض] الاعتماد على جهاز العضو بعد إلغاء المالك الدفعة نفسها: الدفاتر سليمة ولا «مرفوض» على أيٍّ من الجهازين', async () => {
  const p = await pair();
  const bank = addBank(p.owner, 'بنك مصطنع Z2-8', 0);
  const prop = addProperty(p.owner, { name: 'عقار مصطنع Z2-8' });
  const c = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: 'Z28-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000002801', phone: '0500002801', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(p.owner, bank, g, { name: 'z28-oct.csv', hash: 'z28' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);

  const so = collectionSuggestions(p.owner, bank)[0];
  approveCollection(p.owner, so.line.id, so.target);
  const pay = p.owner.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [c])!.id;
  cancelPayment(p.owner, pay, { date: '2026-10-02', reason: 'الإيداع ليس للمستأجر' });
  await sync(p.owner, p.r);
  await wait(5);
  const sd = collectionSuggestions(p.dev, bank)[0];
  approveCollection(p.dev, sd.line.id, sd.target);

  const devId = getMeta(p.dev, 'device_id');
  for (let i = 0; i < 2; i++) {
    await sync(p.dev, p.r);
    for (const d of [...p.r.docs.values()]) if (d.dev === devId && d.by !== MEMBER) p.r.inject({ ...d, by: MEMBER });
    await ownerPulls(p.owner, p.r);
  }
  await sync(p.dev, p.r);

  // الدفاتر سليمة على الجهازين (حارس Y1)
  const live = (db: typeof p.owner) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE cancelled_at IS NULL`)!.n);
  expect([live(p.owner), live(p.dev), bankBalance(p.owner, bank), bankBalance(p.dev, bank)]).toEqual([0, 0, 0, 0]);
  // (الواقع: على جهاز العضو قيد التحصيل «نهائي في السحابة · نسخة هذا الجهاز تختلف عنها ولم تُرفع»)
  expect({ owner: syncStatus(p.owner).rejected, dev: syncStatus(p.dev).rejected }).toEqual({ owner: 0, dev: 0 });
  p.close();
});
