/**
 * قياس الأداء · يعرض زمن كل انتقال من اللمسة حتى ظهور الشاشة (الهدف أقل من 300 م.ث)
 * ومجموع زمن SQL داخله وأبطأ الاستعلامات، وينسخ تقريراً نصياً يُرسل كما هو.
 * الأرقام تُجمع أثناء الاستخدام العادي وتُصفَّر عند إغلاق التطبيق.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, FlatList, Share, Platform } from 'react-native';
import { Screen } from '../src/ui/Screen';
import { Card, CardTitle, T, Num, BtnPrimary, BtnGhost, Row, EmptyState, Note, Divider } from '../src/ui/components';
import { C } from '../src/ui/theme';
import { useToast } from '../src/ui/Toast';
import {
  perfData, perfReset, perfReport, perfAggregate, subscribePerf, type PerfAgg,
} from '../src/perf/perf';

function deviceLine(): string {
  try {
    const c = Platform.constants as { Brand?: string; Model?: string; Release?: string };
    return `الجهاز: ${c.Brand ?? ''} ${c.Model ?? ''} · أندرويد ${c.Release ?? ''}`.trim();
  } catch {
    return 'الجهاز: غير معروف';
  }
}

export default function PerfScreen() {
  const toast = useToast();
  const [tick, setTick] = useState(0);
  useEffect(() => subscribePerf(() => setTick((t) => t + 1)), []);

  const { samples, slowSql } = useMemo(() => perfData(), [tick]);
  const agg = useMemo(() => perfAggregate(samples), [samples]);

  const header = (
    <View>
      <Note tone="gold">
        تنقّل بين الشاشات كعادتك ثم عد هنا. كل صف: من لحظة لمس الزر حتى ظهور
        الشاشة. الهدف أقل من 300 م.ث لكل انتقال. انسخ التقرير وأرسله كما هو.
      </Note>
      <Row style={{ marginTop: 10, marginBottom: 6 }}>
        <View style={{ flex: 1 }}>
          <BtnPrimary
            title="نسخ التقرير"
            onPress={async () => {
              try {
                await Share.share({ message: perfReport(deviceLine()) });
              } catch {
                toast('تعذّرت المشاركة');
              }
            }}
          />
        </View>
        <BtnGhost title="مسح الأرقام" onPress={() => { perfReset(); toast('صُفِّرت'); }} />
      </Row>
      <Card>
        <CardTitle>الانتقالات · {String(agg.length)}</CardTitle>
        {!agg.length ? (
          <EmptyState>لا عينات بعد · تنقّل بين الشاشات ثم عد هنا</EmptyState>
        ) : null}
      </Card>
    </View>
  );

  const footer = (
    <Card style={{ marginTop: 10 }}>
      <CardTitle>أبطأ الاستعلامات · 8 م.ث فأكثر</CardTitle>
      {!slowSql.length ? (
        <EmptyState>لا استعلامات بطيئة حتى الآن</EmptyState>
      ) : (
        slowSql.slice(0, 12).map((q, i) => (
          <View key={i} style={{ paddingVertical: 6, borderBottomWidth: i < Math.min(slowSql.length, 12) - 1 ? 1 : 0, borderBottomColor: C.line }}>
            <Row>
              <Num size={12} bold color={q.ms >= 50 ? C.rose : C.gold}>{String(q.ms)}</Num>
              <T size={10.5} color={C.muted}>م.ث</T>
            </Row>
            <T size={10} color={C.muted} numberOfLines={2} style={{ textAlign: 'left', writingDirection: 'ltr' }}>{q.sql}</T>
          </View>
        ))
      )}
    </Card>
  );

  const renderAgg = ({ item }: { item: PerfAgg }) => {
    const ok = item.last < 300;
    return (
      <Card style={{ marginTop: 8 }}>
        <Row>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ok ? C.emerald : C.rose }} />
          <T size={12.5} bold color={C.ink} style={{ flex: 1 }}>{item.label}</T>
          <Num size={15} bold color={ok ? C.emerald : C.rose}>{String(item.last)}</Num>
          <T size={10.5} color={C.muted}>م.ث</T>
        </Row>
        <Divider />
        <Row>
          <T size={10.5} color={C.muted} style={{ flex: 1 }}>متوسط {String(item.avg)} · أعلى {String(item.max)} · مرات {String(item.count)}</T>
          <T size={10.5} color={C.muted}>
            SQL بآخرها {String(item.lastSqlMs)} م.ث في {String(item.lastSqlN)} استعلاماً
          </T>
        </Row>
        {item.lastDisp !== undefined || item.lastMount !== undefined ? (
          <T size={10.5} color={C.muted}>
            آخرها: تجهيز {String((item.lastDisp ?? 0) + (item.lastMount ?? 0))} م.ث (توجيه وتركيب حتى الإيداع) ثم إطارا الرسم
          </T>
        ) : null}
      </Card>
    );
  };

  return (
    <Screen title="قياس الأداء" icon="chart" scroll={false}>
      <FlatList
        data={agg}
        keyExtractor={(x) => x.label}
        renderItem={renderAgg}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        contentContainerStyle={{ paddingBottom: 30 }}
      />
    </Screen>
  );
}
