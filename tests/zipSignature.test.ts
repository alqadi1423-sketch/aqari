/**
 * حارس أرشيف النسخ · العلّة التي أسقطت الاستيراد والحذف الكامل:
 *
 * الكاتب المتدفق كان يترك الأحجام صفراً في الترويسة ويرفع الراية الثالثة،
 * فيضطر القارئ إلى مسح البيانات باحثاً عن توقيع الملف التالي `50 4B 03 04` ·
 * وأي مرفق تحوي بايتاته هذا التوقيع يقطع المسح، فيُقرأ ما بعده ترويسةً كاذبة
 * بطريقة ضغط مجهولة، فينفجر المُنشئ برسالة «undefined cannot be used as a constructor».
 *
 * هذه الاختبارات تسقط إن عاد المسح: تبني أرشيفاً فيه مرفق يحمل التوقيع صراحةً
 * وترويسةً كاذبة كاملة خلفه، وتشترط أن يعود كل مدخل ببايتاته كما دخل.
 */
import { unzipSync, zipSync, Zip, ZipDeflate, ZipPassThrough, Unzip, UnzipInflate } from 'fflate';
import { zipYielding, unzipYielding, crc32, type ZipEntry } from '@/domain/backup/zipStream';

/** توقيع الترويسة المحلية · أول أربع بايتات في كل ملف zip وdocx وxlsx وpptx */
const SIG = [0x50, 0x4B, 0x03, 0x04];

const filler = (n: number, seed = 31): Uint8Array => {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * seed + 7) & 255;
  return a;
};

/** بايتات فيها التوقيع، ثم ترويسة كاذبة كاملة بطريقة ضغط مجهولة خلفه */
function boobyTrapped(size: number, at: number, fakeMethod: number): Uint8Array {
  const a = filler(size);
  a.set(SIG, at);
  a[at + 4] = 20; a[at + 5] = 0;
  a[at + 6] = 0; a[at + 7] = 0;
  a[at + 8] = fakeMethod & 255; a[at + 9] = fakeMethod >> 8;
  for (let k = 10; k < 26; k++) a[at + k] = 0;
  a[at + 18] = 8;
  a[at + 26] = 4; a[at + 27] = 0;
  a[at + 28] = 0; a[at + 29] = 0;
  a[at + 30] = 0x66; a[at + 31] = 0x61; a[at + 32] = 0x6B; a[at + 33] = 0x65;
  return a;
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** الكاتب المعطوب كما كان قبل الإصلاح · للتأكد أن ما كتبه ما زال يُقرأ */
function legacyStreamingZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let err: Error | null = null;
  const zip = new Zip((e, chunk) => { if (e) { err = e; return; } if (chunk) chunks.push(chunk); });
  for (const en of entries) {
    const zf = en.level === 0 ? new ZipPassThrough(en.name) : new ZipDeflate(en.name, { level: en.level });
    zip.add(zf); zf.push(en.bytes, true); if (err) throw err;
  }
  zip.end();
  if (err) throw err;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** القارئ المعطوب كما كان · يمسح البايتات لأن الأحجام غائبة من الترويسة */
function legacyStreamingUnzip(data: Uint8Array): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  let err: Error | null = null;
  const unzip = new Unzip((file) => {
    const parts: Uint8Array[] = [];
    file.ondata = (e, chunk, final) => {
      if (e) { err = e; return; }
      if (chunk) parts.push(chunk);
      if (final) {
        const t = parts.reduce((s, c) => s + c.length, 0);
        const b = new Uint8Array(t);
        let o = 0;
        for (const c of parts) { b.set(c, o); o += c.length; }
        out[file.name] = b;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const SLICE = 1 << 16;
  for (let i = 0; i < data.length; i += SLICE) {
    unzip.push(data.subarray(i, Math.min(i + SLICE, data.length)), i + SLICE >= data.length);
    if (err) throw err;
  }
  if (err) throw err;
  return out;
}

describe('أرشيف النسخ · لا مسح للبايتات', () => {
  test('الترويسة تحمل الأحجام ولا ترفع الراية الثالثة إطلاقاً', async () => {
    const arch = await zipYielding([{ name: 'a.bin', bytes: filler(5000), level: 0 }]);
    const flag = arch[6] | (arch[7] << 8);
    expect(flag & 8).toBe(0);          // لا واصف بيانات
    expect(flag & 0x0800).toBe(0x0800); // الاسم UTF-8
    expect(arch[18] | (arch[19] << 8) | (arch[20] << 16) | (arch[21] << 24)).toBe(5000); // الحجم المضغوط
    expect(arch[22] | (arch[23] << 8) | (arch[24] << 16) | (arch[25] << 24)).toBe(5000); // الحجم الأصلي
  });

  test('مرفق يحمل التوقيع وترويسة كاذبة: يعود كاملاً بلا انفجار', async () => {
    const trapped = boobyTrapped(4096, 1024, 12);
    const entries: ZipEntry[] = [
      { name: 'manifest.json', bytes: filler(400, 17), level: 6 },
      { name: 'data.db', bytes: filler(60000, 13), level: 6 },
      { name: 'attachments/trapped.bin', bytes: trapped, level: 0 },
      { name: 'attachments/after.bin', bytes: filler(20000, 41), level: 0 },
    ];
    const arch = await zipYielding(entries);
    const out = await unzipYielding(arch);
    expect(Object.keys(out).sort()).toEqual(entries.map((e) => e.name).sort());
    for (const e of entries) expect(eq(out[e.name], e.bytes)).toBe(true);
  });

  test('توقيعات كثيرة متتالية في مرفق واحد لا تُربك القراءة', async () => {
    const many = filler(30000, 23);
    for (let at = 100; at + 4 < many.length; at += 997) many.set(SIG, at);
    const entries: ZipEntry[] = [
      { name: 'manifest.json', bytes: filler(200, 7), level: 6 },
      { name: 'attachments/mines.bin', bytes: many, level: 0 },
      { name: 'attachments/tail.bin', bytes: filler(3000, 5), level: 0 },
    ];
    const out = await unzipYielding(await zipYielding(entries));
    expect(Object.keys(out).length).toBe(3);
    for (const e of entries) expect(eq(out[e.name], e.bytes)).toBe(true);
  });

  test('التوقيع داخل مجرى ضغط مضغوط أيضاً لا يكسر شيئاً', async () => {
    const entries: ZipEntry[] = [];
    for (let i = 0; i < 12; i++) entries.push({ name: 'e' + i + '.bin', bytes: boobyTrapped(2048, 300 + i * 7, 12), level: 6 });
    const out = await unzipYielding(await zipYielding(entries));
    expect(Object.keys(out).length).toBe(12);
    for (const e of entries) expect(eq(out[e.name], e.bytes)).toBe(true);
  });

  test('ما نكتبه تقرؤه أدوات zip القياسية · وما تكتبه نقرؤه', async () => {
    const entries: ZipEntry[] = [
      { name: 'manifest.json', bytes: filler(500, 11), level: 6 },
      { name: 'attachments/trapped.bin', bytes: boobyTrapped(4096, 1024, 12), level: 0 },
    ];
    // كتابتنا → قراءة fflate الدفعية (من الفهرس المركزي)
    const ours = unzipSync(await zipYielding(entries));
    expect(Object.keys(ours).sort()).toEqual(entries.map((e) => e.name).sort());
    for (const e of entries) expect(eq(ours[e.name], e.bytes)).toBe(true);

    // كتابة fflate → قراءتنا
    const theirs = await unzipYielding(zipSync(
      Object.fromEntries(entries.map((e) => [e.name, [e.bytes, { level: e.level }] as [Uint8Array, { level: 0 | 6 }]]))
    ));
    for (const e of entries) expect(eq(theirs[e.name], e.bytes)).toBe(true);
  });

  test('الأرشيف الأعجف يُرفض برسالة واضحة لا بانفجار مُنشئ', async () => {
    await expect(unzipYielding(filler(500))).rejects.toThrow('لا فهرس مركزي');
    const arch = await zipYielding([{ name: 'a.bin', bytes: filler(100), level: 0 }]);
    arch[arch.length - 6] = 0xFF; // إزاحة فهرس مركزي كاذبة
    await expect(unzipYielding(arch)).rejects.toThrow();
  });

  test('CRC-32 يطابق ما تحسبه fflate لنفس البايتات', async () => {
    const bytes = filler(9999, 29);
    const arch = await zipYielding([{ name: 'x.bin', bytes, level: 0 }]);
    // بصمة الترويسة المحلية عند الإزاحة ١٤
    const inHeader = (arch[14] | (arch[15] << 8) | (arch[16] << 16) | (arch[17] << 24)) >>> 0;
    expect(inHeader).toBe(crc32(bytes));
    // والقارئ الدفعي يتحقق من البصمة بنفسه · فنجاحه شهادة صحتها
    expect(eq(unzipSync(arch)['x.bin'], bytes)).toBe(true);
  });

  test('النسخ التي أنشأها التطبيق قبل الإصلاح تُقرأ كاملة بالقارئ الجديد', async () => {
    const entries: ZipEntry[] = [
      { name: 'manifest.json', bytes: filler(600, 11), level: 6 },
      { name: 'data.db', bytes: filler(80000, 13), level: 6 },
      { name: 'attachments/trapped.bin', bytes: boobyTrapped(4096, 1024, 12), level: 0 },
      { name: 'attachments/after.bin', bytes: filler(20000, 41), level: 0 },
    ];
    const legacy = legacyStreamingZip(entries);
    // القارئ القديم يسقط على نفس الأرشيف — إما بانفجار وإما بمدخل ناقص
    let legacyFailed = false;
    try {
      const bad = legacyStreamingUnzip(legacy);
      legacyFailed = Object.keys(bad).length !== entries.length;
    } catch { legacyFailed = true; }
    expect(legacyFailed).toBe(true);
    // والقارئ الجديد يقرؤه كاملاً · فالنسخ القديمة سليمة ولا تضيع
    const good = await unzipYielding(legacy);
    expect(Object.keys(good).sort()).toEqual(entries.map((e) => e.name).sort());
    for (const e of entries) expect(eq(good[e.name], e.bytes)).toBe(true);
  });

  test('١٨٠ مدخلاً كما في نسخة حقيقية · كلها تعود سليمة', async () => {
    const entries: ZipEntry[] = [
      { name: 'manifest.json', bytes: filler(3000, 19), level: 6 },
      { name: 'data.db', bytes: filler(200000, 3), level: 6 },
    ];
    for (let i = 0; i < 178; i++) {
      entries.push({ name: 'attachments/f' + i + '.bin', bytes: i % 5 === 0 ? boobyTrapped(3000, 500, 12) : filler(3000, i + 2), level: 0 });
    }
    const out = await unzipYielding(await zipYielding(entries));
    expect(Object.keys(out).length).toBe(180);
    for (const e of entries) expect(eq(out[e.name], e.bytes)).toBe(true);
  });
});
