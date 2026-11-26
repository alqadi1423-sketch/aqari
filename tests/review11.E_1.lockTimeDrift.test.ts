/**
 * مدقق مستقل على إصلاح E-1 (المراجعة الشاملة 2026-11-13 · غير مُلتزَم) · بيانات مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/review11.E_1.lockTimeDrift
 *
 * منخفض · src/sync/engine.ts handoverLock (مقفلتان ببنودٍ مختلفة): «الأسبق» يُقاس بوقت آخر نسخةٍ عرفها الجهاز للصف (sync_rowtime) أو
 *   وقت طابوره (pending.changed_at)، لا بوقت الإقفال · وكلاهما يتقدّم بعد الإقفال بما يمضي على المقفَل بالحسم المعتاد (نقل الوحدة إلى
 *   عقارٍ آخر يعيد رفع كل ما تحتها · src/domain/unitMove.ts retagUnitTree، والسلة والاستعادة، وإعادة الرفع للرؤية).
 *
 * السيناريو: (أ) يعبّئ «المكيف · سليم» ويُقفل ويزامن · (ب) بلا اتصال لم يسحب القفل فيعبّئ «تالف» ويُقفل بعده · ثم يُنقل في (أ) عقار
 *   الوحدة (saveUnit ← retagUnitTree كما في propertiesService.ts) فيُعاد رفع المحضر المقفل بوقت النقل · ثم يزامن الجهازان.
 *   الواقع بعد الإصلاح: (ب) يعدّ قفله «الأسبق» (وقته قبل وقت النقل) فيرفض نسخة (أ) ويرفع نسخته، و(أ) يأخذها ويُسقط قفله الأول مرفوضاً ·
 *   فالمحضر الذي أُقفل أولاً «سليم» صار «تالف» على الجهازين، وهو ما يمنعه القرار («بين مقفلتين مختلفتين تغلب الأسبق، والإقفال الثاني
 *   تعديلٌ متأخر»). وقبل الإصلاح كان يبقى «سليم» في هذا المسار (النقل الأحدث يغلب الصف كله).
 *
 * السلوك الصحيح: الإقفال الأول («سليم» من (أ)) يبقى على الجهازين، والإقفال الثاني من (ب) يُرى مرفوضاً · ونقل الوحدة وما شابهه لا يغيّر
 *   أيّ القفلين أسبق.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce } from '@/sync/engine';
import { confirmContract } from '@/domain/contracts/service';
import { getMeta } from '@/repos/settings';
import { retagUnitTree } from '@/domain/unitMove';
import { getContractHandover, updateHandover, lockHandover, type HandoverUpdate } from '@/domain/handover/service';
import type { HandoverSection } from '@/domain/handover/build';

type DBT = ReturnType<typeof memDb>;
const tick = (ms = 15) => new Promise((res) => setTimeout(res, ms));
const fill = (cond: string, json: string): HandoverUpdate => {
  const s = JSON.parse(json) as HandoverSection[];
  s[0].items[0].receiveCondition = cond;
  return { employeeName: 'موظف مصطنع', tenantName: 'مستأجر مصطنع للنموذج', idNumber: '', phone: '', address: '', unitFloor: '',
    contractPeriod: '', date: '2026-01-01', otherNotes: '', tenantSign: 'مستأجر', companySign: 'المكتب', sections: s };
};
const stateOf = (db: DBT, id: string) => {
  const x = db.get<{ locked: number; sections_json: string }>(`SELECT locked, sections_json FROM handovers WHERE id = ?`, [id])!;
  return { locked: Number(x.locked), ac: (JSON.parse(x.sections_json) as HandoverSection[])[0].items[0].receiveCondition };
};

test('E-1 · مدقق مستقل · نقل الوحدة بعد الإقفال لا يجعل إقفالاً ثانياً متأخراً يغلب الإقفال الأول', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  const b = memDb();
  const sync = (db: DBT) => syncOnce(db, r, getMeta(db, 'device_id')!);
  enableSync(a, 'u-r11-e1-drift');
  enableSync(b, 'u-r11-e1-drift');
  a.run(`INSERT INTO form_templates (id, name, sections_json, created_at) VALUES ('T-R11', 'قالب مصطنع', ?, ?)`,
    [JSON.stringify([{ section: 'الصالة', items: ['مكيف', 'إنارة'] }]), new Date().toISOString()]);
  const p1 = addProperty(a, { name: 'عقار مصطنع أول' });
  const p2 = addProperty(a, { name: 'عقار مصطنع ثانٍ' });
  const unit = addUnit(a, p1);
  const cid = confirmContract(a, contractInput(unit, { tenant: 'مستأجر مصطنع للنموذج' }));
  const h = getContractHandover(a, cid)!;
  await sync(a);
  await sync(b);
  // ١. (أ) يُقفل أولاً
  updateHandover(a, h.id, fill('سليم', h.sections_json));
  lockHandover(a, h.id);
  await sync(a);
  await tick();
  // ٢. (ب) بلا اتصال يُقفل نسخته بعده
  updateHandover(b, h.id, fill('تالف', h.sections_json));
  lockHandover(b, h.id);
  await tick();
  // ٣. (أ) ينقل الوحدة إلى عقارٍ آخر (ما يفعله saveUnit: تحديث العقار ثم retagUnitTree)
  a.run(`UPDATE units SET property_id = ? WHERE id = ?`, [p2, unit]);
  retagUnitTree(a, unit, p1, p2);
  await sync(a);
  await sync(b);
  await sync(a);
  await sync(b);
  // (الواقع بعد الإصلاح: { locked: 1, ac: 'تالف' } على الجهازين · والقفل الأول مرفوضٌ على (أ))
  expect(stateOf(a, h.id)).toEqual({ locked: 1, ac: 'سليم' });
  expect(stateOf(b, h.id)).toEqual({ locked: 1, ac: 'سليم' });
  a.close();
  b.close();
});
