/**
 * قراءة رموز QR من بكسلات صورة بجافاسكربت خالصة (المراجعة الشاملة 2026-11-13 · F · ٥.٥ الخيار أ · ق٠-٣ · قرار المالك: بلا قوقل):
 * jsQR (Apache-2.0، منسوخٌ في src/vendor/jsqr) بدل ML Kit · بلا وحدة أصلية ولا WebAssembly (Hermes لا يحمله) ولا شبكة.
 * والصورة تصغّرها الخدمة بـexpo-image-manipulator المثبّت أصلاً وتحفظها PNG، فتُفكّ هنا بـfflate الموجود في التطبيق.
 * دوالٌّ خالصة بلا وحدات جهاز، تُختبر على Node بصورٍ مصطنعة (tests/q0_3.qrImage.test.ts).
 */
import { unzlibSync } from 'fflate';
import jsQR, { type QRCode } from '../vendor/jsqr/jsQR';

export interface Rgba { width: number; height: number; data: Uint8ClampedArray }

/** سقف البكسلات لصورةٍ تُفكّ · صورةٌ مصنوعة بأبعادٍ ضخمة لا تستهلك الذاكرة (الخدمة تصغّر قبلها إلى ما دون ٥ ملايين) */
export const MAX_PIXELS = 16_000_000;

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/*
 * لا Math.* في الحلقات الساخنة (لكل بايتٍ أو بكسل): استدعاءٌ لكل بايت يُبطئ Hermes بلا JIT، وفي سياق jest (vm) يمرّ كل وصولٍ إلى
 * Math بطريقٍ بطيء · إزالة الترشيح وحدها نزلت من ٨٤٠ إلى ١٢٠ ms (tests/q0_3.qrImage · التشغيل 45828448066 تجاوز الحدّ بـ٢٢٨٩ ms)
 */
const abs = (v: number) => (v < 0 ? -v : v);
const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : v);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = abs(p - a), pb = abs(p - b), pc = abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * PNG إلى RGBA بثمانية بتات · الأنواع كلها (رمادي، ملوّن، بلوحة، بشفافية) بعمق ١ إلى ١٦ بتاً، بلا تشابك (Adam7) وهو ما لا ينتجه
 * المصغِّر · ويرمي «png» لما ليس PNG أو تالفٌ أو أكبر من السقف · والشفافية تُهمل: الرمز يُقرأ من السطوع.
 */
export function decodePng(bytes: Uint8Array): Rgba {
  if (bytes.length < 33 || SIG.some((v, i) => bytes[i] !== v)) throw new Error('png');
  let width = 0, height = 0, depth = 0, color = -1, interlace = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  for (let i = 8; i + 8 <= bytes.length;) {
    const len = u32(bytes, i);
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const start = i + 8;
    if (start + len > bytes.length) throw new Error('png');
    const body = bytes.subarray(start, start + len);
    if (type === 'IHDR') {
      width = u32(body, 0); height = u32(body, 4); depth = body[8]; color = body[9]; interlace = body[12];
    } else if (type === 'PLTE') palette = body;
    else if (type === 'IDAT') { idat.push(body); idatLen += len; }
    else if (type === 'IEND') break;
    i = start + len + 4;
  }
  const ch = CHANNELS[color];
  if (!width || !height || !ch || ![1, 2, 4, 8, 16].includes(depth) || interlace !== 0 || !idatLen) throw new Error('png');
  if (width * height > MAX_PIXELS) throw new Error('png');
  if (color === 3 && !palette) throw new Error('png');
  const z = new Uint8Array(idatLen);
  { let o = 0; for (const part of idat) { z.set(part, o); o += part.length; } }
  let raw: Uint8Array;
  try { raw = unzlibSync(z); } catch { throw new Error('png'); }
  const bpp = Math.max(1, (ch * depth) >> 3);
  const stride = Math.ceil((width * ch * depth) / 8);
  if (raw.length < (stride + 1) * height) throw new Error('png');
  // إزالة الترشيح في المكان نفسه: كل سطرٍ بعد بايت نوعه · حلقةٌ لكل نوع (لا تفرّعٌ لكل بايت: Hermes بلا JIT)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const row = y * (stride + 1) + 1;
    const prev = row - stride - 1;
    const first = y === 0;
    if (f === 0) continue;
    if (f === 1) {
      for (let x = bpp; x < stride; x++) raw[row + x] = raw[row + x] + raw[row + x - bpp];
    } else if (f === 2) {
      if (!first) for (let x = 0; x < stride; x++) raw[row + x] = raw[row + x] + raw[prev + x];
    } else if (f === 3) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? raw[row + x - bpp] : 0, b = first ? 0 : raw[prev + x];
        raw[row + x] = raw[row + x] + ((a + b) >> 1);
      }
    } else if (f === 4) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? raw[row + x - bpp] : 0, b = first ? 0 : raw[prev + x], c = x >= bpp && !first ? raw[prev + x - bpp] : 0;
        raw[row + x] = raw[row + x] + paeth(a, b, c);
      }
    } else throw new Error('png');
  }
  const out = new Uint8ClampedArray(width * height * 4);
  if (depth === 8 && color !== 3) {
    // المسار الشائع (المصغِّر يحفظ RGBA أو RGB بثمانية بتات)
    for (let y = 0, o = 0; y < height; y++) {
      let i = y * (stride + 1) + 1;
      if (ch === 4) for (let x = 0; x < width; x++, o += 4, i += 4) { out[o] = raw[i]; out[o + 1] = raw[i + 1]; out[o + 2] = raw[i + 2]; out[o + 3] = 255; }
      else if (ch === 3) for (let x = 0; x < width; x++, o += 4, i += 3) { out[o] = raw[i]; out[o + 1] = raw[i + 1]; out[o + 2] = raw[i + 2]; out[o + 3] = 255; }
      else for (let x = 0; x < width; x++, o += 4, i += ch) { const g = raw[i]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255; }
    }
    return { width, height, data: out };
  }
  // عيّنةٌ بعمقها، مكبّرةٌ إلى ٨ بتات (وللوحة: الفهرس نفسه)
  const sample = (row: number, k: number): number => {
    if (depth === 8) return raw[row + k];
    if (depth === 16) return raw[row + 2 * k];
    const bit = k * depth;
    const v = (raw[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    return color === 3 ? v : ((v * 255) / ((1 << depth) - 1) + 0.5) | 0;
  };
  for (let y = 0, o = 0; y < height; y++) {
    const row = y * (stride + 1) + 1;
    for (let x = 0; x < width; x++, o += 4) {
      if (color === 0 || color === 4) {
        const g = sample(row, x * ch);
        out[o] = g; out[o + 1] = g; out[o + 2] = g;
      } else if (color === 3) {
        const p = sample(row, x) * 3;
        out[o] = palette![p] ?? 0; out[o + 1] = palette![p + 1] ?? 0; out[o + 2] = palette![p + 2] ?? 0;
      } else {
        out[o] = sample(row, x * ch); out[o + 1] = sample(row, x * ch + 1); out[o + 2] = sample(row, x * ch + 2);
      }
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/** يبيّض موضع رمزٍ قُرئ (رباعيّه موسّعاً قليلاً) ليُبحث عن غيره في الصورة نفسها */
function maskCode(img: Rgba, data: Uint8ClampedArray, loc: QRCode['location']): void {
  const pts = [loc.topLeftCorner, loc.topRightCorner, loc.bottomRightCorner, loc.bottomLeftCorner];
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  // هامش الرمز الأبيض (أربع وحدات) يقارب ١٥٪ من عرضه: يُوسَّع بمثله فلا يبقى من نماذجه ما يُظن رمزاً
  const q = pts.map((p) => ({ x: cx + (p.x - cx) * 1.15, y: cy + (p.y - cy) * 1.15 }));
  const x0 = Math.max(0, Math.floor(Math.min(...q.map((p) => p.x)))), x1 = Math.min(img.width - 1, Math.ceil(Math.max(...q.map((p) => p.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...q.map((p) => p.y)))), y1 = Math.min(img.height - 1, Math.ceil(Math.max(...q.map((p) => p.y))));
  const side = (a: { x: number; y: number }, b: { x: number; y: number }, x: number, y: number) => (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
  const ref = sign(side(q[0], q[1], cx, cy));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let inside = true;
      for (let k = 0; k < 4 && inside; k++) if (sign(side(q[k], q[(k + 1) % 4], x, y)) === -ref) inside = false;
      if (!inside) continue;
      const o = (y * img.width + x) * 4;
      data[o] = 255; data[o + 1] = 255; data[o + 2] = 255;
    }
  }
}

const latin1 = (b: number[]) => String.fromCharCode(...b);

/** السطوع (٨ بتات) من RGBA */
function greyOf(img: Rgba): Uint8Array {
  const d = img.data, n = img.width * img.height, g = new Uint8Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

/** تنعيمٌ بمتوسط مربعٍ ضلعه 2r+1 (مفصولٌ أفقياً ثم عمودياً، والأطراف تُكرَّر) */
function smoothBox(g: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const t = new Uint16Array(g.length), out = new Uint8Array(g.length);
  const k = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) { const xx = x + d; s += g[row + (xx < 0 ? 0 : xx >= w ? w - 1 : xx)]; }
      t[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) { const yy = y + d; s += t[(yy < 0 ? 0 : yy >= h ? h - 1 : yy) * w + x]; }
      out[y * w + x] = (s + (k >> 1)) / k;
    }
  }
  return out;
}

/**
 * ضجيج الصورة تقديراً (يقارب انحرافه المعياري بدرجات السطوع): وسيط أصغر الفرقين الثانيين أفقياً وعمودياً على عيّنةٍ من البكسلات ·
 * حافة الرمز يصفر فيها أحد الفرقين فلا تُحسب ضجيجاً
 */
export function noiseLevel(g: Uint8Array, w: number, h: number): number {
  const hist = new Uint32Array(512);
  let n = 0;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x, c = 2 * g[i];
      const dh = abs(c - g[i - 1] - g[i + 1]), dv = abs(c - g[i - w] - g[i + w]);
      const v = dh < dv ? dh : dv;
      hist[v > 511 ? 511 : v]++; n++;
    }
  }
  for (let i = 0, acc = 0; i < 512; i++) { acc += hist[i]; if (acc * 2 >= n) return i; }
  return 511;
}
/** ما دونه صورةٌ نقية (لقطة شاشة، أو صورةٌ بإضاءةٍ جيدة بعد التصغير) تُقرأ كما هي أولاً */
export const CLEAN_NOISE = 5;
/** وما فوقه ضجيجٌ ثقيل (إضاءةٌ خافتة) يُنعَّم بمتوسط ٥×٥ بدل ٣×٣ */
export const HEAVY_NOISE = 12;

const rgbaOfGrey = (g: Uint8Array): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(g.length * 4);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) { out[o] = g[i]; out[o + 1] = g[i]; out[o + 2] = g[i]; out[o + 3] = 255; }
  return out;
};

/**
 * قيم رموز QR في الصورة · jsQR يتعثّر بضجيج الحساس (تتقطّع نماذج الزوايا فيطول بحثه ولا يجد)، فتُنعَّم الصورة بمتوسط ٣×٣ قبله (و٥×٥ لضجيجٍ ثقيل) ·
 * والنقية تُقرأ كما هي أولاً (وحداتٌ صغيرةٌ يمحوها التنعيم)، وبالوجهين (الرمز المعكوس فاتحاً على داكن)، ثم منعّمةً ·
 * وjsQR يعيد رمزاً واحداً في كل مرة، فإن لم يكن المطلوب (wanted · رمز الهيئة عند الخدمة) بُيّض موضعه وأُعيد البحث، حتى max رموز
 * (صورة الفاتورة قد تحمل رابط المتجر بجانب رمز الهيئة، وML Kit كان يعيدها كلها).
 */
export function qrValuesFromRgba(img: Rgba, opts: { wanted?: (v: string) => boolean; max?: number } = {}): string[] {
  const max = opts.max ?? 3;
  const { width: w, height: h } = img;
  const out: string[] = [];
  const g = greyOf(img);
  const noise = noiseLevel(g, w, h);
  const clean = noise <= CLEAN_NOISE;
  const attempts: Array<[() => Uint8ClampedArray, 'attemptBoth' | 'dontInvert']> = [
    ...(clean ? [[() => img.data, 'attemptBoth'] as [() => Uint8ClampedArray, 'attemptBoth']] : []),
    [() => rgbaOfGrey(smoothBox(g, w, h, noise > HEAVY_NOISE ? 2 : 1)), 'dontInvert'],
  ];
  for (const [make, inversionAttempts] of attempts) {
    const base = make();
    let data = base;
    for (let i = 0; i < max; i++) {
      const code = jsQR(data, w, h, { inversionAttempts });
      if (!code) break;
      const v = code.data || latin1(code.binaryData);
      if (v && !out.includes(v)) out.push(v);
      if (!opts.wanted || opts.wanted(v)) return out;
      if (data === img.data) data = new Uint8ClampedArray(img.data);
      maskCode(img, data, code.location);
    }
    if (!opts.wanted && out.length) return out;
  }
  return out;
}

/** قيم الرموز من ملف PNG · يرمي «png» لما لا يُفكّ */
export function qrValuesFromPng(bytes: Uint8Array, opts: { wanted?: (v: string) => boolean; max?: number } = {}): string[] {
  return qrValuesFromRgba(decodePng(bytes), opts);
}

/**
 * أطوال الضلع الأطول التي تُقرأ بها صورةٌ أبعادها w×h، بالترتيب · الأولى تكفي رمزاً صُوّر قريباً وهي الأسرع (نحو ١٫٣ ثانية
 * على Node، ونحو ٤ بلا JIT · tests/q0_3.qrImage)،
 * والثانية لرمزٍ صغيرٍ في الصورة أو كثيف الوحدات (المرحلة الثانية) · ولا تكبير: صورةٌ أصغر تُقرأ بحجمها مرةً واحدة (null) ·
 * وأبعادٌ مجهولة (0) تُقرأ بالطولين.
 */
export const QR_SIDES = [1600, 2400] as const;
export function qrPassSides(w: number, h: number): Array<number | null> {
  const long = Math.max(w || 0, h || 0);
  if (!long) return [...QR_SIDES];
  const out: Array<number | null> = [];
  for (const s of QR_SIDES) {
    if (long <= s) { out.push(null); break; }
    out.push(s);
  }
  return out;
}
