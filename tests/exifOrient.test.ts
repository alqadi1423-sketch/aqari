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
