/**
 * مغادرة المنشأة طوعاً (مراجعة التثبيت #65) كالإزالة: ما يُحفظ أولاً، وفشله يوقف كل شيء فيبقى العضو وبياناته كما هي، ثم الخروج من
 * السحابة، ثم تفريغ الجهاز وسببه في سجل العمليات · قرار المالك 2026-10-05: «لا يُمسح شيء من الجهاز إلا بأمر صريح من المستخدم في تلك
 * اللحظة، أو بإزالة عضويته. وكل مسح يُسجَّل في سجل العمليات بسببه» · وما يُحفظ قبله لم يعد نسخة أمانٍ كاملة: «المغادرة الطوعية مثل
 * الإزالة: لا نسخة إلا بما لم يُرفع» (س١٠ · 2026-11-13 · المراجعة الشاملة 2026-11-13 · B-4)، فهو ملفُّ ما لم يُرفع من عمله وحده
 * (domain/memberExit.ts) أو لا شيء · الخطوات تُحقن فيختبرها jest بلا جهاز.
 */
export interface LeaveSteps {
  /** ما يُحفظ قبل الخروج: ملفُّ ما لم يُرفع من عمله · يعيد اسمه، أو null إن لم يبقَ له شيء */
  backup(): Promise<string | null>;
  /** الخروج من المحادثة والعضوية في السحابة */
  leaveCloud(): Promise<void>;
  /** تفريغ الجهاز بلا نسخة أمان وسببه، وما حُفظ قبله */
  wipe(saved: string | null, reason: string): Promise<void>;
}

export async function leaveSafely(steps: LeaveSteps, reason: string): Promise<string | null> {
  const saved = await steps.backup();
  await steps.leaveCloud();
  await steps.wipe(saved, reason);
  return saved;
}
