#!/usr/bin/env node
/**
 * ق٠-٨ · فحص «لا اتصال بقوقل» (الشرط ١٣ في F-الاستقلال-عن-قوقل.md §٦): يقرأ حركة المحاكي المسجّلة (emulator -tcpdump، ملف pcap)
 * ويستخرج كل اسمٍ طلبه الجوال: سؤال DNS (UDP وTCP)، واسم الخادم في مصافحة TLS (SNI)، وترويسة Host في HTTP المكشوف ·
 * ثم يصنّف ما كان من نطاقات قوقل. جافاسكربت خالصة بلا tshark ولا حزم: النتيجة نفسها لكل ملفٍ على كل جهاز.
 *
 * النافذة: الحركة قبل أول سؤال DNS عن اسم العلامة (يرسله e2e/run.sh قبل تثبيت التطبيق) هي إقلاع أندرويد، تُذكر ولا يُحكم بها ·
 * وغياب العلامة يعني أن التسجيل لم يرَ حركة الجوال، فلا يُعدّ «نظيفاً» · وعلامة الختام (يرسلها run.sh بعد التدفقات كلها) تُطلب بعد
 * الأولى: غيابها يعني أن حركة الجوال خرجت من التسجيل أثناء التدفقات (Wi-Fi المحاكي يمرّ بـnetsim خارج -tcpdump)، فلا يُعدّ نظيفاً كذلك.
 *
 * الأصناف داخل النافذة:
 *  - system: نقاط أندرويد نفسه (فحص الاتصال والوقت)، لا التطبيق · تُطفأ في run.sh وتُذكر إن ظهرت ولا تُسقط.
 *  - pending: اتصالٌ معروف للحزمة الحالية بموعد إزالته في الخطة (ML Kit · F-2) · يُذكر بالاسم كل تشغيل، ويُسقط في strict.
 *  - webview: حزمة WebView في النظام (لا كود التطبيق) تطلب بذرة التجارب وتحديث مكوّناتها مرةً عند أول WebView يفتحه أي تطبيق
 *    (الخريطة هنا) · رآها أول تشغيلٍ حقيقي للنافذة (9c9d182، الحزمة 102 بعد ثانيةٍ من بدء webview_service) · تُذكر ولا تُسقط إلا في strict.
 *  - app: كل نطاق قوقل سواهما · يُسقط في enforce وstrict.
 * الأوضاع (NO_GOOGLE_MODE أو --mode): report لا يُسقط أبداً · enforce (الآن) · strict (بعد إزالة ML Kit، وفي التحويل م٥).
 *
 * الاستعمال: node scripts/ci/noGoogle.js --pcap <ملف> [--mode enforce] [--marker <اسم>] [--end-marker <اسم>] [--out <ملف>]
 */
const fs = require('fs');

const MARKER = 'aqari-e2e-window.example.com';
const END_MARKER = 'aqari-e2e-window-end.example.com';
const MODES = ['report', 'enforce', 'strict'];

// نطاقات قوقل: لاحقة اسمٍ كاملة، أو مقطعٌ من الاسم بعينه، أو مقطعٌ يبدأ بـfirebase (الشرط ١٣: google وgoogleapis وgstatic وfirebase*
// وgvt1 وapp-measurement وcrashlytics وdoubleclick، وما يلحق بها)
const GOOGLE_LABELS = new Set([
  'google', 'googleapis', 'gstatic', 'gvt1', 'gvt2', 'gvt3', 'ggpht', 'googleusercontent', 'googlevideo', 'googlesyndication',
  'googleadservices', 'google-analytics', 'googletagmanager', 'googletagservices', 'app-measurement', 'crashlytics', 'doubleclick',
  '1e100', 'withgoogle', 'youtube', 'ytimg',
]);
const GOOGLE_SUFFIXES = ['android.com', 'goo.gl', 'g.co', 'web.app', 'page.link', 'app.goo.gl', 'fabric.io', 'admob.com'];

// أندرويد نفسه لا التطبيق: فحص الاتصال (يُطفأ بـcaptive_portal_mode 0 في run.sh) والوقت · مطابقة تامة أو لاحقة
const SYSTEM = [
  { host: 'connectivitycheck.gstatic.com', why: 'فحص الاتصال في أندرويد' },
  { host: 'connectivitycheck.android.com', why: 'فحص الاتصال في أندرويد' },
  { host: 'metric.gstatic.com', suffix: true, why: 'فحص DNS الخاص في أندرويد' },
  { host: 'time.android.com', why: 'وقت الشبكة في أندرويد' },
];
// حزمة WebView في النظام، يطلبها أول WebView في أي تطبيق لا كود التطبيق: بذرة التجارب (variations) ومحدّث المكوّنات
const WEBVIEW = [
  { host: 'clientservices.googleapis.com', why: 'بذرة تجارب WebView في النظام (variations) عند أول خريطة' },
  { host: 'update.googleapis.com', why: 'محدّث مكوّنات WebView في النظام عند أول خريطة' },
];
// معروفٌ للحزمة الحالية وموعد إزالته في الخطة · يُذكر كل تشغيل، ويُسقط في strict · القائمة تقصر ولا تطول
const PENDING = [
  { host: 'firebaselogging.googleapis.com', why: 'ناقل سجلات ML Kit (F-2) · يزول مع ق٠-٣ وق٠-٤' },
  { host: 'firebaselogging-pa.googleapis.com', why: 'ناقل سجلات ML Kit (F-2) · يزول مع ق٠-٣ وق٠-٤' },
];

function normHost(h) {
  return String(h || '').trim().toLowerCase().replace(/\.$/, '');
}

function isGoogleHost(host) {
  const h = normHost(host);
  if (!h) return false;
  const labels = h.split('.');
  if (labels.some((l) => GOOGLE_LABELS.has(l) || l.startsWith('firebase'))) return true;
  return GOOGLE_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

function listed(list, host) {
  const h = normHost(host);
  return list.find((e) => h === e.host || (e.suffix && h.endsWith('.' + e.host))) || null;
}

/** صنف اسمٍ من قوقل: system أو webview أو pending أو app · وnull لما ليس من قوقل */
function classify(host) {
  if (!isGoogleHost(host)) return null;
  if (listed(SYSTEM, host)) return 'system';
  if (listed(WEBVIEW, host)) return 'webview';
  if (listed(PENDING, host)) return 'pending';
  return 'app';
}

/* ───────── قراءة pcap (الصيغة الكلاسيكية: ميكرو أو نانو ثانية، بأي ترتيب بايتات) ───────── */

function parsePcap(buf) {
  if (buf.length < 24) throw new Error('ليس ملف pcap: أقصر من الترويسة');
  const m = buf.readUInt32LE(0);
  let le;
  if (m === 0xa1b2c3d4 || m === 0xa1b23c4d) le = true;
  else if (m === 0xd4c3b2a1 || m === 0x4d3cb2a1) le = false;
  else if (m === 0x0a0d0d0a) throw new Error('صيغة pcapng غير مدعومة: emulator -tcpdump يكتب pcap الكلاسيكية');
  else throw new Error('ليس ملف pcap: توقيع 0x' + m.toString(16));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const linktype = u32(20) & 0x0fffffff;
  const packets = [];
  let off = 24;
  let truncated = false;
  while (off < buf.length) {
    if (off + 16 > buf.length) { truncated = true; break; }
    const incl = u32(off + 8);
    if (incl > 0x4000000 || off + 16 + incl > buf.length) { truncated = true; break; }
    packets.push(buf.subarray(off + 16, off + 16 + incl));
    off += 16 + incl;
  }
  return { linktype, packets, truncated };
}

/** حزمة IP من إطار طبقة الربط · null لما سواها */
function ipOf(linktype, frame) {
  let p = frame;
  let type;
  if (linktype === 1) { // Ethernet
    if (p.length < 14) return null;
    type = p.readUInt16BE(12);
    let o = 14;
    while ((type === 0x8100 || type === 0x88a8) && p.length >= o + 4) { type = p.readUInt16BE(o + 2); o += 4; }
    p = p.subarray(o);
  } else if (linktype === 113) { // Linux cooked
    if (p.length < 16) return null;
    type = p.readUInt16BE(14);
    p = p.subarray(16);
  } else if (linktype === 0) { // loopback
    if (p.length < 4) return null;
    const fam = p.readUInt32LE(0) === 2 || p.readUInt32BE(0) === 2 ? 4 : 6;
    type = fam === 4 ? 0x0800 : 0x86dd;
    p = p.subarray(4);
  } else if (linktype === 101 || linktype === 228 || linktype === 229) { // IP خام
    if (p.length < 1) return null;
    type = p[0] >> 4 === 4 ? 0x0800 : 0x86dd;
  } else {
    throw new Error('نوع ربطٍ غير مدعوم: ' + linktype);
  }
  if (type === 0x0800) {
    if (p.length < 20 || p[0] >> 4 !== 4) return null;
    const ihl = (p[0] & 0x0f) * 4;
    const total = Math.min(p.readUInt16BE(2), p.length);
    if ((p.readUInt16BE(6) & 0x1fff) !== 0) return null; // جزءٌ غير أول من حزمة مجزأة
    const src = [...p.subarray(12, 16)].join('.');
    const dst = [...p.subarray(16, 20)].join('.');
    return { proto: p[9], src, dst, payload: p.subarray(ihl, total) };
  }
  if (type === 0x86dd) {
    if (p.length < 40 || p[0] >> 4 !== 6) return null;
    const hex = (b) => [0, 2, 4, 6, 8, 10, 12, 14].map((i) => b.readUInt16BE(i).toString(16)).join(':');
    let next = p[6];
    let o = 40;
    const end = Math.min(40 + p.readUInt16BE(4), p.length);
    while ([0, 43, 60, 44].includes(next) && o + 8 <= end) {
      const len = next === 44 ? 8 : (p[o + 1] + 1) * 8;
      if (next === 44 && (p.readUInt16BE(o + 2) & 0xfff8) !== 0) return null;
      next = p[o];
      o += len;
    }
    return { proto: next, src: hex(p.subarray(8, 24)), dst: hex(p.subarray(24, 40)), payload: p.subarray(o, end) };
  }
  return null;
}

/* ───────── DNS ───────── */

function readName(msg, off) {
  const labels = [];
  let jumps = 0;
  let o = off;
  let end = -1;
  for (;;) {
    if (o >= msg.length) return null;
    const len = msg[o];
    if (len === 0) { if (end < 0) end = o + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (o + 1 >= msg.length || ++jumps > 16) return null;
      if (end < 0) end = o + 2;
      o = ((len & 0x3f) << 8) | msg[o + 1];
      continue;
    }
    if (len > 63 || o + 1 + len > msg.length) return null;
    labels.push(msg.subarray(o + 1, o + 1 + len).toString('latin1'));
    o += 1 + len;
  }
  return { name: labels.join('.'), end };
}

/** أسماء الأسئلة في رسالة DNS (سؤالاً كانت أو جواباً) */
function dnsQuestions(msg) {
  if (msg.length < 12) return [];
  const qd = msg.readUInt16BE(4);
  if (qd === 0 || qd > 16) return [];
  const out = [];
  let o = 12;
  for (let i = 0; i < qd; i++) {
    const n = readName(msg, o);
    if (!n || n.end + 4 > msg.length) break;
    if (n.name) out.push(n.name);
    o = n.end + 4;
  }
  return out;
}

/* ───────── TLS وHTTP ───────── */

/** اسم الخادم (SNI) من بداية مجرى TLS من العميل · null إن لم يكن ClientHello أو لم يكتمل */
function tlsSni(stream) {
  // مقاطع المصافحة من سجلات TLS المتتالية (قد تتجزأ ClientHello على سجلين)
  const parts = [];
  let o = 0;
  while (o + 5 <= stream.length && stream[o] === 0x16) {
    const len = stream.readUInt16BE(o + 3);
    parts.push(stream.subarray(o + 5, Math.min(o + 5 + len, stream.length)));
    o += 5 + len;
  }
  const hs = Buffer.concat(parts);
  if (hs.length < 4 || hs[0] !== 0x01) return null;
  const body = hs.subarray(4, 4 + hs.readUIntBE(1, 3));
  let p = 2 + 32;
  if (p + 1 > body.length) return null;
  p += 1 + body[p];
  if (p + 2 > body.length) return null;
  p += 2 + body.readUInt16BE(p);
  if (p + 1 > body.length) return null;
  p += 1 + body[p];
  if (p + 2 > body.length) return null;
  const extEnd = Math.min(p + 2 + body.readUInt16BE(p), body.length);
  p += 2;
  while (p + 4 <= extEnd) {
    const type = body.readUInt16BE(p);
    const len = body.readUInt16BE(p + 2);
    const data = body.subarray(p + 4, p + 4 + len);
    if (type === 0 && data.length >= 5) {
      let q = 2;
      while (q + 3 <= data.length) {
        const nt = data[q];
        const nl = data.readUInt16BE(q + 1);
        if (nt === 0 && q + 3 + nl <= data.length) return data.subarray(q + 3, q + 3 + nl).toString('latin1');
        q += 3 + nl;
      }
    }
    p += 4 + len;
  }
  return null;
}

const HTTP_METHOD = /^(GET|POST|HEAD|PUT|DELETE|PATCH|OPTIONS|CONNECT) (\S+) HTTP\/1\.[01]\r\n/;

function httpHost(stream) {
  const head = stream.subarray(0, 8192).toString('latin1');
  const m = HTTP_METHOD.exec(head);
  if (!m) return null;
  const h = /\r\nhost:[ \t]*([^\r\n]+)/i.exec(head);
  const host = h ? h[1] : m[1] === 'CONNECT' ? m[2] : '';
  return host.trim().replace(/:\d+$/, '').replace(/^\[|\]$/g, '') || null;
}

/* ───────── التجميع ───────── */

/**
 * كل اسمٍ في الحركة بترتيب ظهوره: { host, kind: dns|sni|http, at: رقم الحزمة } · ومجاري TCP تُجمّع من مقاطعها بترتيب أرقامها
 * (المصافحة الطويلة تتجزأ على مقطعين أو أكثر، وقد تصل بغير ترتيبها)
 */
function extractNames(pcap) {
  const events = [];
  const flows = new Map();
  let quic = 0;
  pcap.packets.forEach((frame, i) => {
    const ip = ipOf(pcap.linktype, frame);
    if (!ip) return;
    const t = ip.payload;
    if (ip.proto === 17 && t.length >= 8) {
      const sport = t.readUInt16BE(0);
      const dport = t.readUInt16BE(2);
      if (sport === 53 || dport === 53) for (const host of dnsQuestions(t.subarray(8))) events.push({ host, kind: 'dns', at: i });
      else if (dport === 443) quic++;
      return;
    }
    if (ip.proto !== 6 || t.length < 20) return;
    const sport = t.readUInt16BE(0);
    const dport = t.readUInt16BE(2);
    const seq = t.readUInt32BE(4);
    const doff = (t[12] >> 4) * 4;
    const syn = (t[13] & 0x02) !== 0;
    const key = ip.src + ':' + sport + '>' + ip.dst + ':' + dport;
    let f = flows.get(key);
    if (!f) { f = { sport, dport, base: null, segs: [], at: i }; flows.set(key, f); }
    if (syn) f.base = (seq + 1) >>> 0;
    const data = t.subarray(doff);
    if (data.length) { if (!f.segs.length) f.at = i; f.segs.push({ seq, data }); }
  });
  for (const f of flows.values()) {
    if (!f.segs.length) continue;
    const base = f.base ?? f.segs.reduce((m, s) => (((s.seq - m) | 0) < 0 ? s.seq : m), f.segs[0].seq);
    const placed = f.segs.map((s) => ({ off: (s.seq - base) | 0, data: s.data })).filter((s) => s.off >= 0 && s.off < 65536)
      .sort((a, b) => a.off - b.off);
    const chunks = [];
    let have = 0;
    for (const s of placed) {
      if (s.off > have) break;
      if (s.off + s.data.length <= have) continue;
      chunks.push(s.data.subarray(have - s.off));
      have = s.off + s.data.length;
    }
    const stream = Buffer.concat(chunks);
    if (!stream.length) continue;
    if (f.sport === 53 || f.dport === 53) {
      let o = 0;
      while (o + 2 <= stream.length) {
        const len = stream.readUInt16BE(o);
        for (const host of dnsQuestions(stream.subarray(o + 2, o + 2 + len))) events.push({ host, kind: 'dns', at: f.at });
        o += 2 + len;
      }
      continue;
    }
    const sni = stream[0] === 0x16 ? tlsSni(stream) : null;
    if (sni) { events.push({ host: sni, kind: 'sni', at: f.at }); continue; }
    const http = httpHost(stream);
    if (http) events.push({ host: http, kind: 'http', at: f.at });
  }
  events.sort((a, b) => a.at - b.at);
  return { events, quic };
}

/**
 * الحكم على تسجيلٍ واحد · pcapBuf ‏null حين غاب الملف
 * @returns {{ verdict: 'pass'|'fail'|'report', lines: string[] }}
 */
function analyze({ pcapBuf, mode = 'enforce', marker = MARKER, endMarker = END_MARKER, source = 'capture' }) {
  if (!MODES.includes(mode)) throw new Error('وضعٌ غير معروف: ' + mode + ' (' + MODES.join('|') + ')');
  const problems = [];
  const body = [];
  let parsed = null;
  if (!pcapBuf) problems.push('لا تسجيل للحركة: ' + source);
  else {
    try { parsed = parsePcap(pcapBuf); } catch (e) { problems.push('تسجيلٌ لا يُقرأ: ' + e.message); }
  }
  if (parsed) {
    const { events, quic } = extractNames(parsed);
    const m = normHost(marker);
    const start = events.find((e) => e.kind === 'dns' && normHost(e.host) === m);
    body.push('capture ' + source + ' · packets ' + parsed.packets.length + (parsed.truncated ? ' · truncated' : ''));
    const em = normHost(endMarker);
    const end = start ? events.find((e) => e.kind === 'dns' && normHost(e.host) === em && e.at >= start.at) : null;
    if (!start) problems.push('علامة النافذة ' + marker + ' لم تظهر: التسجيل لم يرَ حركة الجوال، فلا يُعدّ نظيفاً');
    else {
      body.push('window from packet ' + start.at + ' (marker ' + marker + ')');
      if (!end) problems.push('علامة الختام ' + endMarker + ' لم تظهر بعد علامة النافذة: حركة الجوال خرجت من التسجيل أثناء التدفقات، فلا يُعدّ نظيفاً');
      else body.push('window end at packet ' + end.at + ' (marker ' + endMarker + ')');
    }
    const groups = { app: new Map(), pending: new Map(), webview: new Map(), system: new Map(), boot: new Map() };
    for (const e of events) {
      const h = normHost(e.host);
      if (h === m || h === em) continue;
      const cls = classify(h);
      if (!cls) continue;
      const g = !start || e.at >= start.at ? groups[cls] : groups.boot;
      const cur = g.get(h) || new Set();
      cur.add(e.kind);
      g.set(h, cur);
    }
    const why = (list, h) => (listed(list, h) || {}).why || '';
    const fmt = (tag, g, list) => [...g.keys()].sort().map((h) => tag + ' ' + h + ' (' + [...g.get(h)].sort().join(',') + ')' +
      (list ? ' · ' + why(list, h) : ''));
    body.push(...fmt('app', groups.app), ...fmt('pending', groups.pending, PENDING), ...fmt('webview', groups.webview, WEBVIEW), ...fmt('system', groups.system, SYSTEM),
      ...fmt('boot', groups.boot));
    if (quic) body.push('quic-packets ' + quic + ' (UDP 443: الاسم في سؤال DNS قبلها)');
    if (groups.app.size) problems.push('نطاقات قوقل من التطبيق: ' + [...groups.app.keys()].sort().join(' '));
    if (mode === 'strict' && groups.pending.size) problems.push('نطاقات قوقل المؤجلة في الوضع الصارم: ' + [...groups.pending.keys()].sort().join(' '));
    if (mode === 'strict' && groups.webview.size) problems.push('نطاقات WebView النظام في الوضع الصارم: ' + [...groups.webview.keys()].sort().join(' '));
  }
  const verdict = mode === 'report' ? 'report' : problems.length ? 'fail' : 'pass';
  const lines = ['no-google ' + verdict + ' · mode ' + mode, ...body, ...problems.map((p) => 'problem ' + p)];
  return { verdict, lines };
}

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

if (require.main === module) {
  const pcapPath = arg('pcap', '');
  const mode = arg('mode', process.env.NO_GOOGLE_MODE || 'enforce');
  const out = arg('out', '');
  let pcapBuf = null;
  try { pcapBuf = pcapPath ? fs.readFileSync(pcapPath) : null; } catch { pcapBuf = null; }
  let res;
  try {
    res = analyze({ pcapBuf, mode, marker: arg('marker', MARKER), endMarker: arg('end-marker', END_MARKER), source: pcapPath || '(none)' });
  } catch (e) {
    res = { verdict: mode === 'report' ? 'report' : 'fail', lines: ['no-google ' + (mode === 'report' ? 'report' : 'fail') + ' · mode ' + mode, 'problem ' + e.message] };
  }
  const text = res.lines.join('\n') + '\n';
  if (out) fs.writeFileSync(out, text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### لا اتصال بقوقل (الشرط ١٣)\n\n```\n' + text + '```\n'); } catch { /* الخلاصة زينة */ }
  }
  process.stdout.write(text);
  if (res.verdict === 'fail') process.exit(1);
}

module.exports = { MARKER, END_MARKER, MODES, SYSTEM, WEBVIEW, PENDING, isGoogleHost, classify, parsePcap, extractNames, tlsSni, dnsQuestions, analyze };
