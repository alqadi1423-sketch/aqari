/**
 * قرار المالك 2026-10-15 «١٢» (يحلّ محل قراره 2026-08-20): نزع البيانات الوصفية من الصور مفعّلٌ افتراضاً، والصورة تُدوَّر قبله
 * بوسم اتجاهها · وما تعذّر تدويره يبقى فيه وسم الاتجاه وحده · بيانات مصطنعة.
 */
import { memDb, tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { putAttachment } from '@/files/store';
import { jpegOrientation, stripImageMetadata } from '@/domain/jpegExif';
import { getSetting } from '@/repos/settings';
import { migrate } from '@/db/migrations';
import { SCHEMA_VERSION } from '@/db/schema';

/** JPEG مصطنع: SOI · APP1 Exif بوسم اتجاهٍ ووسم GPS مزيّف · DQT · SOS وبيانات · EOI */
function jpeg(orientation: number, le = false): Uint8Array {
  const w16 = (v: number) => (le ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const w32 = (v: number) => (le ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...w16(42), ...w32(8), ...w16(2),
    ...w16(0x0112), ...w16(3), ...w32(1), ...w16(orientation), 0, 0,
    ...w16(0x8825), ...w16(4), ...w32(1), ...w32(0x47505331), ...w32(0)];
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 0xff, ...app1,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x01, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9]);
}
const hasGps = (b: Uint8Array) => Buffer.from(b).includes(Buffer.from([0x47, 0x50, 0x53, 0x31])) || Buffer.from(b).includes(Buffer.from([0x31, 0x53, 0x50, 0x47]));

test('وسم الاتجاه يُقرأ بالترتيبين · وغيابه طبيعي', () => {
  expect(jpegOrientation(jpeg(6))).toBe(6);
  expect(jpegOrientation(jpeg(8, true))).toBe(8);
  expect(jpegOrientation(stripImageMetadata(jpeg(6)))).toBe(1);
  expect(jpegOrientation(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(1);
});

test('القاعدة الجديدة: النزع مفعّل افتراضاً · والقائمة تُفعَّل بالترحيلة ٤٦', () => {
  const db = memDb();
  expect(getSetting(db, 'stripExif')).toBe(true);
  db.run(`UPDATE settings SET value_json = 'false' WHERE key = 'stripExif'`);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  migrate(db);
  expect(getSetting(db, 'stripExif')).toBe(true);
  db.close();
});

/** بيئة ملفات على مجلدٍ مؤقت بمدوِّرٍ مصطنع */
function filesEnv(orient: (b: Uint8Array) => Promise<Uint8Array | null>) {
  const dir = tempDir('aq-orient-');
  const be = makeBackupEnv(dir);
  return { env: { db: be.db, fs: be.fs, hasher: be.hasher!, attachmentsDir: be.attachmentsDir, orient }, done: () => { be.closeLive(); rmrf(dir); } };
}

test('الصورة تُدوَّر قبل النزع: المدوِّر يُستدعى لاتجاهٍ غير طبيعي ولا يُستدعى للطبيعي · ولا يبقى وسم GPS', async () => {
  const calls: number[] = [];
  const { env, done } = filesEnv(async (b: Uint8Array) => { calls.push(jpegOrientation(b)); return jpeg(1); });
  const read = async (b: Uint8Array, name: string) => {
    const row = await putAttachment(env, b, { entityType: 'library', kind: 'other', originalName: name, mime: 'image/jpeg' });
    return env.fs.read(env.attachmentsDir + '/' + row.sha256 + '.' + row.ext);
  };
  const turned = await read(jpeg(6), 'a.jpg');
  expect(calls).toEqual([6]);
  expect(jpegOrientation(turned)).toBe(1);
  expect(hasGps(turned)).toBe(false);
  const plain = await read(jpeg(1, true), 'b.jpg');
  expect(calls).toEqual([6]);
  expect(hasGps(plain)).toBe(false);
  done();
});

test('وما تعذّر تدويره يبقى فيه وسم الاتجاه وحده بلا GPS', async () => {
  const { env, done } = filesEnv(async () => null);
  const row = await putAttachment(env, jpeg(6), { entityType: 'library', kind: 'other', originalName: 'c.jpg', mime: 'image/jpeg' });
  const out = env.fs.read(env.attachmentsDir + '/' + row.sha256 + '.' + row.ext);
  expect(jpegOrientation(out)).toBe(6);
  expect(hasGps(out)).toBe(false);
  done();
});

/** JPEG مصطنع بمقاطع يختارها الاختبار بعد SOI · ثم SOS وبيانات وEOI */
const seg2 = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const GPS = ascii('GPS35');
const has = (b: Uint8Array, s: number[]) => Buffer.from(b).includes(Buffer.from(s));
function jpegWith(segs: number[][], tail: number[] = []): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...segs.flat(), 0xff, 0xdb, 0x00, 0x04, 0x00, 0x01,
    0xff, 0xda, 0x00, 0x02, 0x11, 0xff, 0x00, 0x22, 0xff, 0xd3, 0x33, 0xff, 0xd9, ...tail]);
}

test('الجولة ٣٥ (د): ما بعد EOI لا يُنسخ (صورةٌ ثانوية فيها موقع) · وMPF وCOM وAPP11 تُنزع · وICC وAdobe وJFIF تبقى', () => {
  const icc = seg2(0xe2, [...ascii('ICC_PROFILE'), 0, 1, 1, 9, 9]);
  const adobe = seg2(0xee, [...ascii('Adobe'), 0, 1]);
  const src = jpegWith([seg2(0xe0, [...ascii('JFIF'), 0, 1, 2]), icc, seg2(0xe2, [...ascii('MPF'), 0, ...GPS]), seg2(0xfe, GPS),
    seg2(0xeb, [...ascii('JP'), ...GPS]), adobe], [0xff, 0xd8, ...seg2(0xe1, [...ascii('Exif'), 0, 0, ...GPS]), 0xff, 0xd9]);
  const out = stripImageMetadata(src);
  expect(has(out, GPS)).toBe(false);
  expect(has(out, icc)).toBe(true);
  expect(has(out, adobe)).toBe(true);
  expect(has(out, ascii('JFIF'))).toBe(true);
  expect(Array.from(out.subarray(out.length - 2))).toEqual([0xff, 0xd9]);
  // بيانات المسح كما هي ومعها الحشو وإعادة التشغيل
  expect(has(out, [0x11, 0xff, 0x00, 0x22, 0xff, 0xd3, 0x33])).toBe(true);
});

test('الجولة ٣٥ (د): بايتات الحشو قبل العلامة لا تعيد الأصل · ووسم الاتجاه بنوع LONG يُقرأ · ويُدرج بعد APP0', () => {
  const exif = seg2(0xe1, [...ascii('Exif'), 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 4, 0, 0, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, ...GPS]);
  const src = jpegWith([seg2(0xe0, [...ascii('JFIF'), 0]), [0xff], exif]);
  expect(jpegOrientation(src)).toBe(6);
  const out = stripImageMetadata(src, 6);
  expect(has(out, GPS)).toBe(false);
  expect(jpegOrientation(out)).toBe(6);
  // APP0 أولاً بعد SOI كما يشترط JFIF، ثم مقطع الاتجاه
  expect(Array.from(out.subarray(0, 4))).toEqual([0xff, 0xd8, 0xff, 0xe0]);
});

test('الجولة ٣٥ (د): HEIC يُحوَّل JPEG قبل النزع · وبلا محوِّل أو ببنيةٍ غير متوقعة لا يُرفق ويُذكر الخيار', async () => {
  const heic = Uint8Array.from([0, 0, 0, 0x18, ...ascii('ftypheic'), 0, 0, 0, 0, ...ascii('mif1heic'), ...GPS]);
  const conv = filesEnv(async () => jpeg(1));
  const row = await putAttachment(conv.env, heic, { entityType: 'library', kind: 'other', originalName: 'h.heic', mime: 'image/heic' });
  expect(row.ext).toBe('jpg');
  expect(hasGps(conv.env.fs.read(conv.env.attachmentsDir + '/' + row.sha256 + '.' + row.ext))).toBe(false);
  conv.done();
  const none = filesEnv(async () => null);
  await expect(putAttachment(none.env, heic, { entityType: 'library', kind: 'other', originalName: 'h2.heic', mime: 'image/heic' }))
    .rejects.toThrow(/أطفئ/);
  await expect(putAttachment(none.env, Uint8Array.from([0xff, 0xd8, 0x12, 0x34, ...GPS]), { entityType: 'library', kind: 'other', originalName: 'bad.jpg', mime: 'image/jpeg' }))
    .rejects.toThrow(/أطفئ/);
  none.done();
});
