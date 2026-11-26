/**
 * ق٠-٣ · قراءة رمز فاتورة الشراء بجافاسكربت خالصة بلا ML Kit (المراجعة الشاملة 2026-11-13 · F · ٥.٥ الخيار أ):
 * صورٌ مصطنعة كما يصوّرها جوال (دوران، ميل، إضاءة متدرجة، سطور نص، غبش، ضجيج، تصغير) تُرمَّز PNG كما يحفظها المصغِّر، ثم تُقرأ
 * من أولها إلى حقول الفاتورة (decodePng ثم jsQR ثم decodeZatcaQr) بقيمٍ ذهبية · وزمن القراءة على مقاس الصورة بعد التصغير.
 * بيانات مصطنعة وحدها.
 */
import { decodePng, qrValuesFromPng, qrValuesFromRgba, qrPassSides, MAX_PIXELS } from '@/domain/qrImage';
import { decodeZatcaQr, pickZatcaQr, zatcaQrKey, type ZatcaQr } from '@/domain/zatcaQr';
import { zatcaTlvBase64 } from '@/domain/printDocs';
import { zlibSync } from 'fflate';
import {
  qrMatrix, renderPhoto, downscale, blurAndNoise, encodePng, tlvBase64, fakeBytes, type Img, type Placement,
} from './helpers/qrPhoto';

const ok = (r: ReturnType<typeof decodeZatcaQr>): ZatcaQr => { if (!r.ok) throw new Error('not ok: ' + r.error); return r.qr; };
const isZatca = (v: string) => decodeZatcaQr(v).ok;

// المرحلة الأولى بمولّد التطبيق نفسه (رمز الفاتورة المطبوعة)
const P1 = zatcaTlvBase64('مؤسسة النخبة المصطنعة للتجارة', '300000000000003', '2026-11-02T10:15:30Z', 115000, 15000);
const P1_GOLD = {
  sellerName: 'مؤسسة النخبة المصطنعة للتجارة', vatNo: '300000000000003', issuedAt: '2026-11-02T10:15:30Z',
  totalHalalas: 115000, vatHalalas: 15000, subtotalHalalas: 100000, phase: 1, invoiceHash: null, warnings: [],
};
const P1_KEY = '300000000000003|T1793614530000|115000|15000';

// المرحلة الثانية: بصمة SHA-256 وتوقيع ECDSA (Base64) ومفتاحٌ عام وتوقيع شهادة (بايتات) · كلها مصطنعة
const HASH = Buffer.from(fakeBytes(32, 61)).toString('base64');
const P2 = tlvBase64([
  [1, 'شركة الواحة المصطنعة للتموين والخدمات'], [2, '399999999900003'], [3, '2026-11-20T16:42:07'],
  [4, '2875.50'], [5, '375.07'],
  [6, HASH], [7, Buffer.from(fakeBytes(71, 62)).toString('base64')], [8, fakeBytes(88, 63)], [9, fakeBytes(71, 64)],
]);
const P2_GOLD = {
  sellerName: 'شركة الواحة المصطنعة للتموين والخدمات', vatNo: '399999999900003', issuedAt: '2026-11-20T16:42:07',
  totalHalalas: 287550, vatHalalas: 37507, subtotalHalalas: 250043, phase: 2, invoiceHash: HASH, warnings: [],
};
const P2_KEY = `399999999900003|T1795182127000|287550|37507|#${HASH}`;

/** التقاطٌ بدقة الحساس ٣٠٠٠×٤٠٠٠ ثم تصغيرٌ إلى الضلع الأطول side ثم غبشٌ وضجيج ثم PNG، كما تفعل الخدمة بالمصغِّر الأصلي */
const photoCache = new Map<string, Img>();
function shot(name: string, codes: Placement[], o: { seed: number; side: number; blur?: number; sigma?: number; light?: [number, number]; ink?: number; W?: number; H?: number }): Uint8Array {
  const k = name + ':' + (o.W ?? 3000) + 'x' + (o.H ?? 4000);
  let full = photoCache.get(k);
  if (!full) {
    full = renderPhoto({ width: o.W ?? 3000, height: o.H ?? 4000, codes, seed: o.seed, textLines: true, light: o.light, ink: o.ink });
    photoCache.set(k, full);
  }
  const small = blurAndNoise(downscale(full, o.side), o.blur ?? 1, o.sigma ?? 10, o.seed + 1);
  return encodePng(small);
}

const expectP1 = (values: string[]) => {
  const r = pickZatcaQr(values);
  const q = ok(r);
  expect(q).toEqual(P1_GOLD);
  expect(zatcaQrKey(q)).toBe(P1_KEY);
};
const expectP2 = (values: string[]) => {
  const q = ok(pickZatcaQr(values));
  expect(q).toEqual(P2_GOLD);
  expect(zatcaQrKey(q)).toBe(P2_KEY);
};

describe('الحمولتان قبل الصورة', () => {
  test('حجم الرمزين: المرحلة الأولى صغير، والثانية كثيف الوحدات كرموز الفواتير المربوطة', () => {
    const n1 = qrMatrix(P1).length, n2 = qrMatrix(P2).length;
    // eslint-disable-next-line no-console
    console.log('Q03 · الوحدات: المرحلة الأولى', n1, '· الثانية', n2, '· طول الحمولة', P1.length, P2.length);
    expect(n1).toBeLessThanOrEqual(53);
    expect(n2).toBeGreaterThanOrEqual(85);
    expectP1([P1]);
    expectP2([P2]);
  });
});

describe('صورة معرضٍ نظيفة (صورة الجوال الافتراضي e2e/qrInvoice.js: PNG رمادي ٨ بت)', () => {
  test('تُقرأ إلى حقول فاتورتها', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { payload, qrPng } = require('../e2e/qrInvoice.js');
    const png: Uint8Array = qrPng(payload);
    const img = decodePng(png);
    expect(img.data[3]).toBe(255);
    const values = qrValuesFromRgba(img);
    expect(values).toEqual([payload]);
    expect(ok(pickZatcaQr(values))).toMatchObject({ sellerName: 'E2E QR Supplier', vatNo: '300000000000003', totalHalalas: 115000, vatHalalas: 15000 });
  });
});

describe('صورة جوال: ٣٠٠٠×٤٠٠٠ مصغّرةً إلى ١٦٠٠ (المرور الأول)', () => {
  const codes1: Placement[] = [{ cx: 0.5, cy: 0.7, size: 950, angle: 12, shear: 0.05, matrix: qrMatrix(P1) }];
  test('المرحلة الأولى مدوّراً ١٢° ومائلاً، بإضاءةٍ متدرجة وسطور نص وغبشٍ وضجيج: الحقول الذهبية', () => {
    const png = shot('p1', codes1, { seed: 11, side: 1600 });
    const t0 = Date.now();
    const values = qrValuesFromPng(png, { wanted: isZatca });
    const ms = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log('Q03 · المرحلة الأولى ١٢٠٠×١٦٠٠ · PNG', png.length, 'بايتاً · فكٌّ وقراءة', ms, 'ms');
    expectP1(values);
  });
  test('المرحلة الثانية (٩٣ وحدة تقريباً) مدوّراً −٧° في ثلث عرض الصورة: الحقول الذهبية والبصمة', () => {
    const png = shot('p2', [{ cx: 0.45, cy: 0.62, size: 1200, angle: -7, shear: -0.04, matrix: qrMatrix(P2) }], { seed: 21, side: 1600 });
    expectP2(qrValuesFromPng(png, { wanted: isZatca }));
  });
  test('زوايا أخرى (٤٧° و٩٣° و١٨٨° و٢٦٩°) وضجيجٌ أشد (σ ١٨)', () => {
    for (const [i, angle] of [47, 93, 188, 269].entries()) {
      const png = shot('rot' + angle, [{ cx: 0.5, cy: 0.5, size: 1100, angle, matrix: qrMatrix(P1) }], { seed: 30 + i, side: 1600, sigma: 18 });
      expectP1(qrValuesFromPng(png, { wanted: isZatca }));
    }
  });
  test('ظلٌّ ثقيل (الورق من ٢٠٠ إلى ٧٠) وحبرٌ باهت', () => {
    const png = shot('dark', [{ cx: 0.55, cy: 0.4, size: 1000, angle: 4, matrix: qrMatrix(P1) }], { seed: 41, side: 1600, light: [200, 70], ink: 40 });
    expectP1(qrValuesFromPng(png, { wanted: isZatca }));
  });
  test('رمزٌ معكوس (فاتح على داكن) في صورةٍ نقية يُقرأ أيضاً', () => {
    const img = blurAndNoise(renderPhoto({ width: 1200, height: 1600, seed: 51, codes: [{ cx: 0.5, cy: 0.5, size: 600, angle: 9, matrix: qrMatrix(P1) }] }), 1, 3, 52);
    for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 255 - img.data[i]; img.data[i + 1] = 255 - img.data[i + 1]; img.data[i + 2] = 255 - img.data[i + 2]; }
    expectP1(qrValuesFromPng(encodePng(img)));
  });
});

describe('رمزٌ صغيرٌ في الصورة: لا يُقرأ بعد التصغير إلى ١٦٠٠، ويُقرأ في المرور الثاني (٢٤٠٠)', () => {
  // ٧٠٠ بكسل لـ٩٣ وحدة (٧٫٥ بكسلات للوحدة في الأصل): ٤٫٧ بعد التصغير إلى ٢٤٠٠، و٣٫١ بعد ١٦٠٠ · وما دونه (٥٦٠: ٣٫٨ بعد ٢٤٠٠)
  // لا يقرؤه jsQR مع ضجيج σ ١٠ وغبش، فيُطلب من المستخدم تصويره أقرب (purchaseQr.err.empty)
  const codes: Placement[] = [{ cx: 0.6, cy: 0.75, size: 700, angle: 6, matrix: qrMatrix(P2) }];
  test('المرحلة الثانية بعرض ٧٠٠ بكسل من ٣٠٠٠', () => {
    const first = qrValuesFromPng(shot('small', codes, { seed: 61, side: 1600 }), { wanted: isZatca });
    const png2400 = shot('small', codes, { seed: 61, side: 2400 });
    const t0 = Date.now();
    const second = qrValuesFromPng(png2400, { wanted: isZatca });
    const ms = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log('Q03 · رمزٌ صغير: المرور الأول', first.length, 'قيمة · الثاني', second.length, '· زمن الثاني ١٨٠٠×٢٤٠٠', ms, 'ms');
    expect(first.filter(isZatca)).toEqual([]);
    expectP2(second);
  });
});

describe('أكثر من رمزٍ في الصورة (رابط المتجر ورمز الهيئة)', () => {
  const URL = 'https://shop.example.invalid/receipt/88412?ref=qr';
  const codes: Placement[] = [
    { cx: 0.5, cy: 0.27, size: 1000, angle: -3, matrix: qrMatrix(URL) },
    { cx: 0.5, cy: 0.74, size: 1000, angle: 2, matrix: qrMatrix(P1) },
  ];
  test('يُبحث بعد الرابط عن غيره حتى رمز الهيئة · فتُقرأ الفاتورة بحقولها', () => {
    const png = shot('two', codes, { seed: 71, side: 1600 });
    const values = qrValuesFromPng(png, { wanted: isZatca });
    // eslint-disable-next-line no-console
    console.log('Q03 · رمزان:', values.map((v) => v.slice(0, 30)));
    expect(values).toContain(P1);
    expectP1(values);
    // وبلا شرطٍ يعيد أول ما وجد وحده
    expect(qrValuesFromPng(png).length).toBe(1);
  });
  test('ورمز الرابط وحده: «الرمز رابطٌ لا فاتورة» (url) كما كان', () => {
    const png = shot('url', [codes[0]], { seed: 72, side: 1600 });
    const values = qrValuesFromPng(png, { wanted: isZatca });
    expect(values).toEqual([URL]);
    expect(pickZatcaQr(values)).toEqual({ ok: false, error: 'url' });
  });
});

describe('صورةٌ بلا رمز', () => {
  test('فاتورةٌ بسطور نصٍّ وحدها: لا قيم («empty»)', () => {
    const png = shot('none', [], { seed: 81, side: 1600 });
    const t0 = Date.now();
    const values = qrValuesFromPng(png, { wanted: isZatca });
    const ms = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log('Q03 · بلا رمز ١٢٠٠×١٦٠٠ (أسوأ حال: بحثٌ كامل بالوجهين) ·', ms, 'ms');
    expect(values).toEqual([]);
    expect(pickZatcaQr(values)).toEqual({ ok: false, error: 'empty' });
  });
});

describe('فكّ PNG', () => {
  const small = blurAndNoise(downscale(renderPhoto({ width: 600, height: 800, seed: 91, codes: [{ cx: 0.5, cy: 0.5, size: 420, angle: 15, matrix: qrMatrix(P1) }] }), 800), 0, 6, 92);
  test('RGBA وRGB ورمادي، بالمرشّحات الخمسة وعلى أكثر من IDAT: البكسلات كما رُمِّزت', () => {
    for (const color of [6, 2, 0] as const) {
      const img = decodePng(encodePng(small, color, 4));
      expect([img.width, img.height]).toEqual([600, 800]);
      for (const i of [0, 4 * 1234 + 0, 4 * 300 * 600 + 4 * 300, small.data.length - 4]) {
        if (color === 0) {
          const g = Math.round(0.299 * small.data[i] + 0.587 * small.data[i + 1] + 0.114 * small.data[i + 2]);
          expect([img.data[i], img.data[i + 1], img.data[i + 2]]).toEqual([g, g, g]);
        } else {
          expect([img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]).toEqual([small.data[i], small.data[i + 1], small.data[i + 2], 255]);
        }
      }
      expectP1(qrValuesFromRgba(img));
    }
  });

  /** PNG بعمق بتٍّ واحد: رماديٌّ (٠) أو بلوحةٍ من لونين (٣) · كما تحفظ بعض أدوات الفواتير رموزها */
  const bitPng = (color: 0 | 3): Uint8Array => {
    const m = qrMatrix(P1), n = m.length, scale = 6, size = (n + 8) * scale;
    const stride = Math.ceil(size / 8);
    const raw = new Uint8Array((stride + 1) * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = Math.floor(y / scale) - 4, c = Math.floor(x / scale) - 4;
        const dark = r >= 0 && c >= 0 && r < n && c < n && m[r][c];
        // رمادي: ١ أبيض · لوحة: الفهرس ١ هو الأبيض أيضاً
        if (!dark) raw[y * (stride + 1) + 1 + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    const chunk = (type: string, data: Uint8Array) => {
      const b = Buffer.alloc(12 + data.length);
      b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii'); Buffer.from(data).copy(b, 8);
      // decodePng لا يفحص CRC (المصغِّر يكتبه صحيحاً، والفكّ يُحكم بـzlib)
      return b;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 1; ihdr[9] = color;
    return Uint8Array.from(Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
      ...(color === 3 ? [chunk('PLTE', Uint8Array.from([10, 20, 30, 250, 250, 240]))] : []),
      chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0)),
    ]));
  };
  test('عمق بتٍّ واحد رمادياً وبلوحة: الألوان صحيحة والرمز يُقرأ', () => {
    const g = decodePng(bitPng(0));
    expect([g.data[0], g.data[1], g.data[2]]).toEqual([255, 255, 255]);
    expectP1(qrValuesFromRgba(g));
    const p = decodePng(bitPng(3));
    expect([p.data[0], p.data[1], p.data[2]]).toEqual([250, 250, 240]);
    expectP1(qrValuesFromRgba(p));
  });

  test('ما ليس PNG، والتالف، والمتشابك، والضخم المصنوع: «png» لا انهيار ولا استهلاك ذاكرة', () => {
    const good = encodePng(small);
    const err = (b: Uint8Array) => { try { decodePng(b); return ''; } catch (e) { return (e as Error).message; } };
    expect(err(Uint8Array.from(Buffer.from('\xff\xd8\xff\xe0 JPEG', 'latin1')))).toBe('png');
    expect(err(good.subarray(0, 200))).toBe('png');
    const inter = Uint8Array.from(good); inter[8 + 8 + 12] = 1; // بايت التشابك في IHDR
    expect(err(inter)).toBe('png');
    const huge = Uint8Array.from(good); new DataView(huge.buffer).setUint32(16, 20000); new DataView(huge.buffer).setUint32(20, 20000);
    expect(20000 * 20000).toBeGreaterThan(MAX_PIXELS);
    expect(err(huge)).toBe('png');
    const badFilter = Uint8Array.from(good);
    // مرشّحٌ غير معروف (٧) في أول سطر: يُعاد ضغط البيانات به
    const img = decodePng(good);
    const raw = new Uint8Array((img.width * 4 + 1) * img.height); raw[0] = 7;
    const z = zlibSync(raw);
    const b = Buffer.from(badFilter);
    const idatAt = b.indexOf('IDAT') - 4;
    const head = b.subarray(0, idatAt);
    const len = Buffer.alloc(4); len.writeUInt32BE(z.length);
    const forged = Buffer.concat([head, len, Buffer.from('IDAT'), Buffer.from(z), Buffer.alloc(4), Buffer.from([0, 0, 0, 0]), Buffer.from('IEND'), Buffer.alloc(4)]);
    expect(err(Uint8Array.from(forged))).toBe('png');
  });
});

describe('أطوال المرور (qrPassSides)', () => {
  test('صورة الكاميرا ٣٠٠٠×٤٠٠٠: ١٦٠٠ ثم ٢٤٠٠ · ٢٠٠٠: ١٦٠٠ ثم بحجمها · ١٠٨٠: بحجمها مرةً · مجهولة: ١٦٠٠ ثم ٢٤٠٠', () => {
    expect(qrPassSides(3000, 4000)).toEqual([1600, 2400]);
    expect(qrPassSides(4000, 3000)).toEqual([1600, 2400]);
    expect(qrPassSides(1500, 2000)).toEqual([1600, null]);
    expect(qrPassSides(1080, 1080)).toEqual([null]);
    expect(qrPassSides(0, 0)).toEqual([1600, 2400]);
  });
});

describe('الزمن (Node · وHermes أبطأ: انظر q0_3 في التقرير)', () => {
  test('صورة جوال مصغّرة إلى ١٢٠٠×١٦٠٠: فكّ PNG وقراءة الرمز معاً في أقل من ١٫٥ ثانية، وبلا رمز في أقل من ٣ ثوانٍ', () => {
    const withCode = shot('p1', [{ cx: 0.5, cy: 0.7, size: 950, angle: 12, shear: 0.05, matrix: qrMatrix(P1) }], { seed: 11, side: 1600 });
    const none = shot('none', [], { seed: 81, side: 1600 });
    const time = (f: () => void) => { const t = Date.now(); f(); return Date.now() - t; };
    // تسخينٌ واحد ثم أفضل ثلاث (المقياس لا ضجيج الجامع)
    qrValuesFromPng(withCode);
    let png = Infinity, code = Infinity, empty = Infinity;
    for (let i = 0; i < 3; i++) {
      png = Math.min(png, time(() => decodePng(withCode)));
      code = Math.min(code, time(() => expectP1(qrValuesFromPng(withCode, { wanted: isZatca }))));
      empty = Math.min(empty, time(() => expect(qrValuesFromPng(none, { wanted: isZatca })).toEqual([])));
    }
    // eslint-disable-next-line no-console
    console.log(`Q03 · الزمن ١٢٠٠×١٦٠٠: فكّ PNG ${png} ms · فكٌّ وقراءة برمز ${code} ms · بلا رمز ${empty} ms`);
    expect(code).toBeLessThan(1500);
    expect(empty).toBeLessThan(3000);
  });
});
