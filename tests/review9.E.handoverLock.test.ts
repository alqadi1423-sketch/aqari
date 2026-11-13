/**
 * E-1 · عالٍ · src/domain/handover/service.ts:117-125 (updateHandover يفحص القفل على الجهاز وحده) و:128-134 (lockHandover)
 *        مع src/sync/engine.ts (حسم التعارض على مستوى الصف كله، بلا حارسٍ لجدول handovers)
 *
 * السيناريو (بيانات مصطنعة كلها): جهازان على الحساب نفسه (جوال المالك وجهاز المكتب، أو جهاز موظف الاستلام بصلاحية «كامل»).
 *   ١. الجهاز (أ) يعبّئ نموذج الاستلام: «المكيف · سليم»، ثم يُقفله ويزامن.
 *   ٢. الجهاز (ب) بلا اتصال، ولم يسحب القفل بعد، فيعدّل نسخته غير المقفلة: «المكيف · تالف»، ثم يزامن.
 *   الواقع: على الجهازين النموذج صار locked = 0 ومحتواه «تالف» · القفل ضاع والمحضر المقفَل تغيّر بصمت.
 *
 * لماذا يهم: محضر الاستلام دليلٌ بين المؤجر والمستأجر، وعليه تُبنى خصومات التأمين. وقرار المالك صريح:
 *   «لا يتم تعديل نموذج الاستلام والتسليم بعد اقفاله» (2026-08-18) و«والمُقفَل لا يُعدَّل» (2026-08-19).
 *   والعمل الميداني بلا اتصال (قبو العمارة، موقع بلا شبكة) هو الحال الطبيعي لمندوب الاستلام.
 *
 * السلوك الصحيح: القفل باتجاهٍ واحد. نسخةٌ غير مقفلة تصل بعد القفل لا تفتحه ولا تغيّر بنوده: يبقى locked = 1
 *   والبند «سليم» على الجهازين، ويُرفض التعديل الوارد (أو يُحفظ مسودةً تصحيحية منفصلة) لا أن يغلب المقفَل.
 *
 *   TZ=Asia/Riyadh npx jest tests/review9.E.handoverLock
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce } from '@/sync/engine';
import { confirmContract } from '@/domain/contracts/service';
import { getMeta } from '@/repos/settings';
import { getContractHandover, updateHandover, lockHandover, type HandoverUpdate } from '@/domain/handover/service';
import type { HandoverSection } from '@/domain/handover/build';

type DBT = ReturnType<typeof memDb>;

describe('E-1 · [عالٍ] نموذج الاستلام المقفَل يُفتح ويتغيّر بتعديلٍ متأخر من جهازٍ آخر', () => {
  test.failing('القفل يبقى والبند المقفَل لا يتغيّر بعد مزامنة تعديلٍ من نسخةٍ قديمة', async () => {
    const r = new MemoryRemote();
    const a = memDb();
    const b = memDb();
    const sync = (db: DBT) => syncOnce(db, r, getMeta(db, 'device_id')!);
    enableSync(a, 'u-review9-e1');
    enableSync(b, 'u-review9-e1');
    // قالبٌ يبني منه النموذج (لا قالب يُزرع) · أسماء مصطنعة
    a.run(`INSERT INTO form_templates (id, name, sections_json, created_at) VALUES ('T-E1', 'قالب مصطنع', ?, ?)`,
      [JSON.stringify([{ section: 'الصالة', items: ['مكيف', 'إنارة'] }]), new Date().toISOString()]);
    const cid = confirmContract(a, contractInput(addUnit(a, addProperty(a)), { tenant: 'مستأجر مصطنع للنموذج' }));
    const h = getContractHandover(a, cid)!;
    expect(h).toBeTruthy();
    await sync(a);
    await sync(b);
    const hb = getContractHandover(b, cid)!;
    expect(hb.id).toBe(h.id);

    const filled = (cond: string, json: string): HandoverSection[] => {
      const s = JSON.parse(json) as HandoverSection[];
      s[0].items[0].receiveCondition = cond;
      return s;
    };
    const base: HandoverUpdate = {
      employeeName: 'موظف مصطنع', tenantName: 'مستأجر مصطنع للنموذج', idNumber: '', phone: '', address: '', unitFloor: '',
      contractPeriod: '', date: '2026-01-01', otherNotes: '', tenantSign: 'مستأجر', companySign: 'المكتب', sections: [],
    };

    // ١. (أ) يعبّئ «سليم» ويُقفل ويزامن
    updateHandover(a, h.id, { ...base, sections: filled('سليم', h.sections_json) });
    lockHandover(a, h.id);
    await sync(a);
    await new Promise((res) => setTimeout(res, 5));

    // ٢. (ب) بلا اتصال على نسخته غير المقفلة: «تالف» · ثم يزامن
    updateHandover(b, hb.id, { ...base, sections: filled('تالف', hb.sections_json) });
    await sync(b);
    await sync(a);
    await sync(b);

    const state = (db: DBT) => {
      const x = db.get<{ locked: number; sections_json: string }>(`SELECT locked, sections_json FROM handovers WHERE id = ?`, [h.id])!;
      return { locked: Number(x.locked), ac: (JSON.parse(x.sections_json) as HandoverSection[])[0].items[0].receiveCondition };
    };
    // (الواقع: على الجهازين { locked: 0, ac: 'تالف' })
    expect(state(a)).toEqual({ locked: 1, ac: 'سليم' });
    expect(state(b)).toEqual({ locked: 1, ac: 'سليم' });
    a.close();
    b.close();
  });
});
