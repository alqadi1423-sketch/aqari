/**
 * صورٌ مصطنعة لرمز QR فاتورةٍ كما يصوّرها جوال (ق٠-٣): الرمز من qrcode-generator (المكتبة التي يطبع بها التطبيق رموز فواتيره)،
 * يُرسم بكسلاً بكسلاً على ورقةٍ بإضاءةٍ متدرجة وسطورٍ كالنص، مدوَّراً ومكبَّراً ومائلاً قليلاً، ثم يُصغَّر كما يصغّر المصغِّر الأصلي
 * (متوسط المساحة)، ويُغبَّش، ويُضاف ضجيج الحساس · ثم PNG بمرشّحاته الخمسة كما يحفظه المصغِّر · مولّدٌ عشوائيٌّ ببذرة فالنتيجة ثابتة.
 * بيانات مصطنعة وحدها.
 */
import qrFactory from 'qrcode-generator';
import { zlibSync } from 'fflate';

export interface Img { width: number; height: number; data: Uint8ClampedArray }

/** مولّدٌ ثابت البذرة (mulberry32) */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => { const u = Math.max(next(), 1e-12), v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  return { next, gauss };
}

/** مصفوفة وحدات الرمز (true داكنة) · بايتات UTF-8 كما يكتبها التطبيق */
export function qrMatrix(text: string, ec: 'L' | 'M' | 'Q' | 'H' = 'M'): boolean[][] {
  const qr = qrFactory(0, ec);
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

export interface Placement {
  /** مركز الرمز نسبةً إلى الصورة */
  cx: number; cy: number;
  /** عرض الرمز (بلا هامشه) بالبكسل */
  size: number;
  /** الدوران بالدرجات */
  angle: number;
  /** ميلٌ (قصّ) خفيفٌ كتصويرٍ غير عمودي */
  shear?: number;
  matrix: boolean[][];
}

export interface PhotoOpts {
  width: number; height: number;
  codes: Placement[];
  seed: number;
  /** سطورٌ داكنة كنص الفاتورة حول الرمز */
  textLines?: boolean;
  /** أشد الإضاءة وأضعفها على الورقة */
  light?: [number, number];
  /** لون الحبر (٠ أسود) */
  ink?: number;
}

/** الصورة «كما التقطها الحساس» بدقته الكاملة */
export function renderPhoto(o: PhotoOpts): Img {
  const { width: W, height: H } = o;
  const r = rng(o.seed);
  const data = new Uint8ClampedArray(W * H * 4);
  const [hi, lo] = o.light ?? [238, 150];
  const ink = o.ink ?? 25;
  // سطورٌ أفقية متقطعة كالنص: [y, x0, x1, سماكة]
  const lines: Array<[number, number, number, number]> = [];
  if (o.textLines) {
    for (let y = Math.round(H * 0.04); y < H * 0.97; y += Math.round(H * 0.022 + r.next() * H * 0.01)) {
      let x = Math.round(W * 0.06);
      while (x < W * 0.94) {
        const w = Math.round(W * (0.02 + r.next() * 0.09));
        lines.push([y, x, Math.min(x + w, Math.round(W * 0.94)), Math.max(2, Math.round(H * 0.006))]);
        x += w + Math.round(W * (0.01 + r.next() * 0.02));
      }
    }
  }
  // لكل رمز: تحويلٌ عكسي من بكسل الصورة إلى إحداثي الوحدات
  const inv = o.codes.map((c) => {
    const n = c.matrix.length;
    const a = (c.angle * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a), sh = c.shear ?? 0;
    const unit = c.size / n;
    const cx = c.cx * W, cy = c.cy * H;
    // الهامش الأبيض (أربع وحدات) يمسح ما تحته من سطور
    return { n, cos, sin, sh, unit, cx, cy, m: c.matrix };
  });
  // مقاطع النص لكل سطر بكسلات
  const rows: Array<Array<[number, number]>> = Array.from({ length: H }, () => []);
  for (const [ly, x0, x1, th] of lines) for (let y = ly; y < ly + th && y < H; y++) rows[y].push([x0, x1]);
  for (let y = 0; y < H; y++) {
    const spans = rows[y];
    for (let x = 0; x < W; x++) {
      // إضاءةٌ متدرجة قطرياً، وظلٌّ ناعم
      const t = (x / W) * 0.55 + (y / H) * 0.45;
      let v = hi - (hi - lo) * t;
      let paper = true;
      for (const q of inv) {
        const dx = x - q.cx, dy = y - q.cy;
        let u = (dx * q.cos + dy * q.sin) / q.unit;
        const w = (-dx * q.sin + dy * q.cos) / q.unit;
        u -= q.sh * w;
        const col = Math.floor(u + q.n / 2), row = Math.floor(w + q.n / 2);
        if (col >= -4 && row >= -4 && col < q.n + 4 && row < q.n + 4) {
          paper = false;
          if (col >= 0 && row >= 0 && col < q.n && row < q.n && q.m[row][col]) v = ink + (v - ink) * 0.04;
          break;
        }
      }
      if (paper && spans.length) {
        for (const [x0, x1] of spans) if (x >= x0 && x < x1) { v = ink + 30; break; }
      }
      const o4 = (y * W + x) * 4;
      // ورقٌ مائلٌ إلى الصفرة قليلاً
      data[o4] = v; data[o4 + 1] = v * 0.98; data[o4 + 2] = v * 0.9; data[o4 + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

/** تصغيرٌ بمتوسط المساحة حتى يصير الضلع الأطول long (كما يصغّر المصغِّر الأصلي بتنعيم) */
export function downscale(img: Img, long: number): Img {
  const f = Math.max(img.width, img.height) / long;
  if (f <= 1) return img;
  const W = Math.round(img.width / f), H = Math.round(img.height / f);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * f), y1 = Math.max(y0 + 1, Math.floor((y + 1) * f));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * f), x1 = Math.max(x0 + 1, Math.floor((x + 1) * f));
      let s0 = 0, s1 = 0, s2 = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < img.height; yy++) {
        for (let xx = x0; xx < x1 && xx < img.width; xx++) {
          const i = (yy * img.width + xx) * 4;
          s0 += img.data[i]; s1 += img.data[i + 1]; s2 += img.data[i + 2]; n++;
        }
      }
      const o = (y * W + x) * 4;
      out[o] = s0 / n; out[o + 1] = s1 / n; out[o + 2] = s2 / n; out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

/** غبش العدسة (صندوقٌ نصف قطره radius) ثم ضجيج الحساس (غاوسي بانحراف sigma) */
export function blurAndNoise(img: Img, radius: number, sigma: number, seed: number): Img {
  const { width: W, height: H } = img;
  const r = rng(seed);
  let src = img.data;
  if (radius > 0) {
    const tmp = new Uint8ClampedArray(src.length), out = new Uint8ClampedArray(src.length);
    for (const [from, to, horiz] of [[src, tmp, true], [tmp, out, false]] as const) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          for (let c = 0; c < 3; c++) {
            let s = 0, n = 0;
            for (let k = -radius; k <= radius; k++) {
              const xx = horiz ? x + k : x, yy = horiz ? y : y + k;
              if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
              s += from[(yy * W + xx) * 4 + c]; n++;
            }
            to[(y * W + x) * 4 + c] = s / n;
          }
          to[(y * W + x) * 4 + 3] = 255;
        }
      }
    }
    src = out;
  }
  const data = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const g = r.gauss() * sigma;
    data[i] = src[i] + g; data[i + 1] = src[i + 1] + g + r.gauss() * sigma * 0.3; data[i + 2] = src[i + 2] + g; data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * PNG بثمانية بتات: RGBA (6) أو RGB (2) أو رمادي (0) · ومرشّح السطر يدور على الخمسة (لا شيء، يسار، فوق، متوسط، Paeth) فيُختبر فكّها كلها ·
 * وidatSplit يقسم البيانات على أكثر من IDAT كما يفعل المرمِّز الأصلي.
 */
export function encodePng(img: Img, color: 0 | 2 | 6 = 6, idatSplit = 3): Uint8Array {
  const ch = color === 6 ? 4 : color === 2 ? 3 : 1;
  const { width: W, height: H } = img;
  const stride = W * ch;
  const px = new Uint8Array(stride * H);
  for (let i = 0, o = 0; i < W * H; i++) {
    const d = img.data;
    if (ch === 1) px[o++] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
    else { px[o++] = d[i * 4]; px[o++] = d[i * 4 + 1]; px[o++] = d[i * 4 + 2]; if (ch === 4) px[o++] = d[i * 4 + 3]; }
  }
  const raw = new Uint8Array((stride + 1) * H);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < H; y++) {
    const f = y % 5;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x];
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? px[(y - 1) * stride + x - ch] : 0;
      const p = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      raw[y * (stride + 1) + 1 + x] = (v - p) & 0xff;
    }
  }
  const z = zlibSync(raw, { level: 6 });
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, W);
  new DataView(ihdr.buffer).setUint32(4, H);
  ihdr[8] = 8; ihdr[9] = color;
  const parts: Uint8Array[] = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  const step = Math.ceil(z.length / idatSplit);
  for (let i = 0; i < z.length; i += step) parts.push(chunk('IDAT', z.subarray(i, i + step)));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** TLV الهيئة من وسومٍ بقيمٍ نصية أو بايتات · Base64 */
export function tlvBase64(pairs: Array<[number, string | Uint8Array]>): string {
  const out: number[] = [];
  for (const [t, v] of pairs) {
    const b = typeof v === 'string' ? Array.from(new TextEncoder().encode(v)) : Array.from(v);
    out.push(t, b.length, ...b);
  }
  return Buffer.from(Uint8Array.from(out)).toString('base64');
}

/** بايتاتٌ مصطنعة ثابتة البذرة (بصمة وتوقيع ومفتاح المرحلة الثانية) */
export function fakeBytes(n: number, seed: number): Uint8Array {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(r.next() * 256));
}
