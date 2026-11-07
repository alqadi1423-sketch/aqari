/**
 * المدقق الخارجي X · الجولة الثانية عشرة · المعرّفات الحتمية لاعتماد التحصيل (إصلاح W١ · collect.ts approveCollection) · يسقط على الشيفرة
 * الحالية (7ef3f8e) ويصف السلوك الصحيح · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditX.collectIds.test.ts
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { confirmContract } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { integrityChecks } from '@/domain/accounting/integrity';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';

describe('X3 · [عالٍ] رقم الاعتماد محلي: اعتماد الإيداع نفسه للقسط نفسه على جهازٍ لم يصله تحصيلٌ سابقٌ أُلغي يكتب معرّفات ذلك التحصيل فيُحيي دفعته الملغاة وقيدها معكوس (collect.ts:219-222)', () => {
  // approveCollection يبني المعرّفات من «السطر + الهدف + رقم الاعتماد»، ورقم الاعتماد يزيد إن وُجد قيد الرقم السابق على هذا الجهاز وحده ·
  // جهاز المالك يعتمد الإيداع (الرقم ٠) ويرفعه ثم يلغي الدفعة (قيدٌ عاكس، وحركة بنكٍ سالبة، والدفعة «ملغاة») ويرفع ذلك · وجهاز العضو بلا
  // اتصال منذ قبل الاعتماد لا يعرف قيد الرقم ٠، فيعتمد الإيداع نفسه للقسط نفسه بالرقم ٠: الدفعة والقيد وحركة البنك بمعرّفات المالك نفسها ·
  // القيد المرحّل في السحابة نهائيٌّ فيُرفض قيد العضو، أما صفّ الدفعة فالأحدث يغلب، وحارس collectionRowCheck يفحص الإلغاء لا إعادة الدفعة
  // حيّة · فيقبل جهاز المالك الدفعة حيّةً (cancelled_at فارغ) وقيدها معكوس: القسط «مدفوعة» بلا نقدٍ في البنك ولا إيراد، وفحص السلامة
  // «كل دفعة محصَّلة لها قيد مرحّل» أحمر على الجهازين · وقبل 7ef3f8e كان اعتماد العضو تحصيلاً مستقلاً بقيده (والملغاة تبقى ملغاة)
  test('المالك يعتمد ثم يلغي، والعضو بلا اتصال يعتمد الإيداع نفسه: لا دفعة حيّة بقيدٍ معكوس، وفحوص السلامة سليمة على جهاز المالك', async () => {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع للمدقق X', 0);
    const prop = addProperty(p.owner, { name: 'عقار مصطنع للمدقق X' });
    const c = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: 'X3-1' }), {
      tenant: 'ماجد المصطنع', idNumber: '1000000931', phone: '0500000931', valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
    const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
    if (!r.ok) throw new Error(r.error);
    saveStatement(p.owner, bank, r, { name: 'x3-oct.csv', hash: 'x3' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);

    // جهاز المالك: يعتمد (الرقم ٠) ويرفع، ثم يلغي الدفعة ويرفع
    const so = collectionSuggestions(p.owner, bank);
    approveCollection(p.owner, so[0].line.id, so[0].target);
    await sync(p.owner, p.r);
    const pay = p.owner.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [c])!.id;
    cancelPayment(p.owner, pay, { reason: 'إيداعٌ لغيره (مصطنع)', date: '2026-10-03' });
    await sync(p.owner, p.r);

    // جهاز العضو بلا اتصال منذ قبل الاعتماد: يرى الاقتراح نفسه ويعتمده
    const sd = collectionSuggestions(p.dev, bank);
    expect(sd.map((s) => s.line.id)).toEqual([so[0].line.id]);
    await new Promise((res) => setTimeout(res, 5));
    approveCollection(p.dev, sd[0].line.id, sd[0].target);
    // (المعرّف نفسه: هذا مصدر الخلل)
    expect(p.dev.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [c])!.id).toBe(pay);

    const devId = getMeta(p.dev, 'device_id');
    const asMember = () => { for (const d of [...p.r.docs.values()]) if (d.dev === devId) p.r.inject({ ...d, by: MEMBER }); };
    await sync(p.dev, p.r);
    asMember();
    await ownerPulls(p.owner, p.r);
    await sync(p.dev, p.r);
    asMember();
    await ownerPulls(p.owner, p.r);

    // الواقع: دفعةٌ حيّة قيدها معكوس، والقسط «مدفوعة» 1,000، ورصيد البنك صفر، و«كل دفعة محصَّلة لها قيد مرحّل» ساقط
    // الصحيح: اعتماد العضو لا يلتقي بتحصيلٍ أُلغي (إما يبقى الإلغاء وإما يكون تحصيلاً بقيدٍ حيّ) · والدفاتر متسقة
    const orphanPaid = Number(p.owner.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
       WHERE p.cancelled_at IS NULL AND e.reversed_by IS NOT NULL`)!.n);
    const failed = integrityChecks(p.owner).filter((x) => !x.ok).map((x) => x.name);
    expect({ orphanPaid, failed }).toEqual({ orphanPaid: 0, failed: [] });
    p.close();
  });
});
