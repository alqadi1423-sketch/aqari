/**
 * ق٠-٣ · لا ML Kit للرموز (قرار المالك: بلا قوقل · المراجعة الشاملة 2026-11-13 · F · ٥.٥ الخيار أ وG-08 وF-2):
 * ١) لا ملف يستورد حزمة ML Kit للرموز، ولا هي في package.json ولا package-lock.json · وقراءة النص (ق٠-٤) لم تُمسّ.
 * ٢) jsQR المنسوخ هو ملف npm نفسه (بصمته).
 * ٣) الخدمة readQrFromImage من أولها: المصغِّر (محاكىً بتصغيرٍ بجافاسكربت يحفظ PNG) ثم الفكّ ثم رمز الهيئة، بمرورين، وأخطاؤها.
 * بيانات مصطنعة وحدها.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pickZatcaQr, zatcaQrKey } from '@/domain/zatcaQr';
import { zatcaTlvBase64 } from '@/domain/printDocs';
import { qrMatrix, renderPhoto, downscale, blurAndNoise, encodePng, tlvBase64, fakeBytes, type Img } from './helpers/qrPhoto';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const BARCODE = '@react-native-ml-kit/barcode-scanning';

const walk = (d: string, out: string[] = []): string[] => {
  if (!fs.existsSync(path.join(root, d))) return out;
  for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'build' && !e.name.startsWith('.')) walk(p, out); }
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|kt|java|gradle|json|xml)$/.test(e.name)) out.push(p);
  }
  return out;
};

describe('لا ML Kit للرموز', () => {
  test('لا ملف في التطبيق ولا الخادم ولا الأدوات ولا أندرويد يستورد حزمة الرموز أو مكتبة قوقل للرموز', () => {
    const files = ['src', 'app', 'e2e', 'scripts', 'server', 'android/app/src'].flatMap((d) => walk(d));
    expect(files.length).toBeGreaterThan(100);
    const bad = files.filter((f) => {
      const s = read(f);
      return s.includes(BARCODE) || /com\.google\.mlkit[:.]barcode/.test(s) || /BarcodeScanning/.test(s);
    });
    expect(bad).toEqual([]);
  });
  test('ولا هي في package.json ولا package-lock.json (فلا تُربط في البناء القادم) · وقراءة النص باقيةٌ لبندها (ق٠-٤)', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain(BARCODE);
    const lock = read('package-lock.json');
    expect(lock).not.toContain(BARCODE);
    expect(JSON.parse(lock).packages[''].dependencies).not.toHaveProperty([BARCODE]);
    // وحزمة قراءة النص أُزيلت كذلك في ق٠-٤ (1788e10)، فلا شيء من ML Kit في الاعتمادات
    expect(pkg.dependencies['@react-native-ml-kit/text-recognition']).toBeUndefined();
  });
  test('الخدمة تقرأ بالمصغِّر وjsQR وتفشل برسالةٍ مفهومة إن غاب المصغِّر', () => {
    const svc = read('src/services/invoiceQr.ts');
    expect(svc).toMatch(/import\('expo-image-manipulator'\)/);
    expect(svc).toMatch(/import\('\.\.\/domain\/qrImage'\)/);
    expect(svc).toMatch(/qr-unavailable/);
    expect(read('src/domain/qrImage.ts')).toMatch(/from '\.\.\/vendor\/jsqr\/jsQR'/);
  });
  test('jsQR المنسوخ هو dist/jsQR.js من jsqr@1.4.0 بلا تغيير، ورخصته بجانبه', () => {
    const js = fs.readFileSync(path.join(root, 'src/vendor/jsqr/jsQR.js'));
    expect(crypto.createHash('sha256').update(js).digest('hex')).toBe('bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859');
    expect(read('src/vendor/jsqr/LICENSE')).toMatch(/Apache License\s+Version 2\.0/);
    // ولا اتصال ولا WebAssembly ولا تقييم نصٍّ برمجي فيه
    const src = js.toString('utf8');
    expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|WebAssembly|\beval\(|new Function\(/);
  });
});

// ── الخدمة بمحاكاة المصغِّر ونظام الملفات ──────────────────────────────────────────────

/** «صور» الجهاز: مسارٌ إلى صورةٍ بدقتها الكاملة · والمصغِّر المحاكى يصغّرها بالمتوسط ويحفظ PNG كما يفعل الأصلي */
const mockPhotos = new Map<string, Img>();
const mockFiles = new Map<string, Uint8Array>();
const mockCalls: Array<{ uri: string; actions: unknown[]; save: unknown }> = [];
const mockDeleted: string[] = [];
const mockState = { available: true, throwOnManip: false, junk: false };
jest.mock('expo-image-manipulator', () => ({
  __esModule: true,
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
  get manipulateAsync() {
    if (!mockState.available) return undefined;
    return async (uri: string, actions: Array<{ resize?: { width?: number; height?: number } }>, save: unknown) => {
      mockCalls.push({ uri, actions, save });
      if (mockState.throwOnManip) throw new Error('decode failed');
      const img = mockPhotos.get(uri);
      if (!img) throw new Error('no such image');
      const r = actions[0]?.resize;
      const long = r ? (r.width ? Math.round(Math.max(img.width, img.height) * (r.width / img.width)) : Math.round(Math.max(img.width, img.height) * (r.height! / img.height))) : Math.max(img.width, img.height);
      // وغبش العدسة وضجيج الحساس كما يظهران في الناتج (كما في q0_3.qrImage)
      const small = blurAndNoise(long < Math.max(img.width, img.height) ? downscale(img, long) : img, 1, 10, mockCalls.length);
      const out = 'file:///cache/ImageManipulator/' + mockCalls.length + '.png';
      mockFiles.set(out, mockState.junk ? Uint8Array.from([1, 2, 3]) : encodePng(small));
      return { uri: out, width: small.width, height: small.height };
    };
  },
}));
jest.mock('expo-file-system', () => ({
  __esModule: true,
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    bytesSync() { const b = mockFiles.get(this.uri); if (!b) throw new Error('missing'); return b; }
    delete() { mockDeleted.push(this.uri); mockFiles.delete(this.uri); }
  },
}));

const P1 = zatcaTlvBase64('مطعم الضيافة المصطنع', '300000000000003', '2026-11-12T19:05:44Z', 34500, 4500);
const P1_KEY = `300000000000003|T${Date.UTC(2026, 10, 12, 19, 5, 44)}|34500|4500`;
const HASH = Buffer.from(fakeBytes(32, 7)).toString('base64');
const P2 = tlvBase64([
  [1, 'مخبز السنابل المصطنع'], [2, '399999999900003'], [3, '2026-11-15T08:30:00+03:00'], [4, '57.50'], [5, '7.50'],
  [6, HASH], [7, Buffer.from(fakeBytes(70, 8)).toString('base64')], [8, fakeBytes(88, 9)], [9, fakeBytes(72, 10)],
]);

beforeEach(() => { mockCalls.length = 0; mockDeleted.length = 0; Object.assign(mockState, { available: true, throwOnManip: false, junk: false }); });

describe('readQrFromImage من أولها', () => {
  // صورة كاميرا عمودية ٢١٠٠×٢٨٠٠ (الضلع الأطول فوق ٢٤٠٠: مروران ممكنان)
  beforeAll(() => {
    mockPhotos.set('file:///photo/big.jpg', renderPhoto({ width: 2100, height: 2800, seed: 3, textLines: true,
      codes: [{ cx: 0.5, cy: 0.66, size: 900, angle: 8, matrix: qrMatrix(P1) }] }));
    // رمز المرحلة الثانية صغيرٌ في صورة كاميرا ٣٠٠٠×٤٠٠٠ (٦٤٠ بكسلاً لـ٩٣ وحدة): لا يُقرأ بعد التصغير إلى ١٦٠٠
    // (٢٫٨ بكسل للوحدة مع الضجيج) ويُقرأ في ٢٤٠٠ (٤٫١)
    mockPhotos.set('file:///photo/small.jpg', renderPhoto({ width: 3000, height: 4000, seed: 5, textLines: true,
      codes: [{ cx: 0.6, cy: 0.75, size: 640, angle: 6, matrix: qrMatrix(P2) }] }));
    // أفقية بلا رمز
    mockPhotos.set('file:///photo/none.jpg', renderPhoto({ width: 2800, height: 2100, seed: 9, textLines: true, codes: [] }));
  });

  test('رمزٌ واضح: مرورٌ واحد بالضلع الأطول ١٦٠٠ وPNG، فحقول الفاتورة الذهبية، والملف المؤقت يُحذف', async () => {
    const { readQrFromImage } = await import('@/services/invoiceQr');
    const values = await readQrFromImage('file:///photo/big.jpg', { width: 2100, height: 2800 });
    expect(mockCalls).toEqual([{ uri: 'file:///photo/big.jpg', actions: [{ resize: { height: 1600 } }], save: { format: 'png', compress: 1 } }]);
    const r = pickZatcaQr(values);
    expect(r.ok && r.qr).toMatchObject({ sellerName: 'مطعم الضيافة المصطنع', vatNo: '300000000000003', totalHalalas: 34500, vatHalalas: 4500, subtotalHalalas: 30000, phase: 1, warnings: [] });
    expect(r.ok && zatcaQrKey(r.qr)).toBe(P1_KEY);
    expect(mockDeleted).toEqual(['file:///cache/ImageManipulator/1.png']);
  });

  test('رمزٌ صغير: المرور الأول لا يجده، والثاني (٢٤٠٠) يقرؤه ببصمة المرحلة الثانية · والملفان المؤقتان يُحذفان', async () => {
    const { readQrFromImage } = await import('@/services/invoiceQr');
    const values = await readQrFromImage('file:///photo/small.jpg', { width: 3000, height: 4000 });
    expect(mockCalls.map((c) => c.actions)).toEqual([[{ resize: { height: 1600 } }], [{ resize: { height: 2400 } }]]);
    const r = pickZatcaQr(values);
    expect(r.ok && r.qr).toMatchObject({ sellerName: 'مخبز السنابل المصطنع', vatNo: '399999999900003', totalHalalas: 5750, vatHalalas: 750, phase: 2, invoiceHash: HASH });
    expect(mockDeleted).toHaveLength(2);
  });

  test('صورةٌ أفقية بلا رمز: يُصغَّر العرض، ومروران، ولا قيم («empty»)', async () => {
    const { readQrFromImage } = await import('@/services/invoiceQr');
    // (زمن القراءة يقيسه q0_3.qrImage · هنا يدخل فيه المصغِّر المحاكى بجافاسكربت)
    const values = await readQrFromImage('file:///photo/none.jpg', { width: 2800, height: 2100 });
    expect(mockCalls.map((c) => c.actions)).toEqual([[{ resize: { width: 1600 } }], [{ resize: { width: 2400 } }]]);
    expect(values).toEqual([]);
    expect(pickZatcaQr(values)).toEqual({ ok: false, error: 'empty' });
  });

  test('صورةٌ أصغر من ١٦٠٠ لا تُكبَّر: مرورٌ واحد بلا تصغير · وأبعادٌ مجهولة: يُصغَّر العرض', async () => {
    mockPhotos.set('file:///photo/shot.png', renderPhoto({ width: 1080, height: 1500, seed: 12, codes: [{ cx: 0.5, cy: 0.5, size: 700, angle: 0, matrix: qrMatrix(P1) }] }));
    const { readQrFromImage } = await import('@/services/invoiceQr');
    expect(pickZatcaQr(await readQrFromImage('file:///photo/shot.png', { width: 1080, height: 1500 })).ok).toBe(true);
    expect(mockCalls.map((c) => c.actions)).toEqual([[]]);
    mockCalls.length = 0;
    expect(pickZatcaQr(await readQrFromImage('file:///photo/big.jpg')).ok).toBe(true);
    expect(mockCalls.map((c) => c.actions)).toEqual([[{ resize: { width: 1600 } }]]);
  });

  test('المصغِّر غير مربوط: «qr-unavailable» · يفشل في الصورة: «qr-read» · وناتجٌ لا يُفكّ: «qr-read»', async () => {
    const { readQrFromImage } = await import('@/services/invoiceQr');
    const err = async (f: () => Promise<unknown>) => { try { await f(); return ''; } catch (e) { return (e as Error).message; } };
    mockState.available = false;
    expect(await err(() => readQrFromImage('file:///photo/big.jpg'))).toBe('qr-unavailable');
    mockState.available = true; mockState.throwOnManip = true;
    expect(await err(() => readQrFromImage('file:///photo/big.jpg'))).toBe('qr-read');
    mockState.throwOnManip = false; mockState.junk = true;
    expect(await err(() => readQrFromImage('file:///photo/big.jpg'))).toBe('qr-read');
    // والملف المؤقت يُحذف ولو لم يُفكّ
    expect(mockDeleted).toEqual(['file:///cache/ImageManipulator/2.png']);
  });
});
