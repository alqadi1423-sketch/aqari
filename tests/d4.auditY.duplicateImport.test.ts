/**
 * المدقق Y · الجولة الثانية عشرة · بذرة المعرّفات الحتمية لاعتماد التحصيل هي معرّف سطر الكشف، وهو عشوائيٌّ لكل قراءة (store.ts:52
 * uid()) · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditY.duplicateImport.test.ts
 *
 * Y3 · عالٍ · src/domain/bankStatement/collect.ts:219 (البذرة 'stmt:' + lineId) وsrc/domain/bankStatement/store.ts:36–52 (لا منع للتكرار
 * عبر الأجهزة): موظفان يقرآن ملف كشف أكتوبر نفسه (البصمة نفسها) على جهازين قبل أن تصل مزامنة أحدهما الآخر، ويعتمد كلٌّ منهما
 * الاقتراح «الجاهز» نفسه لقسط ماجد · لكل جهازٍ سطرٌ بمعرّفٍ عشوائي للإيداع نفسه، فالبذرتان مختلفتان والمعرّفات كذلك: بعد المزامنة
 * كشفان بالبصمة نفسها وسطران للإيداع الواحد، ودفعتان حيّتان، ورصيد البنك 2,000 والكشف 1,000، و«فائض» 1,000 يُعرض للرد نقداً على
 * المستأجر، وفحوص السلامة كلها خضراء · وهو W1 نفسه بطريقٍ لم يغطّه إصلاحه («جهازان يعتمدان الإيداع نفسه للهدف نفسه يلتقيان»).
 * لماذا يهم: «اعتماد الجاهزة» على جهازين لموظفَين يعالجان الكشف نفسه يضاعف التحصيل بصمت، ورد الفائض يُخرج نقداً حقيقياً.
 * السلوك الصحيح: الإيداع الواحد (البنك وبصمة السطر line_key) تحصيلٌ واحد: البذرة من بصمة السطر لا من معرّفه، أو يلتقي الكشفان
 * والسطران في المزامنة، فلا يبقى في دفاتر المالك إلا تحصيلٌ واحد ولا فائض.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { confirmContract } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';
import { contractSurpluses } from '@/domain/ledgerReview';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';

describe('Y3 · ملف الكشف نفسه يُقرأ على جهازين بلا اتصال ويُعتمد إيداعه على كلٍّ منهما', () => {
  test('بعد المزامنة تحصيلٌ واحد في دفاتر المالك، ورصيد البنك = الكشف، ولا فائض', async () => {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع Y3', 0);
    const prop = addProperty(p.owner, { name: 'عقار مصطنع Y3' });
    const c = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: 'Y3-1' }), {
      tenant: 'ماجد المصطنع', idNumber: '1000000933', phone: '0500000933', valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    const oct = () => {
      const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
        ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
      if (!r.ok) throw new Error(r.error);
      return r;
    };
    // الملف نفسه (البصمة نفسها) على الجهازين، وكلٌّ يعتمد الاقتراح «الجاهز» نفسه
    for (const db of [p.owner, p.dev]) {
      saveStatement(db, bank, oct(), { name: 'oct-2026.csv', hash: 'y3-same-file' });
      const s = collectionSuggestions(db, bank);
      expect([s.length, s[0].level, s[0].target.kind]).toEqual([1, 'ready', 'installments']);
      approveCollection(db, s[0].line.id, s[0].target);
    }

    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    const devId = getMeta(p.dev, 'device_id');
    for (const d of [...p.r.docs.values()]) if (d.dev === devId) p.r.inject({ ...d, by: MEMBER });
    await ownerPulls(p.owner, p.r);
    await sync(p.dev, p.r);
    await ownerPulls(p.owner, p.r);

    // (الواقع: دفعتان حيّتان، ورصيد البنك 2,000، وفائضٌ 1,000 يُعرض للرد، وكشفان بالبصمة نفسها)
    expect({
      livePayments: p.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL`, [c])!.n,
      bank: bankBalance(p.owner, bank),
      surplus: contractSurpluses(p.owner).map((x) => x.amount),
    }).toEqual({ livePayments: 1, bank: 100000, surplus: [] });
    p.close();
  });
});
