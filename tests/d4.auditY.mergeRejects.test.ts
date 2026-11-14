/**
 * المدقق Y · الجولة الثانية عشرة · التحصيل الذي «يلتقي» على جهازين (W1) يترك على أحدهما وارداً مرفوضاً دائماً · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditY.mergeRejects.test.ts
 *
 * Y5 · منخفض · src/sync/engine.ts:2441 (finalDenied) مع src/sync/engine.ts:209 (buildDoc يرفع القيد برقمه المحلي): جهازان يعتمدان
 * الإيداع نفسه للهدف نفسه فيكتبان القيد نفسه بمعرّفه الحتمي، ورقمه على كلٍّ من تسلسل جهازه (JE-1001 وJE-1501) · الثاني رفعاً يغلب
 * تعديلُه المعلَّق الواردَ (أحدث) فيرفع قيده، فترفضه السحابة (القيد المرحّل لا يُستبدل) ويُسجَّل «نهائي في السحابة · نسخة هذا الجهاز
 * تختلف عنها ولم تُرفع» (وعلى جهاز العضو «خارج صلاحيتك») · والفرق رقم القيد ووقت إنشائه وحدهما، والرقم مسمّىً أصلاً
 * (noteJournalNoAlias) · وكل عكسٍ لاحق للقيد على ذلك الجهاز يضيف رفضاً آخر.
 * لماذا يهم: «اعتماد الجاهزة» لكشف شهرٍ على جهازين يملأ عدّاد «المرفوض» بعشرات الإنذارات الكاذبة لتحصيلٍ سليم، فتضيع بينها الإنذارات
 * الحقيقية التي وُضع هذا السجل لها (المراجعة الخارجية ٧ · النتيجة ٢١).
 * السلوك الصحيح: نسخةٌ لا تختلف عن السحابة إلا برقمٍ مسمّىً ووقت إنشاء تُعدّ متفقة: لا تُرفع ولا تُسجَّل مرفوضة.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { confirmContract } from '@/domain/contracts/service';
import { syncStatus } from '@/sync/engine';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';

describe('Y5 · تحصيلٌ التقى على جهازين بلا اتصال', () => {
  test('بعد المزامنة تحصيلٌ واحد ولا مرفوض على أيٍّ من الجهازين', async () => {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع Y5', 0);
    const prop = addProperty(p.owner, { name: 'عقار مصطنع Y5' });
    const c = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: 'Y5-1' }), {
      tenant: 'ماجد المصطنع', idNumber: '1000000955', phone: '0500000955', valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
    const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
    if (!r.ok) throw new Error(r.error);
    saveStatement(p.owner, bank, r, { name: 'y5-oct.csv', hash: 'y5' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    for (const db of [p.owner, p.dev]) { const s = collectionSuggestions(db, bank)[0]; approveCollection(db, s.line.id, s.target); }

    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    const devId = getMeta(p.dev, 'device_id');
    for (const d of [...p.r.docs.values()]) if (d.dev === devId) p.r.inject({ ...d, by: MEMBER });
    await ownerPulls(p.owner, p.r);
    await sync(p.dev, p.r);
    await ownerPulls(p.owner, p.r);

    // التحصيل التقى فعلاً (W1 سليم)
    expect([
      p.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL`, [c])!.n,
      bankBalance(p.owner, bank), bankBalance(p.dev, bank),
    ]).toEqual([1, 100000, 100000]);
    // (الواقع: على الجهاز الثاني قيد التحصيل «نهائي في السحابة · نسخة هذا الجهاز تختلف عنها ولم تُرفع»)
    expect({ owner: syncStatus(p.owner).rejected, dev: syncStatus(p.dev).rejected }).toEqual({ owner: 0, dev: 0 });
    p.close();
  });
});
