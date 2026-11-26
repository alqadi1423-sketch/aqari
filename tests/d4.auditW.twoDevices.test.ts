/**
 * المدقق W · الجولة الحادية عشرة · الإيداع الواحد يُعتمد تحصيلاً على جهازين بلا اتصال · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditW.twoDevices.test.ts
 *
 * W1 · عالٍ · src/domain/bankStatement/collect.ts:162 (approveCollection) وsrc/sync/engine.ts:923 (statementLineCheck): سطر الكشف نفسه
 * (المعرّف نفسه، الإيداع نفسه في البنك) يعتمده جهاز المالك وجهاز العضو كلٌّ لقسطه بلا اتصال · فيُنشئ كل جهازٍ دفعةً وقيداً وحركة بنك ·
 * وبعد المزامنة يأخذ السطر إحدى الحركتين (الأحدث يغلب في الصف)، وتبقى الدفعة الأخرى وحركتها حيّتين ويقبلهما جهاز المالك بلا رفض:
 * رصيد البنك في الدفاتر ضعف ما في الكشف، والإيراد ضعف القسط، وفحوص السلامة كلها خضراء، و«الفائض» يُعرض للرد على المستأجر نقداً
 * (contractSurpluses) عن مالٍ لم يدفعه إلا مرة · وحارس U٢٣ يمنع سطرين على حركةٍ واحدة لا حركتين لسطرٍ واحد.
 * لماذا يهم: «اعتماد الجاهزة» على جهازين لموظفَين يعالجان الكشف نفسه يضاعف التحصيل بصمت، ورد الفائض يُخرج نقداً حقيقياً.
 * السلوك الصحيح: الإيداع الواحد يسند تحصيلاً واحداً: الاعتماد الثاني للسطر نفسه يُرفض على جهاز المالك (أو يُلغى أثره) فلا يبقى في
 * دفاتره إلا تحصيلٌ واحد بمبلغ الإيداع ولا فائض.
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

describe('W1 · الإيداع الواحد يُعتمد على جهازين بلا اتصال', () => {
  test('جهاز المالك وجهاز العضو يعتمدان السطر نفسه للقسط نفسه: بعد المزامنة تحصيلٌ واحد في دفاتر المالك، ورصيد البنك = الكشف، ولا فائض', async () => {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع W1', 0);
    const prop = addProperty(p.owner, { name: 'عقار مصطنع W1' });
    const c = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: 'W1-1' }), {
      tenant: 'ماجد المصطنع', idNumber: '1000000911', phone: '0500000911', valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
    const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
    if (!r.ok) throw new Error(r.error);
    saveStatement(p.owner, bank, r, { name: 'w1-oct.csv', hash: 'w1' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);

    // كلا الجهازين يرى الاقتراح نفسه «جاهزاً» ويعتمده بلا اتصال
    const so = collectionSuggestions(p.owner, bank);
    const sd = collectionSuggestions(p.dev, bank);
    expect([so.length, sd.length, so[0].line.id === sd[0].line.id, so[0].level]).toEqual([1, 1, true, 'ready']);
    approveCollection(p.owner, so[0].line.id, so[0].target);
    approveCollection(p.dev, sd[0].line.id, sd[0].target);

    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    // ما كتبه الجهاز الثاني بكاتبه العضو
    const devId = getMeta(p.dev, 'device_id');
    for (const d of [...p.r.docs.values()]) if (d.dev === devId) p.r.inject({ ...d, by: MEMBER });
    await ownerPulls(p.owner, p.r);
    await sync(p.dev, p.r);
    await ownerPulls(p.owner, p.r);

    // في الكشف إيداعٌ واحد بـ1,000 · ودفاتر المالك تحمل تحصيلين وحركتين
    // (الواقع: دفعتان حيّتان، ورصيد البنك 2,000، وفائضٌ 1,000 يُعرض للرد، وفحوص السلامة خضراء)
    expect({
      line: p.owner.get<{ s: string }>(`SELECT status AS s FROM bank_statement_lines`)!.s,
      livePayments: p.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL`, [c])!.n,
      bank: bankBalance(p.owner, bank),
      surplus: contractSurpluses(p.owner).map((x) => x.amount),
    }).toEqual({ line: 'matched', livePayments: 1, bank: 100000, surplus: [] });
    p.close();
  });
});
