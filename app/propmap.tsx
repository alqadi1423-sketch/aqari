/**
 * خريطة العقارات · Leaflet/OSM كما في النموذج · حول كل دبوس حلقة بنسبة إشغال عقاره
 * ولونه من العتبة التي تقع فيها، والضغط عليه يفتح بطاقته فوق الخريطة، والضغط على
 * البطاقة يفتح تفاصيل العقار · والدبابيس المتقاربة تتجمّع عند التصغير.
 */
import React, { useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '../src/ui/Screen';
import { Card, T, Num, Money, Row, KpiCard, BtnIcon } from '../src/ui/components';
import { LeafletMap, occupancyColor, OCC, type MapMarker } from '../src/ui/LeafletMap';
import { useApp } from '../src/ui/store';
import { C, TYPE } from '../src/ui/theme';
import { allPropertyStats } from '../src/domain/stats';
import { today } from '../src/domain/dates';

const LEGEND: Array<[string, string]> = [
  [OCC.high.color, OCC.high.label],
  [OCC.mid.color, OCC.mid.label],
  [OCC.low.color, OCC.low.label],
  [OCC.none.color, OCC.none.label],
];

interface PropCard {
  id: string;
  name: string;
  pct: number | null;
  units: number;
  monthIncome: number;
}

export default function PropMap() {
  const { db, version } = useApp();
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [mapH, setMapH] = useState(0);

  const data = useMemo(() => {
    const all = db.all<{ id: string; name: string; lat: number | null; lng: number | null }>(
      `SELECT id, name, lat, lng FROM properties WHERE deleted_at IS NULL`
    );
    const stats = allPropertyStats(db);
    // دخل الشهر: ما قُبض فعلاً في الشهر الجاري لكل عقار
    const month = today().slice(0, 7);
    const income = new Map<string, number>();
    for (const r of db.all<{ pid: string; s: number }>(
      `SELECT u.property_id AS pid, COALESCE(SUM(pm.net_halalas),0) AS s
       FROM contract_payments pm
       JOIN contracts c ON c.id = pm.contract_id
       JOIN units u ON u.id = c.unit_id
       WHERE c.deleted_at IS NULL AND u.deleted_at IS NULL AND substr(pm.date, 1, 7) = ?
       GROUP BY u.property_id`,
      [month]
    )) income.set(r.pid, Number(r.s));

    const cards = new Map<string, PropCard>();
    const markers: MapMarker[] = [];
    for (const p of all) {
      const st = stats.get(p.id);
      const units = st ? st.total : 0;
      const pct = units ? (st ? st.occupancyPct : 0) : null;
      cards.set(p.id, { id: p.id, name: p.name, pct, units, monthIncome: income.get(p.id) ?? 0 });
      if (p.lat == null || p.lng == null) continue;
      if (!isFinite(Number(p.lat)) || !isFinite(Number(p.lng))) continue;
      markers.push({
        id: p.id,
        lat: Number(p.lat),
        lng: Number(p.lng),
        color: occupancyColor(pct),
        title: p.name,
        pct,
      });
    }
    return { count: all.length, cards, markers, missing: all.length - markers.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version]);

  const card = selected ? data.cards.get(selected) : undefined;

  return (
    <Screen title="خريطة العقارات" scroll={false} icon="map">
      <View
        style={{ flex: 1 }}
        onLayout={(e) => setMapH(Math.max(0, Math.round(e.nativeEvent.layout.height) - 2))}
      >
        <Card style={{ padding: 0, overflow: 'hidden', flex: 1, marginBottom: 0 }}>
          {mapH > 0 ? (
            <LeafletMap
              markers={data.markers}
              height={mapH}
              onMarkerPress={(id) => setSelected(id)}
            />
          ) : null}
        </Card>
        {card ? (
          <View style={{ position: 'absolute', right: 8, left: 8, bottom: 8 }}>
            <Pressable
              onPress={() => router.push({ pathname: '/(tabs)/properties', params: { detail: card.id } })}
              style={({ pressed }) => (pressed ? { opacity: 0.9 } : null)}
            >
              <Card style={{ marginBottom: 0 }}>
                <Row style={{ justifyContent: 'space-between', marginBottom: 9 }}>
                  <T size={TYPE.cardTitle} bold color={C.ink} numberOfLines={1} style={{ flex: 1 }}>{card.name}</T>
                  <BtnIcon icon="x" accessibilityLabel="إغلاق البطاقة" onPress={() => setSelected(null)} />
                </Row>
                <Row style={{ flexWrap: 'wrap' }}>
                  <KpiCard label="الإشغال" value={card.pct == null ? '' : <Num>{card.pct + '٪'}</Num>} />
                  <KpiCard label="دخل الشهر" value={<Money halalas={card.monthIncome} />} />
                  <KpiCard label="الوحدات" value={<Num>{card.units}</Num>} />
                </Row>
              </Card>
            </Pressable>
          </View>
        ) : null}
      </View>

      <Row style={{ flexWrap: 'wrap', marginTop: 10, gap: 12 }}>
        {LEGEND.map(([color, label]) => (
          <Row key={label} gap={5}>
            <View style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: color }} />
            <T size={TYPE.caption}>{label}</T>
          </Row>
        ))}
      </Row>
      <T size={TYPE.caption} color={C.muted} style={{ marginTop: 8, marginBottom: 10 }}>
        {data.missing > 0
          ? `${data.missing} عقار بلا موقع محدَّد بعد · أضِف موقعه من شاشة «تعديل العقار».`
          : data.count ? 'كل العقارات محدَّدة على الخريطة' : 'لا توجد عقارات بعد'}
      </T>
    </Screen>
  );
}
