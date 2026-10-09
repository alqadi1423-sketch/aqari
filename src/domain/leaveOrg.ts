/**
 * مغادرة المنشأة طوعاً (مراجعة التثبيت #65) كالإزالة: نسخة أمان أولاً، وفشلها يوقف كل شيء فيبقى العضو وبياناته كما هي،
 * ثم الخروج من السحابة، ثم تفريغ الجهاز بنسخة الأمان نفسها وبسببه في سجل العمليات · قرار المالك 2026-10-05: «لا يُمسح
 * شيء من الجهاز إلا بأمر صريح من المستخدم في تلك اللحظة، أو بإزالة عضويته. وكل مسح يُسجَّل في سجل العمليات بسببه،
 * ويسبقه نسخة أمان.» · الخطوات تُحقن فيختبرها jest بلا جهاز.
 */
export interface LeaveSteps {
  /** نسخة الأمان · تعيد مسارها */
  backup(): Promise<string>;
  /** الخروج من المحادثة والعضوية في السحابة */
  leaveCloud(): Promise<void>;
  /** تفريغ الجهاز بنسخة الأمان التي سبقته وسببه */
  wipe(safetyPath: string, reason: string): Promise<void>;
}

export async function leaveSafely(steps: LeaveSteps, reason: string): Promise<string> {
  const safety = await steps.backup();
  await steps.leaveCloud();
  await steps.wipe(safety, reason);
  return safety;
}
