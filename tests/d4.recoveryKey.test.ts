/**
 * التوجيه الرابع ٤ · ٣: مفتاح استرداد النسخ (قرار المالك 2026-11-07 «تشفير النسخ الاحتياطي إجبارياً مع مفتاح استرداد يظهر مرة»):
 * شكله ومحرف تحققه، وتسامح الكتابة، وتأكيد الحفظ بآخر مجموعة، وأن النسخة المشفّرة به تُفتح بكتابته بأي شكل ولا تُفتح بغيره.
 */
import { randomBytes } from 'crypto';
import {
  generateRecoveryKey, isValidRecoveryKey, normalizeKey, formatRecoveryKey, confirmsRecoveryKey, sealingSecretOf, KEY_LENGTH, KEY_ALPHABET,
} from '@/domain/backup/recoveryKey';
import { encryptArchive, decryptArchive, WrongPasswordError } from '@/domain/backup/encryption';
import { nodeCipher } from '@/files/nodeCipher';

const rnd = (n: number) => new Uint8Array(randomBytes(n));

describe('مفتاح الاسترداد', () => {
  test('خمس مجموعاتٍ من أبجدية كروكفورد، صحيحٌ بمحرف تحققه، ومختلفٌ في كل توليد', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const k = generateRecoveryKey(rnd);
      expect(k).toHaveLength(KEY_LENGTH);
      expect([...k].every((c) => KEY_ALPHABET.includes(c))).toBe(true);
      expect(isValidRecoveryKey(k)).toBe(true);
      expect(formatRecoveryKey(k)).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
      seen.add(k);
    }
    expect(seen.size).toBe(200);
  });

  test('الكتابة تتسامح في الشرطات والمسافات وحالة الحروف وO/I/L والأرقام الهندية', () => {
    const k = generateRecoveryKey(rnd);
    const typed = formatRecoveryKey(k).toLowerCase().replace(/-/g, ' ');
    expect(normalizeKey(typed)).toBe(k);
    expect(isValidRecoveryKey(typed)).toBe(true);
    expect(normalizeKey('o0-il1')).toBe('00111');
    expect(normalizeKey('١٢٣')).toBe('123');
  });

  test('محرف التحقق يكشف تغيير محرفٍ واحد وتبديل جارين', () => {
    for (let n = 0; n < 50; n++) {
      const k = generateRecoveryKey(rnd);
      for (let i = 0; i < KEY_LENGTH; i++) {
        const other = KEY_ALPHABET[(KEY_ALPHABET.indexOf(k[i]) + 1 + (n % 30)) % 32];
        if (other === k[i]) continue;
        expect(isValidRecoveryKey(k.slice(0, i) + other + k.slice(i + 1))).toBe(false);
      }
      for (let i = 0; i < KEY_LENGTH - 1; i++) {
        if (k[i] === k[i + 1]) continue;
        expect(isValidRecoveryKey(k.slice(0, i) + k[i + 1] + k[i] + k.slice(i + 2))).toBe(false);
      }
    }
  });

  test('تأكيد الحفظ بآخر مجموعةٍ وحدها', () => {
    const k = generateRecoveryKey(rnd);
    expect(confirmsRecoveryKey(k, k.slice(-5).toLowerCase())).toBe(true);
    expect(confirmsRecoveryKey(k, k.slice(0, 5))).toBe(k.slice(0, 5) === k.slice(-5));
    expect(confirmsRecoveryKey(k, k.slice(-4))).toBe(false);
  });

  test('النسخة المختومة بالمفتاح تُفتح بكتابته بأي شكل، ولا تُفتح بمفتاحٍ آخر', async () => {
    const k = generateRecoveryKey(rnd);
    const plain = new TextEncoder().encode('نسخة مصطنعة للاختبار'.repeat(100));
    const sealed = await encryptArchive(plain, sealingSecretOf(k), nodeCipher, { iterations: 1000 });
    const opened = await decryptArchive(sealed, sealingSecretOf(formatRecoveryKey(k).toLowerCase()), nodeCipher);
    expect(new TextDecoder().decode(opened)).toBe(new TextDecoder().decode(plain));
    await expect(decryptArchive(sealed, sealingSecretOf(generateRecoveryKey(rnd)), nodeCipher)).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

import { secretForSealing, RecoveryKeyRequiredError, BackupPasswordLostError, type PasswordStore } from '@/domain/backup/passwordGate';

describe('التشفير إجباري: لا نسخة تخرج بلا سرّ', () => {
  const mem = (o: { pw?: string | null; flag?: boolean; broken?: boolean }): PasswordStore => ({
    get: async () => { if (o.broken) throw new Error('keystore'); return o.pw ?? null; },
    flagged: () => !!o.flag,
    setFlag: (on) => { o.flag = on; },
  });

  test('بلا سرٍّ محفوظ: يُرفض بطلب مفتاح الاسترداد، لا نسخةٌ بلا تشفير', async () => {
    await expect(secretForSealing(mem({}))).rejects.toBeInstanceOf(RecoveryKeyRequiredError);
  });

  test('السرّ المحفوظ (المفتاح، أو كلمة المرور القديمة) يُختم به، والمتعذّرة قراءته يُرفض كما كان', async () => {
    const k = generateRecoveryKey(rnd);
    expect(await secretForSealing(mem({ pw: sealingSecretOf(k) }))).toBe(k);
    expect(await secretForSealing(mem({ pw: 'كلمة قديمة مصطنعة' }))).toBe('كلمة قديمة مصطنعة');
    await expect(secretForSealing(mem({ broken: true, flag: true }))).rejects.toBeInstanceOf(BackupPasswordLostError);
  });
});
