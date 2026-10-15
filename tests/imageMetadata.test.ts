/**
 * المراجعة الخارجية ٧ · النتيجة ٢٧ · صورٌ مصطنعة بالبايتات: البيانات الوصفية تُنزع من JPEG (Exif وXMP وIPTC) وPNG وWebP،
 * والبكسل كما هو · وفي كل مسار إرفاق حين يكون الخيار مفعّلاً، ولا يُمسّ شيء وهو مطفأ · والخيار مفعّلٌ افتراضاً (قرار المالك 2026-10-15 «١٢» يحلّ محل قراره 2026-08-20).
 */
import { stripImageMetadata } from '@/domain/jpegExif';
import { putAttachment } from '@/files/store';
import { setSetting } from '@/repos/settings';
import { makeBackupEnv } from './helpers/backupEnv';
import { tempDir, rmrf } from './helpers/testDb';

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...xs: Uint8Array[]) => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of xs) { o.set(x, k); k += x.length; } return o; };
const seg = (marker: number, payload: Uint8Array) => cat(new Uint8Array([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload);
const GPS = enc('GPS 24.7136N 46.6753E · هاتف مصطنع');
const SCAN = new Uint8Array([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0xaa, 0xbb, 0xff, 0xd9]);
function jpeg(): Uint8Array {
  return cat(new Uint8Array([0xff, 0xd8]), seg(0xe0, enc('JFIF\0..')), seg(0xe1, cat(enc('Exif\0\0'), GPS)),
    seg(0xe1, cat(enc('http://ns.adobe.com/xap/1.0/\0'), GPS)), seg(0xed, cat(enc('Photoshop 3.0\0'), GPS)), SCAN);
}
function pngChunk(type: string, data: Uint8Array) {
  const len = new Uint8Array([data.length >>> 24, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255]);
  return cat(len, enc(type), data, new Uint8Array(4));
}
function png(): Uint8Array {
  return cat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', new Uint8Array(13)),
    pngChunk('tEXt', GPS), pngChunk('eXIf', GPS), pngChunk('IDAT', new Uint8Array([9, 9, 9])), pngChunk('IEND', new Uint8Array(0)));
}
function riffChunk(type: string, data: Uint8Array) {
  const n = data.length;
  return cat(enc(type), new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24]), data, n & 1 ? new Uint8Array(1) : new Uint8Array(0));
}
function webp(): Uint8Array {
  const vp8x = new Uint8Array(10); vp8x[0] = 0x08 | 0x04;
  const body = cat(enc('WEBP'), riffChunk('VP8X', vp8x), riffChunk('VP8 ', new Uint8Array([7, 7, 7, 7])), riffChunk('EXIF', GPS), riffChunk('XMP ', GPS));
  const n = body.length;
  return cat(enc('RIFF'), new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24]), body);
}
const has = (b: Uint8Array, s: Uint8Array) => { outer: for (let i = 0; i + s.length <= b.length; i++) { for (let j = 0; j < s.length; j++) if (b[i + j] !== s[j]) continue outer; return true; } return false; };

test('JPEG: يُنزع Exif وXMP وIPTC ويبقى JFIF وبيانات الصورة كما هي', () => {
  const out = stripImageMetadata(jpeg());
  expect(has(out, GPS)).toBe(false);
  expect(has(out, enc('JFIF'))).toBe(true);
  expect(Array.from(out.subarray(out.length - SCAN.length))).toEqual(Array.from(SCAN));
});

test('PNG وWebP: تُنزع النصوص وExif وXMP · وعلامتا VP8X وحجم RIFF يُصحَّحان', () => {
  const p = stripImageMetadata(png());
  expect(has(p, GPS)).toBe(false);
  expect(has(p, enc('IDAT'))).toBe(true);
  const w = stripImageMetadata(webp());
  expect(has(w, GPS)).toBe(false);
  expect(w[20] & 0x0c).toBe(0);
  expect((w[4] | (w[5] << 8) | (w[6] << 16) | (w[7] << 24)) >>> 0).toBe(w.length - 8);
});

test('كل مسار إرفاق ينزعها حين يُفعَّل الخيار · ولا يمسّها وهو مطفأ', async () => {
  const dir = tempDir('aq-meta-');
  try {
    const env = makeBackupEnv(dir);
    const fe = { db: env.db, fs: env.fs, hasher: env.hasher!, attachmentsDir: env.attachmentsDir };
    // مفعّلٌ افتراضاً (قرار المالك 2026-10-15 «١٢») · يُطفأ هنا ليُرى أنه لا يمسّها مطفأً
    setSetting(env.db, 'stripExif', false);
    const off = await putAttachment(fe, jpeg(), { entityType: 'library', entityId: 'L1', kind: 'صورة', originalName: 'أ.jpg', mime: 'image/jpeg' });
    expect(has(env.fs.read(env.attachmentsDir + '/' + off.sha256 + '.jpg'), GPS)).toBe(true);
    setSetting(env.db, 'stripExif', true);
    for (const [bytes, name, mime, ext] of [[jpeg(), 'ب.jpg', 'image/jpeg', 'jpg'], [png(), 'ج.png', 'image/png', 'png'], [webp(), 'د.webp', 'image/webp', 'webp']] as const) {
      const a = await putAttachment(fe, bytes, { entityType: 'claim', entityId: 'C1', kind: 'صورة', originalName: name, mime });
      expect(has(env.fs.read(env.attachmentsDir + '/' + a.sha256 + '.' + ext), GPS)).toBe(false);
    }
    env.closeLive();
  } finally { rmrf(dir); }
});
