/**
 * الرسم الشهري الواحد · إيراد ومصروف عمودين متجاورين لكل شهر.
 *
 * مكوّن واحد يخدم الرئيسية (ستة أشهر بأعمدة عادية) والتقارير (اثنا عشر شهراً
 * بأعمدة أرفع) · فلا يتفرّق الرسم بين شاشتين ولا يختلف مقياساه.
 *
 * النمط المعتمد: عمودان رفيعان متلاصقان لكل شهر (إيراد أخضر · مصروف أحمر)
 * وفجوة بين الأشهر، وشبكة أفقية خفيفة خلف الأعمدة، وأسماء الأشهر أسفلها،
 * والأرقام فوق الأعمدة بالألف وبيانها في الأسطورة.
 *
 * الاتجاه: الأقدم يميناً · تُمرَّر الأشهر بترتيبها الطبيعي (الأقدم أولاً)
 * وتُقلب المنطقة إلى rtl فيقع أولها يميناً. والشبكة أشرطة عرضها كامل الرسم
 * لا طبقة SVG فوق الأعمدة · فلا ينفصل خط عن عموده مهما انقلب الاتجاه.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { T, Num, Row } from './components';
import { useFs } from './store';
import { C, TYPE } from './theme';

export interface BarChartMonth {
  /** مفتاح الشهر «2026-08» · يُسلَّم لمعالج الضغط ليفتح قيود ذلك الشهر */
  key: string;
  /** اسم الشهر تحت عموديه */
  label: string;
  /** إيراد الشهر بالهللات */
  revenue: number;
  /** مصروف الشهر بالهللات */
  expense: number;
}

/** الهللات في الألف ريال · الأرقام فوق الأعمدة تُقرأ بالألف */
const PER_THOUSAND = 100000;

/** رقم العمود بالألف · «45» و«4.2» و«0» للتافه */
function inThousands(halalas: number): string {
  const k = Math.abs(halalas) / PER_THOUSAND;
  const sign = halalas < 0 ? '-' : '';
  if (k >= 10) return sign + String(Math.round(k));
  if (k >= 0.05) return sign + String(Math.round(k * 10) / 10);
  return '0';
}

export function BarChart({
  months, barWidth = 12, gridLines = 4, height = 120, onMonthPress,
}: {
  /** أشهر الرسم بترتيبها الطبيعي · الأقدم أولاً فيقع يميناً */
  months: BarChartMonth[];
  /** عرض العمود الواحد · الرئيسية ستة أشهر بـ12 والتقارير اثنا عشر بـ6 */
  barWidth?: number;
  /** عدد خطوط الشبكة الأفقية شاملاً خط القاعدة */
  gridLines?: number;
  /** ارتفاع منطقة الأعمدة بما فيها سطر الأرقام */
  height?: number;
  /** الضغط على شهر · يفتح تفاصيل ذلك الشهر */
  onMonthPress?: (m: BarChartMonth) => void;
}) {
  const fs = useFs();
  if (!months.length) return null;
  const max = Math.max(1, ...months.map((m) => Math.max(m.revenue, m.expense)));
  // سطر الرقم فوق العمود يقتطع من الارتفاع · وما بقي هو مدى العمود الأطول ·
  // ويكبر السطر بكبر خط المستخدم فلا يزحف الرقم على العمود
  const numberH = Math.round(fs(TYPE.caption) * 1.5);
  const barMaxH = Math.max(20, height - numberH);
  const lines = Math.max(2, gridLines);
  // مهد الرقم أوسع من العمود قليلاً كي يتسع «45» بلا تضييق
  const slotW = barWidth + 4;
  const monthGap = Math.max(3, Math.round(barWidth / 2));

  const bar = (value: number, color: string) => (
    <View style={{ width: slotW, alignItems: 'center', justifyContent: 'flex-end' }}>
      <Num size={TYPE.caption} bold color={color}>{inThousands(value)}</Num>
      <View style={{
        width: barWidth,
        height: Math.max(2, Math.round((Math.max(0, value) / max) * barMaxH)),
        backgroundColor: color, borderTopStartRadius: 3, borderTopEndRadius: 3,
      }} />
    </View>
  );

  return (
    <View>
      <View style={{ direction: 'rtl' }}>
        {/* الشبكة خلف الأعمدة · خطوط بلون فاتح جداً وآخرها قاعدة الرسم */}
        <View pointerEvents="none" style={{ position: 'absolute', top: numberH, left: 0, right: 0, height: barMaxH }}>
          {Array.from({ length: lines }).map((_, i) => (
            <View key={i} style={{
              position: 'absolute', left: 0, right: 0, height: 1,
              top: Math.round((i * barMaxH) / (lines - 1)),
              backgroundColor: C.paperLine,
            }} />
          ))}
        </View>
        <Row gap={monthGap} style={{ alignItems: 'flex-end' }}>
          {months.map((m) => {
            const body = (
              <>
                <Row gap={2} style={{ height, alignItems: 'flex-end', justifyContent: 'center' }}>
                  {bar(m.revenue, C.emerald)}
                  {bar(m.expense, C.rose)}
                </Row>
                <T center size={TYPE.caption} color={C.muted}>{m.label}</T>
              </>
            );
            if (!onMonthPress) {
              return <View key={m.key} style={{ flex: 1, alignItems: 'center' }}>{body}</View>;
            }
            return (
              <Pressable key={m.key} onPress={() => onMonthPress(m)}
                style={({ pressed }) => [{ flex: 1, alignItems: 'center' }, pressed && { opacity: 0.6 }]}>
                {body}
              </Pressable>
            );
          })}
        </Row>
      </View>
      <Row gap={12} style={{ marginTop: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        <Row gap={4}>
          <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: C.emerald }} />
          <T size={TYPE.caption} color={C.muted}>إيراد</T>
        </Row>
        <Row gap={4}>
          <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: C.rose }} />
          <T size={TYPE.caption} color={C.muted}>مصروف</T>
        </Row>
        <T size={TYPE.caption} color={C.muted}>الأرقام بالألف</T>
      </Row>
    </View>
  );
}
