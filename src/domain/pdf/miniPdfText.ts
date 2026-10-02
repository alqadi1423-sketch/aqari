/**
 * مستخرج نصوص PDF مصغّر خالص بجافاسكربت · يعمل على محرك Hermes في الجوال
 * (بديل pdf.js الذي لا يعمل هناك). يغطي ملفات PDF المولَّدة رقمياً كعقود إيجار:
 * فك FlateDecode عبر fflate، خرائط ToUnicode (bfchar/bfrange) لفك رموز CID،
 * ومجاري الكائنات المضغوطة ObjStm، وتجميع الأسطر بفارق عمودي > 3 كمنطق النموذج.
 */
import { unzlibSync, inflateSync } from 'fflate';

const latin1 = (b: Uint8Array) => {
  let s = '';
  const CHUNK = 8192;
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode(...b.subarray(i, Math.min(i + CHUNK, b.length)));
  }
  return s;
};

function tryInflate(data: Uint8Array): Uint8Array | null {
  try { return unzlibSync(data); } catch { /* جرّب خام */ }
  try { return inflateSync(data); } catch { return null; }
}

/** فك مرشِّح PNG Predictor (يشيع في مجاري ObjStm/xref بـ /Predictor 12) */
function unpredict(data: Uint8Array, predictor: number, columns: number): Uint8Array {
  if (predictor < 10 || columns <= 0) return data;
  const rowLen = columns + 1;
  const rows = Math.floor(data.length / rowLen);
  const out = new Uint8Array(rows * columns);
  let prev = new Uint8Array(columns);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * rowLen];
    const row = data.subarray(r * rowLen + 1, r * rowLen + 1 + columns);
    const cur = new Uint8Array(columns);
    for (let i = 0; i < columns; i++) {
      const a = i > 0 ? cur[i - 1] : 0;
      const b = prev[i];
      const c = i > 0 ? prev[i - 1] : 0;
      let x = row[i];
      if (ft === 1) x = (x + a) & 0xff;
      else if (ft === 2) x = (x + b) & 0xff;
      else if (ft === 3) x = (x + ((a + b) >> 1)) & 0xff;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        x = (x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[i] = x;
    }
    out.set(cur, r * columns);
    prev = cur;
  }
  return out;
}

interface RawStream {
  dict: string;
  data: Uint8Array;
  objNum: number | null;
}

/** استخراج كل المجاري (dict + بيانات مفكوكة إن كانت Flate) */
function extractStreams(bytes: Uint8Array, raw: string): RawStream[] {
  const out: RawStream[] = [];
  const re = /(?:(\d+)\s+\d+\s+obj\s*)?<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>)*)>>\s*stream(\r\n|\n|\r)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const dict = m[2];
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let data = bytes.subarray(start, end);
    // نزع نهايات الأسطر الزائدة قبل endstream
    while (data.length && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) {
      data = data.subarray(0, data.length - 1);
    }
    if (/\/FlateDecode/.test(dict)) {
      const inflated = tryInflate(data);
      if (!inflated) continue;
      data = inflated;
      const pred = /\/Predictor\s+(\d+)/.exec(dict);
      const cols = /\/Columns\s+(\d+)/.exec(dict);
      if (pred) data = unpredict(data, parseInt(pred[1], 10), cols ? parseInt(cols[1], 10) : 1);
    }
    out.push({ dict, data, objNum: m[1] ? parseInt(m[1], 10) : null });
  }
  return out;
}

/** فك مجرى كائنات ObjStm إلى نص كائناته */
function expandObjStm(s: RawStream): string {
  const n = parseInt(/\/N\s+(\d+)/.exec(s.dict)?.[1] ?? '0', 10);
  const first = parseInt(/\/First\s+(\d+)/.exec(s.dict)?.[1] ?? '0', 10);
  if (!n || !first) return '';
  const text = latin1(s.data);
  const header = text.slice(0, first).trim().split(/\s+/).map(Number);
  let out = '';
  for (let i = 0; i < n; i++) {
    const objNum = header[i * 2];
    const off = header[i * 2 + 1];
    const nextOff = i + 1 < n ? header[(i + 1) * 2 + 1] : text.length - first;
    out += `\n${objNum} 0 obj\n${text.slice(first + off, first + nextOff)}\nendobj\n`;
  }
  return out;
}

type CMap = Map<number, string>;

/** تحليل ToUnicode CMap: bfchar + bfrange */
function parseCMap(text: string): CMap {
  const map: CMap = new Map();
  const hex = (h: string) => parseInt(h, 16);
  const hexToStr = (h: string) => {
    let s = '';
    for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(hex(h.slice(i, i + 4)));
    if (h.length === 2) s += String.fromCharCode(hex(h));
    return s;
  };
  for (const block of text.split('beginbfchar').slice(1)) {
    const body = block.split('endbfchar')[0];
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) map.set(hex(m[1]), hexToStr(m[2]));
  }
  for (const block of text.split('beginbfrange').slice(1)) {
    const body = block.split('endbfrange')[0];
    // <from> <to> <start>  أو  <from> <to> [<c1> <c2> ...]
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[((?:\s*<[0-9A-Fa-f]+>)+)\s*\])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const from = hex(m[1]), to = hex(m[2]);
      if (m[4]) {
        const base = hexToStr(m[4]);
        for (let c = from; c <= to && c - from < 65536; c++) {
          map.set(c, base.slice(0, -1)
            + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - from)));
        }
      } else if (m[5]) {
        const items = [...m[5].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hexToStr(x[1]));
        items.forEach((str, i) => { if (from + i <= to) map.set(from + i, str); });
      }
    }
  }
  return map;
}

/** فك نص حرفي (…) مع محارف الهروب */
function decodeLiteral(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out.push(s.charCodeAt(i)); continue; }
    const n = s[++i];
    if (n === 'n') out.push(10);
    else if (n === 'r') out.push(13);
    else if (n === 't') out.push(9);
    else if (n === 'b') out.push(8);
    else if (n === 'f') out.push(12);
    else if (n === '\\' || n === '(' || n === ')') out.push(n.charCodeAt(0));
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i];
      out.push(parseInt(oct, 8) & 0xff);
    } else if (n !== undefined) out.push(n.charCodeAt(0));
  }
  return out;
}

interface TextItem {
  str: string;
  y: number;
  /** الموضع الأفقي عند بدء العرض (من آخر أمر تموضع) · null إن جُهل */
  x: number | null;
  /** حجم الخط الحالي · للعتبات الهندسية */
  size: number;
}

/** تفكيك أوامر النص في مجرى محتوى */
function extractTextItems(
  content: string,
  fontNameToCMap: Map<string, CMap | null>
): TextItem[] {
  const items: TextItem[] = [];
  let x: number | null = null;
  let y = 0;
  let size = 10;
  let leading = 0;
  let cmap: CMap | null = null;

  // فك مصفوفة بايتات عبر الخريطة الحالية: رمز ثنائي البايت أولاً ثم أحادي ثم كما هو
  const decodeBytes = (bytes: number[]): string => {
    if (!cmap) return String.fromCharCode(...bytes);
    let s = '';
    let i = 0;
    while (i < bytes.length) {
      if (i + 1 < bytes.length) {
        const u2 = cmap.get((bytes[i] << 8) | bytes[i + 1]);
        if (u2 !== undefined) { s += u2; i += 2; continue; }
      }
      const u1 = cmap.get(bytes[i]);
      s += u1 !== undefined ? u1 : String.fromCharCode(bytes[i]);
      i += 1;
    }
    return s;
  };
  const decodeHex = (h: string): string => {
    const clean = h.replace(/[^0-9A-Fa-f]/g, '');
    const bytes: number[] = [];
    for (let i = 0; i + 2 <= clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
    if (clean.length % 2) bytes.push(parseInt(clean[clean.length - 1] + '0', 16));
    return decodeBytes(bytes);
  };
  const decodeLit = (raw: string): string => decodeBytes(decodeLiteral(raw));

  // رموز الأوامر: نمسحها تسلسلياً
  const tokenRe = /\/([A-Za-z0-9_.]+)\s+([\d.]+)\s+Tf|(-?[\d.]+)\s+(-?[\d.]+)\s+(Td|TD)|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(-?[\d.]+)\s+TL|T\*|\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|')|\[((?:[^\[\]\\]|\\.|\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)*)\]\s*TJ|<([0-9A-Fa-f\s]+)>\s*Tj|BT|ET/g;

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(content))) {
    if (m[0] === 'BT') { x = null; y = 0; continue; }
    if (m[0] === 'ET') continue;
    if (m[1] !== undefined) { // Tf
      cmap = fontNameToCMap.get(m[1]) ?? null;
      const sz = parseFloat(m[2]);
      if (sz > 0) size = sz;
      continue;
    }
    if (m[5] === 'Td' || m[5] === 'TD') {
      x = (x ?? 0) + parseFloat(m[3]);
      y += parseFloat(m[4]);
      if (m[5] === 'TD') leading = -parseFloat(m[4]);
      continue;
    }
    if (m[11] !== undefined && m[0].endsWith('Tm')) {
      x = parseFloat(m[10]);
      y = parseFloat(m[11]);
      continue;
    }
    if (m[0].endsWith('TL')) { leading = parseFloat(m[12]); continue; }
    if (m[0] === 'T*') { y -= leading || 12; continue; }
    if (m[13] !== undefined) { // (..) Tj
      const s = decodeLit(m[13]);
      if (s.trim()) items.push({ str: s, y, x, size });
      continue;
    }
    if (m[14] !== undefined) { // [ .. ] TJ · الإزاحة السالبة الكبيرة فجوةٌ مقصودة = مسافة
      let s = '';
      const inner = m[14];
      const partRe = /\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]+)>|(-?[\d.]+)/g;
      let pm: RegExpExecArray | null;
      while ((pm = partRe.exec(inner))) {
        if (pm[3] !== undefined) {
          // بالألف من وحدة النص: ‎-150‎ فأكثر سالباً = فجوة مسافة، وما دونها تقنين حروف
          if (parseFloat(pm[3]) <= -150 && s && !s.endsWith(' ')) s += ' ';
          continue;
        }
        s += pm[1] !== undefined ? decodeLit(pm[1]) : decodeHex(pm[2]);
      }
      if (s.trim()) items.push({ str: s, y, x, size });
      continue;
    }
    if (m[15] !== undefined) { // <hex> Tj
      const s = decodeHex(m[15]);
      if (s.trim()) items.push({ str: s, y, x, size });
    }
  }
  return items;
}

/** ملف PDF محمي بتشفير · لا يمكن استخراج نصه قبل إزالة الحماية */
export class PdfEncrypted extends Error {
  constructor() { super('pdf-encrypted'); this.name = 'PdfEncrypted'; }
}

/** استخراج النص الكامل من بايتات PDF · تجميع سطري بفارق عمودي > 3 */
export function extractPdfText(bytes: Uint8Array): string {
  let raw = latin1(bytes);
  // ملف مشفّر: كل المجاري والنصوص مرمّزة ولن يخرج منها شيء مفهوم
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(raw) || /\/Encrypt\s*<</.test(raw)) throw new PdfEncrypted();
  const streams = extractStreams(bytes, raw);

  // توسيع مجاري الكائنات المضغوطة ليصير كل شيء قابلاً للمسح النصي
  for (const s of streams) {
    if (/\/Type\s*\/ObjStm/.test(s.dict)) raw += expandObjStm(s);
  }

  // خرائط ToUnicode: رقم كائن CMap → الخريطة
  const cmapByObj = new Map<number, CMap>();
  for (const s of streams) {
    const text = latin1(s.data);
    if (text.includes('beginbfchar') || text.includes('beginbfrange')) {
      if (s.objNum != null) cmapByObj.set(s.objNum, parseCMap(text));
    }
  }
  // خطوط: /ToUnicode N 0 R داخل قاموس الخط
  const fontObjToCMap = new Map<number, CMap>();
  {
    const re = /(\d+)\s+0\s+obj\s*<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>)*)>>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      const body = m[2];
      if (!/\/Type\s*\/Font/.test(body)) continue;
      const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(body);
      if (tu) {
        const cm = cmapByObj.get(parseInt(tu[1], 10));
        if (cm) fontObjToCMap.set(parseInt(m[1], 10), cm);
      }
    }
  }
  // أسماء الخطوط في الموارد: /F1 9 0 R → خريطة الاسم
  const fontNameToCMap = new Map<string, CMap | null>();
  {
    const re = /\/([A-Za-z0-9_.]+)\s+(\d+)\s+0\s+R/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      const cm = fontObjToCMap.get(parseInt(m[2], 10));
      if (cm) fontNameToCMap.set(m[1], cm);
    }
  }

  // مجاري المحتوى: كل مجرى فيه أوامر نص
  const pages: TextItem[][] = [];
  for (const s of streams) {
    if (/\/Type\s*\/ObjStm/.test(s.dict)) continue;
    const text = latin1(s.data);
    if (!/\bBT\b/.test(text) || !/(Tj|TJ|')/.test(text)) continue;
    const items = extractTextItems(text, fontNameToCMap);
    if (items.length) pages.push(items);
  }

  // التجميع: نبني نصّين · هندسي يحسب الفجوات الأفقية، وبديل يفصل بين كل قطعتين ·
  // ثم نختار الأقرب لكلام عربي طبيعي (كلمات ٢-٨ أحرف تنتهي بمسافة)
  const arabicScore = (t: string): number => (t.match(/[\u0600-\u06FF]{2,8}(?=\s|$)/g) || []).length;
  const estWidth = (it: TextItem): number => it.str.length * it.size * 0.5;
  let all = '';
  for (const items of pages) {
    let geo = '';
    let alt = '';
    let last: TextItem | null = null;
    for (const it of items) {
      if (last !== null && Math.abs(it.y - last.y) > 3) {
        geo += '\n';
        alt += '\n';
      } else if (last !== null) {
        alt += ' ';
        // فجوة أفقية بين قطعتين على نفس السطر ⇒ مسافة (العرض مقدَّر: حرف ≈ نصف حجم الخط)
        if (it.x !== null && last.x !== null && !geo.endsWith(' ')) {
          const gap = Math.abs(it.x - last.x) - estWidth(last);
          if (gap > it.size * 0.2) geo += ' ';
        }
      }
      geo += it.str;
      alt += it.str;
      last = it;
    }
    // البديل لا يفوز إلا بنتيجة أعلى صراحةً · فتبقى الملفات السليمة كما هي
    all += (arabicScore(alt) > arabicScore(geo) ? alt : geo) + '\n';
  }
  return all;
}
