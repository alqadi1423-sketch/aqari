/**
 * أرقام الودجت ليومها (المراجعة الشاملة 2026-11-13 · E-3) · مثيلة `pickAheadIndex` في `AqariWidgets.kt` حرفاً بحرف، فكوتلن لا تُختبر هنا
 * وهذه تُختبر، واختبار review13.E_3.widgetPick يقرأ ملف كوتلن فلا تفترقان.
 *
 * اللقطة تحمل أرقام يوم كتابتها، و`ahead` (كل يومٍ تتغيّر فيه الأرقام خلال ستين يوماً)، و`validUntil` · فالودجت تعرض آخر يومٍ من الجدول
 * لم يتجاوز اليوم، وإلا أرقام اللقطة نفسها · وبعد `validUntil` لا أرقام بل «آخر تحديث … · افتح التطبيق» · ولقطةٌ بلا `validUntil`
 * (إصدارٌ سابق) تصحّ ليومها وحده.
 */

/** أرقام يومٍ في اللقطة · نصوصٌ منسَّقة جاهزة، فارغةٌ بالقفل أو بلا صلاحية */
export interface WidgetNumbers {
  lateCount: number;
  lateSum: string;
  dueThisMonth: string;
  paidThisMonth: string;
  monthPct: number;
}

/** ما تقرؤه الودجت من اللقطة لاختيار يومها */
export interface WidgetDaySource extends WidgetNumbers {
  day: string;
  validUntil?: string;
  ahead?: readonly (WidgetNumbers & { day: string })[];
}

/**
 * موضع يوم الجدول الصالح لـ`today` · null: تجاوز اليومُ `validUntil` (أو يوم اللقطة إن خلت منه) · ‎-1: أرقام اللقطة نفسها · وإلا موضع
 * آخر يومٍ في `ahead` لم يتجاوز اليوم (والمتساويان يُختار آخرهما)
 */
export function pickWidgetDay(today: string, day: string, validUntil: string, aheadDays: readonly string[]): number | null {
  const until = validUntil.trim() ? validUntil : day;
  if (until.trim() && today > until) return null;
  let best = -1;
  for (let i = 0; i < aheadDays.length; i++) {
    const d = aheadDays[i];
    if (d.trim() && d <= today && (best < 0 || d >= aheadDays[best])) best = i;
  }
  return best;
}

/** «28/11» من «2026-11-28» · كـ dfmt بلا سنة */
export function widgetShortDay(iso: string): string {
  return iso.length >= 10 ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : iso;
}

export type WidgetToday = ({ stale: false } & WidgetNumbers) | { stale: true; day: string };

/** أرقام الودجت يوم `today` · كما يبنيها readSnapshot في كوتلن */
export function widgetNumbersOn(s: WidgetDaySource, today: string): WidgetToday {
  const ahead = s.ahead ?? [];
  const pick = pickWidgetDay(today, s.day ?? '', s.validUntil ?? '', ahead.map((a) => a.day ?? ''));
  if (pick === null) return { stale: true, day: s.day ?? '' };
  const src = pick >= 0 ? ahead[pick] : s;
  return {
    stale: false,
    lateCount: src.lateCount ?? 0,
    lateSum: src.lateSum ?? '0.00',
    dueThisMonth: src.dueThisMonth ?? '0.00',
    paidThisMonth: src.paidThisMonth ?? '0.00',
    monthPct: src.monthPct ?? 0,
  };
}
