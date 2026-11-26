/**
 * ق٠-٨ · بنّاء حزمٍ مصطنعة لاختبار scripts/ci/noGoogle.js: pcap كلاسيكية بإطارات Ethernet أو IP خام، وIPv4/IPv6، وUDP/TCP،
 * وأسئلة DNS ومصافحة TLS (ClientHello) بـSNI · لا شبكة ولا بيانات حقيقية، والعناوين من النطاقات الخاصة والتوثيقية.
 */

export function u16(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }

export function pcapFile(frames: Buffer[], opts: { linktype?: number; ns?: boolean; bigEndian?: boolean } = {}): Buffer {
  const be = !!opts.bigEndian;
  const w32 = (n: number) => { const b = Buffer.alloc(4); if (be) b.writeUInt32BE(n >>> 0); else b.writeUInt32LE(n >>> 0); return b; };
  const w16 = (n: number) => { const b = Buffer.alloc(2); if (be) b.writeUInt16BE(n); else b.writeUInt16LE(n); return b; };
  const head = Buffer.concat([w32(opts.ns ? 0xa1b23c4d : 0xa1b2c3d4), w16(2), w16(4), w32(0), w32(0), w32(65535), w32(opts.linktype ?? 1)]);
  const recs = frames.map((f, i) => Buffer.concat([w32(1767225600 + i), w32(0), w32(f.length), w32(f.length), f]));
  return Buffer.concat([head, ...recs]);
}

export function eth(ip: Buffer, vlan = false): Buffer {
  const v6 = ip[0] >> 4 === 6;
  const mac = Buffer.from([0x52, 0x54, 0x00, 0x12, 0x34, 0x56]);
  const tag = vlan ? Buffer.concat([u16(0x8100), u16(7)]) : Buffer.alloc(0);
  return Buffer.concat([mac, mac, tag, u16(v6 ? 0x86dd : 0x0800), ip]);
}

export function ipv4(src: string, dst: string, proto: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(20);
  h[0] = 0x45; h.writeUInt16BE(20 + payload.length, 2); h[8] = 64; h[9] = proto;
  Buffer.from(src.split('.').map(Number)).copy(h, 12);
  Buffer.from(dst.split('.').map(Number)).copy(h, 16);
  return Buffer.concat([h, payload]);
}

export function ipv6(src: string, dst: string, proto: number, payload: Buffer): Buffer {
  const addr = (a: string) => { const parts = a.split(':'); const b = Buffer.alloc(16); parts.forEach((p, i) => b.writeUInt16BE(parseInt(p || '0', 16), i * 2)); return b; };
  const h = Buffer.alloc(8);
  h[0] = 0x60; h.writeUInt16BE(payload.length, 4); h[6] = proto; h[7] = 64;
  return Buffer.concat([h, addr(src), addr(dst), payload]);
}

export function udp(sport: number, dport: number, payload: Buffer): Buffer {
  return Buffer.concat([u16(sport), u16(dport), u16(8 + payload.length), u16(0), payload]);
}

export const SYN = 0x02;
export const ACK = 0x10;
export const PSH = 0x08;

export function tcp(sport: number, dport: number, seq: number, flags: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(sport, 0); h.writeUInt16BE(dport, 2); h.writeUInt32BE(seq >>> 0, 4);
  h[12] = 5 << 4; h[13] = flags; h.writeUInt16BE(65535, 14);
  return Buffer.concat([h, payload]);
}

function qname(name: string): Buffer {
  return Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'latin1')])), Buffer.from([0])]);
}

export function dnsQuery(name: string, id = 0x1234, type = 1): Buffer {
  return Buffer.concat([u16(id), u16(0x0100), u16(1), u16(0), u16(0), u16(0), qname(name), u16(type), u16(1)]);
}

/** ClientHello بـSNI بعد امتدادٍ حشوٍ بالطول المطلوب (لتتجزأ المصافحة على أكثر من مقطع كما مع مفاتيح ما بعد الكم) */
export function clientHello(sni: string, padding = 0): Buffer {
  const name = Buffer.from(sni, 'latin1');
  const sniData = Buffer.concat([u16(3 + name.length), Buffer.from([0]), u16(name.length), name]);
  const exts = Buffer.concat([
    ...(padding ? [u16(21), u16(padding), Buffer.alloc(padding)] : []),
    u16(0), u16(sniData.length), sniData,
    u16(43), u16(3), Buffer.from([2, 0x03, 0x04]),
  ]);
  const body = Buffer.concat([
    u16(0x0303), Buffer.alloc(32, 7), Buffer.from([0]), u16(2), u16(0x1301), Buffer.from([1, 0]), u16(exts.length), exts,
  ]);
  const hs = Buffer.concat([Buffer.from([1, (body.length >> 16) & 0xff]), u16(body.length & 0xffff), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(hs.length), hs]);
}

export function httpGet(host: string, path = '/'): Buffer {
  return Buffer.from(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: e2e\r\n\r\n`, 'latin1');
}

/* إطارات جاهزة من الجوال (10.0.2.16) إلى خادم DNS في المحاكي (10.0.2.3) وإلى عناوين توثيقية (RFC 5737) */
const PHONE = '10.0.2.16';
export const dnsFrame = (name: string, id = 1) => eth(ipv4(PHONE, '10.0.2.3', 17, udp(40000 + (id % 20000), 53, dnsQuery(name, id))));

export function tlsFrames(sni: string, opts: { port?: number; split?: boolean; reorder?: boolean; padding?: number } = {}): Buffer[] {
  const port = opts.port ?? 50000;
  const isn = 0xfffffff0; // قرب الالتفاف عمداً
  const ch = clientHello(sni, opts.padding ?? 0);
  const wrap = (seg: Buffer) => eth(ipv4(PHONE, '192.0.2.10', 6, seg));
  const frames = [wrap(tcp(port, 443, isn, SYN))];
  if (!opts.split) frames.push(wrap(tcp(port, 443, isn + 1, ACK | PSH, ch)));
  else {
    const cut = Math.floor(ch.length / 2);
    const a = wrap(tcp(port, 443, isn + 1, ACK, ch.subarray(0, cut)));
    const b = wrap(tcp(port, 443, (isn + 1 + cut) >>> 0, ACK | PSH, ch.subarray(cut)));
    frames.push(...(opts.reorder ? [b, a] : [a, b]));
  }
  return frames;
}

export function httpFrames(host: string, port = 51000): Buffer[] {
  const wrap = (seg: Buffer) => eth(ipv4(PHONE, '192.0.2.20', 6, seg));
  return [wrap(tcp(port, 80, 1000, SYN)), wrap(tcp(port, 80, 1001, ACK | PSH, httpGet(host)))];
}

export const MARKER = 'aqari-e2e-window.example.com';

/** تسجيلٌ نظيف: إقلاعٌ فيه قوقل قبل العلامة، ثم العلامة، ثم خرائط OpenStreetMap وفحص اتصالٍ من النظام */
export function cleanCapture(): Buffer {
  return pcapFile([
    dnsFrame('www.google.com', 1),
    ...tlsFrames('www.google.com', { port: 49000 }),
    dnsFrame(MARKER, 2),
    dnsFrame('tile.openstreetmap.org', 3),
    ...tlsFrames('tile.openstreetmap.org', { port: 50001 }),
    dnsFrame('connectivitycheck.gstatic.com', 4),
  ]);
}

/** تسجيلٌ فيه قوقل من التطبيق بعد العلامة: سؤال DNS، وSNI بلا سؤال (مقسوم ومقلوب الترتيب)، وHost في HTTP */
export function googleCapture(): Buffer {
  return pcapFile([
    dnsFrame(MARKER, 2),
    dnsFrame('firestore.googleapis.com', 3),
    ...tlsFrames('www.google.com', { port: 50002, split: true, reorder: true, padding: 1400 }),
    ...httpFrames('fonts.gstatic.com'),
    dnsFrame('tile.openstreetmap.org', 4),
  ]);
}
