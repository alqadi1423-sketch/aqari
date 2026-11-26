/**
 * مدقق مستقل على إصلاح E-1 (المراجعة الشاملة 2026-11-13 · غير مُلتزَم) · بيانات مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/review11.E_1.safetyWindowReject
 *
 * متوسط · src/sync/engine.ts handoverLock: `if (mineLocked !== theirsLocked) return mineLocked ? 'keep' : 'take'` قبل أي مقارنةٍ للبنود ·
 *   فأي نسخةٍ غير مقفلة تصل إلى جهازٍ مقفل تُسجَّل في sync_rejects «رُفض التعديل المتأخر من نسخةٍ قديمة» ولو كانت هي النسخة نفسها التي
 *   أقفلها الجهاز (لا تعديل فيها).
 *
 * السيناريو (سير العمل المعتاد): الجهاز (ب) يعبّئ المحضر «المكيف · سليم» ويزامن · جهاز المالك (أ) يسحبه، فيراجعه ويُقفله كما هو، ثم
 *   يزامن. وفي السحابة الحقيقية يُسحب ما كُتب في الدقيقة الأخيرة ثانيةً (src/cloud/firestore.ts PULL_SAFETY_MS: المؤشر المحفوظ موضعٌ
 *   آمن قبل وقت القراءة بستين ثانية) · يحاكيه هنا durableCursor = null كما في tests/d4.auditZ2.stmtMark.test.ts.
 *   فدورة القفل تسحب نسخة (ب) غير المقفلة ثانيةً (ما زالت آخر نسخة في السحابة حتى يُرفع القفل).
 *   الواقع بعد الإصلاح: «حالة المزامنة» على جهاز المالك فيها مرفوضٌ واحد بسبب «رُفض التعديل المتأخر»، وفي سجل العمليات المزامَن
 *   «رفض وارد» · ولم يُعدَّل شيءٌ بعد القفل. وقبل الإصلاح لا مرفوض (التعديل المعلَّق الأحدث يغلب بلا رفض).
 *   وهو اختبار «قبل القفل: … ثم يُقفل بلا رفض» في review9.E.handoverLock نفسه، ينجح هناك لأن السحابة المحاكاة لا تعيد السحب.
 *
 * السلوك الصحيح: النسخة غير المقفلة ببنود المقفل نفسها ليست تعديلاً متأخراً · يبقى القفل ويُرفع بلا سطرٍ في المرفوض ولا «رفض وارد».
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce, syncStatus } from '@/sync/engine';
import { confirmContract } from '@/domain/contracts/service';
import { getMeta } from '@/repos/settings';
import { getContractHandover, updateHandover, lockHandover, type HandoverUpdate } from '@/domain/handover/service';
import type { HandoverSection } from '@/domain/handover/build';
import type { Cursor } from '@/sync/types';

type DBT = ReturnType<typeof memDb>;
const tick = (ms = 5) => new Promise((res) => setTimeout(res, ms));
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
const rejectedIn = (db: DBT) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE module = 'المزامنة' AND entity_type = 'رفض وارد' AND entity_name LIKE 'handovers%'`)!.n;

test('E-1 · مدقق مستقل · إقفال المحضر بعد سحب تعبئة الجهاز الآخر لا يُظهر رفضاً كاذباً في «حالة المزامنة»', async () => {
  const r = new MemoryRemote();
  Object.assign(r, { durableCursor: (_c: Cursor): Cursor | null => null });
  const a = memDb();
  const b = memDb();
  const sync = (db: DBT) => syncOnce(db, r, getMeta(db, 'device_id')!);
  enableSync(a, 'u-r11-e1-sw');
  enableSync(b, 'u-r11-e1-sw');
  a.run(`INSERT INTO form_templates (id, name, sections_json, created_at) VALUES ('T-R11', 'قالب مصطنع', ?, ?)`,
    [JSON.stringify([{ section: 'الصالة', items: ['مكيف', 'إنارة'] }]), new Date().toISOString()]);
  const cid = confirmContract(a, contractInput(addUnit(a, addProperty(a)), { tenant: 'مستأجر مصطنع للنموذج' }));
  const h = getContractHandover(a, cid)!;
  await sync(a);
  await sync(b);
  await tick();
  // (ب) يعبّئ ويزامن · (أ) يسحب ويراجع ويُقفل كما هو ثم يزامن
  updateHandover(b, h.id, fill('سليم', h.sections_json));
  await sync(b);
  await sync(a);
  expect(stateOf(a, h.id)).toEqual({ locked: 0, ac: 'سليم' });
  lockHandover(a, h.id);
  await sync(a);
  await sync(b);
  await sync(a);
  expect(stateOf(a, h.id)).toEqual({ locked: 1, ac: 'سليم' });
  expect(stateOf(b, h.id)).toEqual({ locked: 1, ac: 'سليم' });
  // (الواقع بعد الإصلاح: مرفوضٌ واحد على (أ) بسبب sync.handoverLocked، و«رفض وارد» في سجل العمليات)
  expect(syncStatus(a).rejected).toBe(0);
  expect(syncStatus(b).rejected).toBe(0);
  expect(rejectedIn(a)).toBe(0);
  a.close();
  b.close();
});
