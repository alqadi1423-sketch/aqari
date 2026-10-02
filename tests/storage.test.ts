/**
 * المساحة بلا مساس بالجودة · جدول تحقق المالك:
 * الملف يُحفظ بايتاً ببايت كما رُفع، نفس الملف على كيانين = ملف واحد ومرجعان،
 * تفريغ السلة يحذف الملف من القرص فعلاً، ونزع EXIF حذف تعريفي لا يمسّ البكسل.
 */
import * as path from 'node:path';
import * as fsNode from 'node:fs';
import * as os from 'node:os';
import { makeBackupEnv } from './helpers/backupEnv';
import { putAttachment, softDeleteAttachment, gcBlobs, attachmentPath, liveBlobs } from '@/files/store';
import { stripJpegExif } from '@/domain/jpegExif';

const mkroot = () => fsNode.mkdtempSync(path.join(os.tmpdir(), 'aq-storage-'));

describe('المخزن · الجودة الأصلية والتكرار والتحرير', () => {
  test('بايت ببايت: المحفوظ مطابق تماماً للمرفوع — ٥ ميغا تُحفظ ٥ ميغا', async () => {
    const env = makeBackupEnv(mkroot());
    const bytes = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const att = await putAttachment(env.filesEnv, bytes, {
      entityType: 'unit', entityId: 'U1', kind: 'photo', originalName: 'ضرر.jpg', mime: 'image/jpeg',
    });
    expect(att.size_bytes).toBe(bytes.byteLength);
    const stored = env.fs.read(attachmentPath(env.filesEnv, att));
    expect(stored.byteLength).toBe(bytes.byteLength);
    expect(Buffer.from(stored).equals(Buffer.from(bytes))).toBe(true); // بايت ببايت
    env.closeLive();
  });

  test('نفس الصورة على وحدتين: ملف واحد على القرص ومرجعان في القاعدة', async () => {
    const env = makeBackupEnv(mkroot());
    const bytes = new Uint8Array(4096).fill(0xab);
    const a1 = await putAttachment(env.filesEnv, bytes, {
      entityType: 'unit', entityId: 'U1', kind: 'photo', originalName: 'صورة.jpg', mime: 'image/jpeg',
    });
    const a2 = await putAttachment(env.filesEnv, bytes, {
      entityType: 'unit', entityId: 'U2', kind: 'photo', originalName: 'صورة.jpg', mime: 'image/jpeg',
    });
    expect(a1.sha256).toBe(a2.sha256);
    const blobRows = env.db.all(`SELECT sha256 FROM blobs`);
    expect(blobRows).toHaveLength(1);
    const attRows = env.db.all(`SELECT id FROM attachments WHERE sha256 = ?`, [a1.sha256]);
    expect(attRows).toHaveLength(2);
    const files = env.fs.list(env.filesEnv.attachmentsDir);
    expect(files).toHaveLength(1);
    env.closeLive();
  });

  test('حذف المرفق وتفريغ السلة: الملف يُحذف من القرص فعلاً والمساحة تنقص', async () => {
    const env = makeBackupEnv(mkroot());
    const bytes = new Uint8Array(2048).fill(0x5c);
    const att = await putAttachment(env.filesEnv, bytes, {
      entityType: 'unit', entityId: 'U1', kind: 'photo', originalName: 'قديمة.jpg', mime: 'image/jpeg',
    });
    const p = attachmentPath(env.filesEnv, att);
    expect(env.fs.exists(p)).toBe(true);
    softDeleteAttachment(env.db, att.id);
    // ما دام في السلة (ضمن المهلة) الملف يبقى
    expect(gcBlobs(env.filesEnv, 30)).toBe(0);
    expect(env.fs.exists(p)).toBe(true);
    // تفريغ فوري (مهلة صفر) = تحرير القرص
    env.db.run(`DELETE FROM attachments WHERE id = ?`, [att.id]);
    expect(gcBlobs(env.filesEnv, 0)).toBe(1);
    expect(env.fs.exists(p)).toBe(false);
    expect(liveBlobs(env.db)).toHaveLength(0);
    env.closeLive();
  });
});

describe('نزع EXIF · حذف تعريفي بلا إعادة ترميز', () => {
  // JPEG اصطناعي: SOI + APP1(Exif) + DQT + SOS + بيانات + EOI
  const seg = (marker: number, payload: number[]) => {
    const len = payload.length + 2;
    return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
  };
  const exifPayload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x11, 0x22, 0x33];
  const dqtPayload = [0x00, 0x01, 0x02, 0x03];
  const sosAndData = [0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0xaa, 0xbb, 0xcc, 0xff, 0xd9];
  const jpeg = new Uint8Array([0xff, 0xd8, ...seg(0xe1, exifPayload), ...seg(0xdb, dqtPayload), ...sosAndData]);

  test('يزيل مقطع Exif ويبقي بيانات البكسل (بعد SOS) كما هي حرفياً', () => {
    const out = stripJpegExif(jpeg);
    expect(out.byteLength).toBe(jpeg.byteLength - (exifPayload.length + 4));
    // لا Exif في الناتج
    expect(Array.from(out).join(',')).not.toContain('69,120,105,102'); // 'Exif'
    // بيانات SOS حتى EOI محفوظة بايت ببايت
    const tail = out.subarray(out.byteLength - sosAndData.length);
    expect(Array.from(tail)).toEqual(sosAndData);
  });

  test('صورة بلا EXIF أو ملف ليس JPEG: يُعاد الأصل نفسه دون تغيير', () => {
    const noExif = new Uint8Array([0xff, 0xd8, ...seg(0xdb, dqtPayload), ...sosAndData]);
    expect(stripJpegExif(noExif)).toBe(noExif);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    expect(stripJpegExif(png)).toBe(png);
  });

  test('بنية مبتورة أو غير متوقعة: الأصل يُعاد كما هو — لا نجازف بمستند', () => {
    const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, 0x45]);
    expect(stripJpegExif(truncated)).toBe(truncated);
  });
});

describe('جدول بصمات عشرة ملفات · المسجَّل في القاعدة = المحسوب من القرص', () => {
  test('sha256 المخزَّن يطابق بصمة الملف الفعلي بايتاً ببايت للعشرة كلها', async () => {
    const env = makeBackupEnv(mkroot());
    const names = ['صك.pdf', 'هوية.jpg', 'عقد.pdf', 'ضرر1.jpg', 'ضرر2.jpg', 'فاتورة-كهرباء.pdf', 'فاتورة-ماء.jpg', 'محضر.pdf', 'مخطط.png', 'إيصال.jpg'];
    const rows: string[] = [];
    let allMatch = true;
    for (let i = 0; i < 10; i++) {
      const bytes = new Uint8Array(3000 + i * 137);
      for (let b = 0; b < bytes.length; b++) bytes[b] = (b * (i + 3) + 11) & 0xff;
      const att = await putAttachment(env.filesEnv, bytes, {
        entityType: 'unit', entityId: 'U' + i, kind: 'photo', originalName: names[i], mime: 'application/octet-stream',
      });
      const onDisk = env.fs.read(attachmentPath(env.filesEnv, att));
      const recomputed = await env.filesEnv.hasher(onDisk);
      const match = recomputed === att.sha256;
      allMatch = allMatch && match;
      rows.push(`${names[i]} | مسجَّلة ${att.sha256.slice(0, 12)}… | محسوبة ${recomputed.slice(0, 12)}… | ${match ? 'مطابقة' : 'مختلفة!'}`);
      expect(recomputed).toBe(att.sha256);
    }
    console.log('جدول البصمات (10 ملفات):\n' + rows.join('\n'));
    expect(allMatch).toBe(true);
    env.closeLive();
  });
});
