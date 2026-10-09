/**
 * مراجعة التثبيت #49: قنابل فكّ الضغط وكثرة الدورات · لا حجز بالحجم المعلن، ولا فكّ PDF بلا سقف، ولا دورات مفتاح
 * يحددها الملف بلا حدّ معقول · بيانات مصطنعة.
 */
import { zipSync, deflateSync } from 'fflate';
import { unzipYielding, ZipFormatError } from '@/domain/backup/zipStream';
import { encryptArchive, decryptArchive, WrongPasswordError, type CipherProvider } from '@/domain/backup/encryption';
import { nodeCipher } from '@/files/nodeCipher';
import { inflateCapped } from '@/domain/pdf/miniPdfText';

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
