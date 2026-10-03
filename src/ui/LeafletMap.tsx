/**
 * خريطة Leaflet داخل WebView · نفس محرك النموذج الأصلي (OSM، بلا مفاتيح API).
 * وضعان: عرض دبابيس بحلقة إشغال ملوّنة مع تجميع عند التصغير، والتقاط موقع بالنقر.
 * المكتبة مضمّنة في التطبيق (leafletBundle.ts) فتعمل الخريطة بلا اتصال: الدبابيس والتجميع والتقاط الموقع ·
 * والبلاطات (صور الخريطة) وحدها من الشبكة، فانقطاعها يعرض شريطاً عربياً فوق الدبابيس لا شاشة رمادية صامتة.
 */
import React, { useContext, useMemo, useState } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { SheetScrollCtx } from './Sheet';
import { T, BtnGhost } from './components';
import { C, TYPE } from './theme';
import { LEAFLET_JS, LEAFLET_CSS } from './leafletBundle';

export interface MapMarker {
  /** معرّف يُعاد عند الضغط على الدبوس (لفتح بطاقته) */
  id?: string;
  lat: number;
  lng: number;
  color: string;
  title: string;
  sub?: string;
  /** نسبة الإشغال من صفر إلى مئة · تُرسم حلقةً حول الدبوس · و null لعقار بلا وحدات */
  pct?: number | null;
}

/**
 * ألوان الإشغال وعتباته · مرجع واحد تقرأ منه الشاشة والخريطة معاً:
 * ٧٥٪ فأكثر أخضر · من ٤٠ إلى ٧٤٪ ذهبي · أقل من ٤٠٪ أحمر · وبلا وحدات رمادي.
 */
export const OCC = {
  high: { from: 75, color: '#1E6E5C', label: 'إشغال عالٍ · ٧٥٪ فأكثر' },
  mid: { from: 40, color: '#C9A961', label: 'إشغال متوسط · من ٤٠ إلى ٧٤٪' },
  low: { from: 0, color: '#AE4438', label: 'إشغال منخفض · أقل من ٤٠٪' },
  none: { color: '#6B7280', label: 'بلا وحدات' },
} as const;

export function occupancyColor(pct: number | null | undefined): string {
  if (pct == null) return OCC.none.color;
  if (pct >= OCC.high.from) return OCC.high.color;
  if (pct >= OCC.mid.from) return OCC.mid.color;
  return OCC.low.color;
}

const esc = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const TRACK = '#E4E1D8';

function buildHtml(opts: {
  markers: MapMarker[];
  center: { lat: number; lng: number };
  zoom: number;
  pickable: boolean;
  pin: { lat: number; lng: number } | null;
}): string {
  const data = opts.markers.map((m) => ({
    id: m.id ?? '',
    lat: m.lat,
    lng: m.lng,
    color: m.color,
    title: esc(m.title),
    sub: esc(m.sub ?? ''),
    pct: m.pct == null ? null : Math.max(0, Math.min(100, Math.round(m.pct))),
  }));
  const dataJs = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${LEAFLET_CSS}</style>
<script>${LEAFLET_JS}</script>
<style>
  html,body,#map{margin:0;padding:0;height:100%;width:100%}
  body{font-family:'Segoe UI',Tahoma,sans-serif;background:#F6F4EE}
  #offline{display:none;height:100%;width:100%;box-sizing:border-box;padding:22px;
    align-items:center;justify-content:center;text-align:center;color:#77808F;font-size:13px;line-height:2}
  #banner{display:none;position:absolute;top:8px;right:8px;left:8px;z-index:900;background:#F7E9E6;
    color:#AE4438;border:1px solid #AE4438;border-radius:8px;padding:7px 10px;font-size:12px;text-align:center}
  .pinWrap{display:flex;flex-direction:column;align-items:center}
  .ring{border-radius:50%;background:${TRACK};display:flex;align-items:center;justify-content:center;
    box-shadow:0 2px 6px rgba(0,0,0,.3)}
  .core{border-radius:50%;border:2px solid #fff;display:flex;align-items:center;justify-content:center;
    color:#fff;font-weight:700}
  .tag{background:#fff;border:1px solid ${TRACK};border-radius:6px;padding:2px 7px;font-size:11px;
    font-weight:700;color:#10192E;white-space:nowrap;margin-top:3px;box-shadow:0 1px 3px rgba(0,0,0,.15)}
</style>
</head><body>
<div id="banner">صور الخريطة تحتاج اتصالاً بالإنترنت · الدبابيس تعمل بدونه</div>
<div id="map"></div>
<div id="offline">تعذّر تشغيل الخريطة</div>
<script>
  var RN = window.ReactNativeWebView;
  function post(o){ try { if (RN) RN.postMessage(JSON.stringify(o)); } catch (e) { /* لا شيء */ } }
  function occColor(p){
    if (p === null || p === undefined) return '${OCC.none.color}';
    if (p >= ${OCC.high.from}) return '${OCC.high.color}';
    if (p >= ${OCC.mid.from}) return '${OCC.mid.color}';
    return '${OCC.low.color}';
  }
  function ringHtml(color, pct, size, coreSize, text, fontSize){
    var bg = (pct === null || pct === undefined)
      ? ''
      : ';background-image:conic-gradient(' + color + ' 0 ' + pct + '%, ${TRACK} ' + pct + '% 100%)';
    return '<div class="ring" style="width:' + size + 'px;height:' + size + 'px' + bg + '">'
      + '<div class="core" style="width:' + coreSize + 'px;height:' + coreSize + 'px;background:' + color
      + ';font-size:' + fontSize + 'px">' + text + '</div></div>';
  }
  if (typeof L === 'undefined') {
    document.getElementById('map').style.display = 'none';
    document.getElementById('offline').style.display = 'flex';
    post({type:'nolib'});
  } else {
    var map = L.map('map').setView([${opts.center.lat}, ${opts.center.lng}], ${opts.zoom});
    var tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {attribution:'© OpenStreetMap', maxZoom:19}).addTo(map);
    var tilesBad = false;
    tiles.on('tileerror', function(){
      if (tilesBad) return;
      tilesBad = true;
      document.getElementById('banner').style.display = 'block';
      post({type:'notiles'});
    });

    var DATA = ${dataJs};
    var layer = L.layerGroup().addTo(map);

    function pinFor(m){
      var text = (m.pct === null || m.pct === undefined) ? '' : String(m.pct);
      var html = '<div class="pinWrap">' + ringHtml(m.color, m.pct, 38, 26, text, 10)
        + '<div class="tag" style="border-top:3px solid ' + m.color + '">' + m.title + '</div></div>';
      var mk = L.marker([m.lat, m.lng], {icon: L.divIcon({className:'', html: html, iconSize:[38,60], iconAnchor:[19,19]})});
      if (m.id) mk.on('click', function(){ post({type:'marker', id: m.id}); });
      else if (m.sub) mk.bindPopup('<b>' + m.title + '</b><br>' + m.sub);
      return mk;
    }

    function clusterFor(group){
      var lat = 0, lng = 0, sum = 0, counted = 0;
      for (var i = 0; i < group.length; i++) {
        lat += group[i].lat; lng += group[i].lng;
        if (group[i].pct !== null && group[i].pct !== undefined) { sum += group[i].pct; counted++; }
      }
      var avg = counted ? Math.round(sum / counted) : null;
      var color = occColor(avg);
      var html = '<div class="pinWrap">' + ringHtml(color, avg, 46, 34, String(group.length), 14) + '</div>';
      var mk = L.marker([lat / group.length, lng / group.length],
        {icon: L.divIcon({className:'', html: html, iconSize:[46,46], iconAnchor:[23,23]})});
      mk.on('click', function(){
        var pts = group.map(function(g){ return [g.lat, g.lng]; });
        map.fitBounds(pts, {padding:[40,40], maxZoom: 17});
      });
      return mk;
    }

    /** تجميع بالمسافة بالبكسل عند التكبير الحالي · بلا مكتبة خارجية */
    function render(){
      layer.clearLayers();
      if (!DATA.length) return;
      var pts = DATA.map(function(m){ return {m: m, p: map.latLngToLayerPoint([m.lat, m.lng])}; });
      var used = [];
      for (var i = 0; i < pts.length; i++) {
        if (used[i]) continue;
        var group = [pts[i].m];
        used[i] = true;
        for (var j = i + 1; j < pts.length; j++) {
          if (used[j]) continue;
          if (pts[i].p.distanceTo(pts[j].p) < 64) { group.push(pts[j].m); used[j] = true; }
        }
        layer.addLayer(group.length === 1 ? pinFor(group[0]) : clusterFor(group));
      }
    }
    map.on('zoomend', render);
    render();

    var pickPin = ${opts.pin ? `L.marker([${opts.pin.lat}, ${opts.pin.lng}]).addTo(map)` : 'null'};
    ${opts.pickable ? `
    map.on('click', function(e){
      if (pickPin) map.removeLayer(pickPin);
      pickPin = L.marker([e.latlng.lat, e.latlng.lng]).addTo(map);
      post({lat: e.latlng.lat, lng: e.latlng.lng});
    });` : ''}
    var bounds = DATA.map(function(m){ return [m.lat, m.lng]; });
    if (bounds.length > 1) map.fitBounds(bounds, {padding:[40,40]});
  }
</script></body></html>`;
}

export function LeafletMap({
  markers = [], center, zoom = 12, height = 420, pickable = false, pin = null, onPick, onMarkerPress,
}: {
  markers?: MapMarker[];
  center?: { lat: number; lng: number };
  zoom?: number;
  height?: number;
  pickable?: boolean;
  pin?: { lat: number; lng: number } | null;
  onPick?: (lat: number, lng: number) => void;
  /** الضغط على دبوس يفتح بطاقة عنصره */
  onMarkerPress?: (id: string) => void;
}) {
  const c = center ?? (markers.length
    ? { lat: markers[0].lat, lng: markers[0].lng }
    : pin ?? { lat: 24.7136, lng: 46.6753 });
  const html = useMemo(
    () => buildHtml({ markers, center: c, zoom: markers.length || pin ? zoom : 5, pickable, pin }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(markers), c.lat, c.lng, zoom, pickable, pin?.lat, pin?.lng]
  );
  // حال الصفحة كما تبلّغها · nolib: لم تعمل المكتبة (مضمّنة، فلا يقع إلا بعطل في العرض) · notiles: لم تصل صور الخريطة
  const [fault, setFault] = useState<'nolib' | 'notiles' | null>(null);
  const [attempt, setAttempt] = useState(0);
  // داخل نافذة سفلية: لمس الخريطة يثبّت الصفحة حتى يرفع الإصبع · فالسحب يحرّك الخريطة لا النافذة
  const sheetScroll = useContext(SheetScrollCtx);
  return (
    <View
      style={{ height, borderRadius: 10, overflow: 'hidden', backgroundColor: C.paper }}
      onTouchStart={() => sheetScroll?.lock()}
      onTouchEnd={() => sheetScroll?.unlock()}
      onTouchCancel={() => sheetScroll?.unlock()}
    >
      <WebView
        key={attempt}
        originWhitelist={['*']}
        source={{ html }}
        javaScriptEnabled
        domStorageEnabled
        onError={() => setFault('nolib')}
        onHttpError={() => setFault((f) => f ?? 'notiles')}
        onMessage={(e) => {
          try {
            const msg = JSON.parse(e.nativeEvent.data);
            if (msg.type === 'nolib') { setFault('nolib'); return; }
            if (msg.type === 'notiles') { setFault((f) => (f === 'nolib' ? f : 'notiles')); return; }
            if (msg.type === 'marker' && msg.id) { onMarkerPress?.(String(msg.id)); return; }
            if (onPick && typeof msg.lat === 'number') onPick(msg.lat, msg.lng);
          } catch { /* تجاهل */ }
        }}
      />
      {fault === 'nolib' ? (
        <View style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: C.paper,
          alignItems: 'center', justifyContent: 'center', padding: 22, gap: 12,
        }}>
          <T size={TYPE.body} center color={C.charcoal}>
            تعذّر تشغيل الخريطة
          </T>
          <BtnGhost small icon="reload" title="إعادة المحاولة"
            onPress={() => { setFault(null); setAttempt((a) => a + 1); }} />
        </View>
      ) : null}
    </View>
  );
}
