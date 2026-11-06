/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ٢١: التشفير والفك كانا يحملان النسخة نحو ثلاث مرات (قطعٌ ثم ضمّها فوق الأصل)، والتحقق
 * بعد التشفير يفكّ الأصل كاملاً · الآن مصفوفة إخراجٍ واحدة بحجمها المعروف، والتحقق قطعةً قطعة بتجزئةٍ متدرجة · بيانات مصطنعة.
 */
import { tempDir } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { encryptArchive, decryptArchive } from '@/domain/backup/encryption';
import { sealBackupFile } from '@/domain/backup/seal';
import { nodeCipher } from '@/files/nodeCipher';
import { nodeHasher } from '@/files/nodeFs';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SIZE = 5 * (1 << 20) + 12345;
const plain = () => { const b = new Uint8Array(SIZE); for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 255; return b; };

/**
 * مكوّن تشفيرٍ يعيد استعمال مصفوفة إخراجه (كما تفعل مكوّناتٌ أصلية): كل قطعةٍ أعادها يُكتب فوقها عند النداء التالي · فما احتفظ
 * بالقطع ليضمّها آخراً يخرج تالفاً، وما نسخ كل قطعةٍ إلى موضعها فوراً يخرج سليماً
 */
function reusingCipher() {
  let lastSeal: Uint8Array | null = null;
  let lastOpen: Uint8Array | null = null;
  return {
    ...nodeCipher,
    seal: async (k: Uint8Array, n: Uint8Array, pl: Uint8Array, aad: Uint8Array) => {
      if (lastSeal) lastSeal.fill(0);
      lastSeal = await nodeCipher.seal(k, n, pl, aad);
      return lastSeal;
    },
    open: async (k: Uint8Array, n: Uint8Array, sl: Uint8Array, aad: Uint8Array) => {
      if (lastOpen) lastOpen.fill(0);
      lastOpen = await nodeCipher.open(k, n, sl, aad);
      return lastOpen;
    },
  };
}

test('٢١ التشفير والفك ينسخان كل قطعة إلى مصفوفة إخراجٍ واحدة بحجمها فوراً ولا يحتفظان بالقطع لضمّها', async () => {
  const p = plain();
  const sealed = await encryptArchive(p, 'كلمة مرور مصطنعة طويلة', reusingCipher(), { iterations: 1000 });
  const back = await decryptArchive(sealed, 'كلمة مرور مصطنعة طويلة', reusingCipher());
  expect(back.length).toBe(SIZE);
  expect(Buffer.from(back).equals(Buffer.from(p))).toBe(true);
  // ونسخةٌ بمكوّنٍ عادي تُفكّ بالمكوّن نفسه كما كانت · والمبتور مرفوض
  const sealed2 = await encryptArchive(p, 'كلمة مرور مصطنعة طويلة', nodeCipher, { iterations: 1000 });
  expect(Buffer.from(sealed2).length).toBe(sealed.length);
  await expect(decryptArchive(sealed2.subarray(0, sealed2.length - 3), 'كلمة مرور مصطنعة طويلة', nodeCipher)).rejects.toThrow();
});

test('٢١ التحقق بعد التشفير لا يفكّ الأصل كاملاً: لا يُجزَّأ بحجم الأصل إلا الأصل نفسه قبل تشفيره', async () => {
  const env = makeBackupEnv(tempDir('aq-seal-'));
  const file = path.join(env.root, 'x.aqbk');
  fs.writeFileSync(file, Buffer.from(plain()));
  const sizes: number[] = [];
  const hasher = async (b: Uint8Array) => { sizes.push(b.length); return nodeHasher(b); };
  await sealBackupFile({ ...env, hasher }, file, 'كلمة مرور مصطنعة طويلة', undefined, 1000);
  expect(sizes.filter((n) => n === SIZE).length).toBe(1);
  const back = await decryptArchive(new Uint8Array(fs.readFileSync(file)), 'كلمة مرور مصطنعة طويلة', nodeCipher);
  expect(back.length).toBe(SIZE);
  env.closeLive();
});
