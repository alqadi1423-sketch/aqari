/**
 * ق٠-٣ · قارئ رمز QR: لا Math.* في الحلقات الساخنة (لكل بايتٍ أو بكسل).
 * التشغيل 45828448066 على جيت هب: «فكٌّ وقراءة برمز» 2289 ms والحدّ 1500 (tests/q0_3.qrImage) · وسببه أن كل وصولٍ إلى Math في
 * سياق jest (vm) يمرّ بطريقٍ بطيء: إزالة ترشيح PNG ‏1200×1600 أخذت 840 ms بـMath.abs و120 ms بدونه، و28 ms على Node خارج jest ·
 * وعلى الجوال Hermes بلا JIT فاستدعاءٌ لكل بايت يُبطئه كذلك. والحدّ كما هو: يُسرَّع الكود ولا يُرفع الحدّ.
 */
import fs from 'fs';
import path from 'path';
import { decodePng, noiseLevel } from '@/domain/qrImage';
import { zlibSync } from 'fflate';

const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'domain', 'qrImage.ts'), 'utf8');
/** جسم الدالة من رأسها إلى أول سطرٍ يبدأ بـ«}» */
const body = (head: string) => { const i = src.indexOf(head); expect(i).toBeGreaterThan(-1); return src.slice(i, src.indexOf('\n}', i)); };

test('paeth وnoiseLevel وحلقة maskCode وعيّنة العمق بلا Math.*', () => {
  expect(body('function paeth(')).not.toMatch(/Math\./);
  expect(body('export function noiseLevel(')).not.toMatch(/Math\./);
  const mask = body('function maskCode(');
  expect(mask.slice(mask.indexOf('for (let y = y0'))).not.toMatch(/Math\./);
  const dec = body('export function decodePng(');
  expect(dec.slice(dec.indexOf('const sample ='))).not.toMatch(/Math\./);
  // وإزالة الترشيح كلها
  expect(dec.slice(dec.indexOf('for (let y = 0; y < height; y++) {'), dec.indexOf('const out = new Uint8ClampedArray'))).not.toMatch(/Math\./);
});

/** PNG بلا ضغطٍ ذكي: سطرٌ لكل مرشّح (٠ إلى ٤) · نوع اللون والعمق كما يُعطى */
function png(width: number, height: number, color: number, depth: number, rows: Uint8Array[]): Uint8Array {
  const crc = () => Buffer.alloc(4);
  const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); return Buffer.concat([l, Buffer.from(type), data, crc()]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = color;
  const raw = Buffer.concat(rows.map((r) => Buffer.from(r)));
  return Uint8Array.from(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from(zlibSync(raw))), chunk('IEND', Buffer.alloc(0))]));
}

test('النتيجة كما كانت: مرشّح Paeth بفروقٍ سالبة وموجبة، وتكبير العمق ٢ بتاً بالتقريب إلى الأقرب', () => {
  // رمادي ٨ بت، ٣×٢: السطر الأول بلا ترشيح، والثاني Paeth (a=يسار، b=فوق، c=فوق يسار)
  const img = decodePng(png(3, 2, 0, 8, [Uint8Array.from([0, 10, 200, 30]), Uint8Array.from([4, 5, 250, 7])]));
  // x0: a=0 b=10 c=0 → p=10 · pa=10 pb=0 → b=10 → 15 · x1: a=15 b=200 c=10 → p=205 · pa=190 pb=5 pc=195 → b → 250+200=450&255=194
  // x2: a=194 b=30 c=200 → p=24 · pa=170 pb=6 pc=176 → b → 7+30=37
  expect([img.data[12], img.data[16], img.data[20]]).toEqual([15, 194, 37]);
  // رمادي ٢ بت: القيم ٠..٣ إلى ٠ و٨٥ و١٧٠ و٢٥٥
  const g2 = decodePng(png(4, 1, 0, 2, [Uint8Array.from([0, 0b00011011])]));
  expect([g2.data[0], g2.data[4], g2.data[8], g2.data[12]]).toEqual([0, 85, 170, 255]);
});

test('noiseLevel كما كان: يطابق حسابه بـMath.min وMath.abs على صورةٍ عشوائية ثابتة البذرة', () => {
  const ref = (g: Uint8Array, w: number, h: number) => {
    const hist = new Uint32Array(512); let n = 0;
    for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x, c = 2 * g[i];
      const v = Math.min(Math.abs(c - g[i - 1] - g[i + 1]), Math.abs(c - g[i - w] - g[i + w]));
      hist[v > 511 ? 511 : v]++; n++;
    }
    for (let i = 0, acc = 0; i < 512; i++) { acc += hist[i]; if (acc * 2 >= n) return i; }
    return 511;
  };
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const amp of [0, 6, 30, 255]) {
    const w = 61, h = 47, g = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = Math.max(0, Math.min(255, Math.round(128 + (rnd() - 0.5) * amp)));
    expect(noiseLevel(g, w, h)).toBe(ref(g, w, h));
  }
  expect(noiseLevel(new Uint8Array(81).fill(100), 9, 9)).toBe(0);
});
