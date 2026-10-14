/**
 * مراجعة التثبيت #49: قنابل فكّ الضغط وكثرة الدورات · لا حجز بالحجم المعلن، ولا فكّ PDF بلا سقف، ولا دورات مفتاح
 * يحددها الملف بلا حدّ معقول · بيانات مصطنعة.
 */
import { zipSync, deflateSync } from 'fflate';
import { unzipYielding, ZipFormatError } from '@/domain/backup/zipStream';
import { encryptArchive, decryptArchive, WrongPasswordError, type CipherProvider } from '@/domain/backup/encryption';
import { nodeCipher } from '@/files/nodeCipher';
import { inflateCapped, extractPdfText } from '@/domain/pdf/miniPdfText';

/** يرفع «الحجم بعد الفك» في الفهرس المركزي إلى قيمة ضخمة · كما يفعل مزوّر */
function forgeUsize(zip: Uint8Array, usize: number): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer);
  for (let i = out.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x02014b50) { dv.setUint32(i + 24, usize, true); return out; }
  }
  throw new Error('no central directory');
}

test('حجمٌ معلن ضخم لمدخلٍ صغير يُرفض قبل أي حجز', async () => {
  const zip = zipSync({ 'data.db': new Uint8Array(4096).fill(7) }, { level: 9 });
  await expect(unzipYielding(forgeUsize(zip, 0xFFFFFFF0))).rejects.toBeInstanceOf(ZipFormatError);
});

test('المدخل الكبير يتوقف فكّه عند تجاوز حجمه المعلن', async () => {
  const big = new Uint8Array(6 << 20);
  for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24; // غير قابل للضغط كثيراً · فيمرّ بطريق القطع
  const zip = zipSync({ 'data.db': big }, { level: 1 });
  await expect(unzipYielding(forgeUsize(zip, 1 << 20))).rejects.toBeInstanceOf(ZipFormatError);
});

test('فكّ مجرى PDF له سقف', () => {
  const bomb = deflateSync(new Uint8Array(64 << 20));
  expect(inflateCapped(bomb, 8 << 20)).toBeNull();
  expect(inflateCapped(deflateSync(new Uint8Array(1000).fill(65)), 8 << 20)?.length).toBe(1000);
});

test('دورات مفتاحٍ فوق الحد المعقول ترفض الملف قبل الاشتقاق', async () => {
  let derived = 0;
  const spy: CipherProvider = { ...nodeCipher, pbkdf2: async (...a) => { derived++; return nodeCipher.pbkdf2(...a); } };
  const sealed = await encryptArchive(new Uint8Array(100), 'كلمة مصطنعة', nodeCipher, { iterations: 1000 });
  const forged = sealed.slice();
  new DataView(forged.buffer).setUint32(9, 40_000_000, false);
  await expect(decryptArchive(forged, 'كلمة مصطنعة', spy)).rejects.toBeInstanceOf(WrongPasswordError);
  expect(derived).toBe(0);
});

/* ═══ المراجعة الخارجية ٧ · النتيجتان ١١ و١٢ ═══ */

test('١١ PDF بمئتي مجرى من ١٦ م.ب يُرفض بـ «pdf» سريعاً (لا ميزانية إجمالية كانت)', () => {
  const z = deflateSync(new Uint8Array(16 << 20));
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [enc.encode('%PDF-1.4\n')];
  for (let i = 1; i <= 200; i++) {
    parts.push(enc.encode(i + ' 0 obj\n<< /Length ' + z.length + ' /Filter /FlateDecode >>\nstream\n'), z, enc.encode('\nendstream\nendobj\n'));
  }
  parts.push(enc.encode('%%EOF\n'));
  const pdf = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of parts) { pdf.set(x, o); o += x.length; }
  const t0 = Date.now();
  expect(() => extractPdfText(pdf)).toThrow('pdf');
  // معيار الإغلاق ثانيتان منفرداً (قيس ٢٫١ ث مع البناء) · والحد هنا أوسع لحِمل الحزمة كاملة (٢٢ ث قيست تحت حملها) · والفيصل الرفضُ نفسه: القديم يفكّ ٣٫٢ غ.ب ولا يرفض
  expect(Date.now() - t0).toBeLessThan(60000);
});

/** حجمٌ معلن لكل مدخل في الفهرس المركزي */
function forgeAllUsize(zip: Uint8Array, usize: number): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.length; i++) if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, usize, true);
  return out;
}

test('١٢ (أ) مدخلٌ مضغوط بحجمٍ معلن صفر وفيه بيانات يُرفض قبل فكّه', async () => {
  const zip = zipSync({ 'data.db': new Uint8Array(4 << 20) }, { level: 9 });
  await expect(unzipYielding(forgeUsize(zip, 0))).rejects.toBeInstanceOf(ZipFormatError);
});

test('١٢ (ب) مجموع الأحجام المعلنة فوق ما يتسع يُرفض قبل أي فكّ', async () => {
  const rnd = (n: number, seed: number) => { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };
  const zip = zipSync({ a: rnd(1 << 20, 1), b: rnd(1 << 20, 2), c: rnd(1 << 20, 3) }, { level: 0 });
  // كلٌّ في حدّه وحده (أقل من غ.ب)، ومجموعها فوق الحد
  const forged = forgeAllUsize(zip, 1000 << 20);
  const t0 = Date.now();
  await expect(unzipYielding(forged)).rejects.toThrow(/مجموع/);
  expect(Date.now() - t0).toBeLessThan(2000);
});
