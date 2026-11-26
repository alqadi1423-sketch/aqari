/**
 * المراجع المعاكس على R12-DEP-1 (المراجعة الشاملة 2026-11-13) · بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * العيب: إصلاح R12-DEP-1 يرفض على جهاز المالك «تسوية تأمينٍ رُحِّل» من عضو: صفّ deposit_settlements وقيود الخصم والرد والسداد من
 *   التأمين · لكن التسوية التي يزيد خصمها على التأمين تكتب معها مطالبةً تلقائية بالزيادة (applyDepositSettlement: مصدرها «تسوية تأمين»)
 *   وقيدها (claim: مدين 1250 / دائن 4300) · وهذه تُقبل وحدها: اشتقاق قيد المطالبة (deriveSources: claim) لا ينظر في التسوية ولا في الترحيل.
 *   فيبقى على جهاز المالك نصف تسويةٍ رفضها: مطالبةٌ «زيادة التسوية على التأمين» على عقدٍ لا تسوية له، وإيراد ٥٠٠ في 4300، وكشف (أ)
 *   يطالب المستأجر بها · ورسالة الرفض نفسها تقول إن التأمين «يُسوّى عند انتهاء المجدَّد»، فإن أعاد المالك الخصم كله هناك نشأت
 *   مطالبة الزيادة ثانية.
 * السيناريو: (أ) بتأمين ١٬٠٠٠ لدى المكتب نقداً · المالك يجدّده إلى (ب) بترحيل التأمين · العضو على جهازه القديم يسوّي (أ): خصم ١٬٥٠٠
 *   أضراراً ولا ردّ، فالزيادة ٥٠٠ مطالبةٌ تلقائية.
 * الصحيح (قرارا المالك ٦٢ و٦٣: كتابة العضو تُرفض وتظهر في حالة المزامنة): تُرفض التسوية كلها بمطالبتها · فلا مطالبة «تسوية تأمين» على
 *   (أ)، و4300 صفر، و1250 صفر، والنقد والتأمينات ١٬٠٠٠ محمولةٌ في (ب).
 *   TZ=Asia/Riyadh npx jest tests/review12.r.settleClaimAfterCarry.test.ts
 */
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, renewContract, saveDepositSettlement } from '@/domain/contracts/service';
import { accountBalance } from '@/domain/accounting/ledger';
import { pair, sync, ownerPulls, has, MEMBER } from './helpers/rederive';
import { getMeta } from '@/repos/settings';

test('R12-DEP-1 · تسوية تأمينٍ رُحِّل من عضو: تُرفض مع مطالبة زيادتها على جهاز المالك', async () => {
  const s = await pair();
  const u = addUnit(s.owner, addProperty(s.owner, { name: 'عقار مطالبة تسويةٍ مصطنع' }), { unit_no: 'SCC-1' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const a = confirmContract(s.dev, contractInput(u, { tenant: 'مستأجر مطالبة تسويةٍ مصطنع', idNumber: '1000012061', phone: '0500012061',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  await sync(s.dev, s.r);
  const devId = getMeta(s.dev, 'device_id');
  for (const d of [...s.r.docs.values()]) if (d.dev === devId) s.r.inject({ ...d, by: MEMBER });
  await ownerPulls(s.owner, s.r);

  // المالك يجدّد بترحيل التأمين · والعضو لم يسحب بعد
  renewContract(s.owner, a, { start: '2026-01-01', end: '2026-06-30', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  await sync(s.owner, s.r);

  // العضو يسوّي (أ): خصم ١٬٥٠٠ أضراراً على تأمين ١٬٠٠٠ · فالزيادة ٥٠٠ مطالبةٌ تلقائية على جهازه
  saveDepositSettlement(s.dev, a, { date: '2026-01-05', deductionHalalas: 150000, deductionReason: 'أضرار مصطنعة', refundHalalas: 0, notes: '' });
  const deduct = s.dev.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'deposit_deduct' AND src_id = ?`, [a])!.id;
  expect(s.dev.get(`SELECT amount_halalas AS n FROM claims WHERE contract_id = ?`, [a])).toEqual({ n: 50000 });
  await sync(s.dev, s.r);
  for (const d of [...s.r.docs.values()]) if (d.dev === devId) s.r.inject({ ...d, by: MEMBER });
  await ownerPulls(s.owner, s.r);

  // قيد الخصم وصفّ التسوية مرفوضان (إصلاح R12-DEP-1)
  expect(has(s.owner, deduct)).toBe(false);
  expect(s.owner.get(`SELECT 1 FROM deposit_settlements WHERE contract_id = ?`, [a])).toBeUndefined();
  // ومطالبة زيادتها لا تبقى وحدها (اليوم: مطالبة ٥٠٬٠٠٠ «تسوية تأمين» مفتوحة، و4300 = ٥٠٬٠٠٠، و1250 = ٥٠٬٠٠٠)
  expect(s.owner.all(`SELECT amount_halalas FROM claims WHERE contract_id = ? AND deleted_at IS NULL`, [a])).toEqual([]);
  // التأمين ١٠٠٬٠٠٠ قُبض نقداً ومحمولٌ في (ب) · ولا إيراد ولا ذمة من تسويةٍ مرفوضة
  expect([accountBalance(s.owner, '1100'), accountBalance(s.owner, '2400'), accountBalance(s.owner, '1250'), accountBalance(s.owner, '4300')])
    .toEqual([100000, 100000, 0, 0]);
  s.close();
});
