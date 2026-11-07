/**
 * سرّ النسخ الاحتياطية (التوجيه الرابع ٤ · ٣ · قرار المالك 2026-11-07 «تشفير النسخ الاحتياطي إجبارياً مع مفتاح استرداد يظهر مرة»):
 * مفتاح الاسترداد (domain/backup/recoveryKey.ts) يولّده الجهاز ويُعرض مرة، ويُحفظ في مخزن النظام الآمن (Keystore) على هذا الجهاز وحده
 * بعد أن يكتب المستخدم آخر مجموعةٍ منه · فتُشفَّر به كل نسخةٍ تُصدَّر أو تُرفع إلى Drive بلا سؤال، ولا نسخة تخرج بلا تشفير.
 *
 * **لكل حسابٍ سرّه** (المدقق الخارجي D١): الجهاز يحمل أكثر من حساب (accountSlots.ts: «البيانات ملك الحساب لا الجهاز»)، وكان السرّ
 * واحداً للجهاز فتُختم نسخ الحساب الداخل بمفتاح غيره الذي لم يره · فالسرّ وعلامته باسم الحساب، وما بلا حسابٍ باسم «_local» · والسرّ
 * القديم الواحد للجهاز (قبل هذا) يأخذه أول حسابٍ يطلبه بعد التحديث ثم يُمحى اسمه القديم.
 * **والسرّ السابق يبقى** (D٢): إنشاء المفتاح أو استبداله يحفظ ما قبله (كلمة المرور القديمة أو المفتاح السابق) سرّاً سابقاً يُجرَّب عند
 * الاستعادة بلا سؤال، فالنسخ القديمة تُفتح كما كانت · ولا يُختم به جديد.
 * لا يُرفع السرّ ولا يُزامَن ولا يُكتب في نسخة، ونسيانه لا يُعوَّض: لا مفتاح خلفي · ومعه علامةٌ في ملفات التطبيق تقول إنه وُضع (ونوعه)،
 * فلا تخرج نسخةٌ إن تعذّرت قراءته (domain/backup/passwordGate.ts)
 */
import * as SecureStore from 'expo-secure-store';
import { File, Paths } from 'expo-file-system';
import { getRandomBytes } from 'expo-crypto';
import { passwordState, secretForSealing, type PasswordStore } from '../domain/backup/passwordGate';
import { generateRecoveryKey, isValidRecoveryKey, sealingSecretOf } from '../domain/backup/recoveryKey';
import { t } from '../i18n';

/** اسما السرّ وعلامته قبل أن يصيرا لكل حساب · يأخذهما أول حسابٍ يطلب سرّه */
const LEGACY_KEY = 'aqari_backup_password';
const LEGACY_FLAG = 'backup-password.flag';
/** محتوى العلامة: «key» لمفتاح الاسترداد، وغيره لكلمة مرورٍ قبله */
const KIND_KEY = 'key';
/** ما يُحفظ من الأسرار السابقة */
const KEEP_PREVIOUS = 5;

const slotOf = (account: string | null | undefined): string =>
  account ? account.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) : '_local';
const keyOf = (slot: string) => 'aqari_backup_secret_' + slot;
const previousKeyOf = (slot: string) => 'aqari_backup_secret_' + slot + '_prev';
const flagFile = (slot: string) => new File(Paths.document, 'backup-secret-' + slot + '.flag');
const legacyFlag = () => new File(Paths.document, LEGACY_FLAG);

const exists = (f: File): boolean => { try { return f.exists; } catch { return false; } };

/** السرّ القديم الواحد للجهاز يصير سرّ هذا الحساب مرةً · قبل أي قراءة */
async function claimLegacy(slot: string): Promise<void> {
  const mine = flagFile(slot);
  if (exists(mine)) return;
  let legacy: string | null = null;
  try { legacy = (await SecureStore.getItemAsync(LEGACY_KEY)) || null; } catch { legacy = null; }
  const lf = legacyFlag();
  const flagged = exists(lf);
  if (!legacy && !flagged) return;
  if (legacy) await SecureStore.setItemAsync(keyOf(slot), legacy);
  let kind = '1';
  try { if (flagged) kind = lf.textSync().trim() || '1'; } catch { kind = '1'; }
  mine.write(kind);
  try { if (legacy) await SecureStore.deleteItemAsync(LEGACY_KEY); } catch { /* يُمحى في المرة التالية */ }
  try { if (flagged) lf.delete(); } catch { /* يُمحى في المرة التالية */ }
}

function storeOf(slot: string): PasswordStore {
  return {
    get: async () => (await SecureStore.getItemAsync(keyOf(slot))) || null,
    // تعذّر فحص العلامة يُعدّ «وُضعت»: لا تخرج نسخةٌ بلا تشفير بالشك (المتحقق المستقل)
    flagged: () => { try { return flagFile(slot).exists; } catch { return true; } },
    setFlag: (on) => {
      const f = flagFile(slot);
      if (on) { if (!f.exists) f.write('1'); } else if (f.exists) f.delete();
    },
  };
}

async function readPrevious(slot: string): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(previousKeyOf(slot));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && !!x) : [];
  } catch { return []; }
}

/** أسرار الحساب لتجربتها أولاً عند استعادة نسخةٍ مشفّرة: الحالي ثم السابقة · ولا يُختم بغير الحالي */
export async function getBackupPasswords(account: string | null): Promise<string[]> {
  const slot = slotOf(account);
  try { await claimLegacy(slot); } catch { /* يُقرأ ما هو قائم */ }
  let cur: string | null = null;
  try { cur = (await SecureStore.getItemAsync(keyOf(slot))) || null; } catch { cur = null; }
  return [...new Set([...(cur ? [cur] : []), ...(await readPrevious(slot))])];
}

/** مفتاح استرداد محفوظ، أو كلمة مرورٍ قديمة، أو لا شيء، أو وُضع وتعذّرت قراءته */
export type SecretKind = 'key' | 'password' | 'off' | 'lost';

export async function backupSecretKind(account: string | null): Promise<SecretKind> {
  const slot = slotOf(account);
  try { await claimLegacy(slot); } catch { /* يُقرأ ما هو قائم */ }
  const st = await passwordState(storeOf(slot));
  if (st !== 'on') return st;
  try { const f = flagFile(slot); return f.exists && f.textSync().trim() === KIND_KEY ? 'key' : 'password'; } catch { return 'password'; }
}

/** للتصدير والرفع: سرّ الحساب دائماً · ترمي إن لم يُنشأ مفتاحه (RecoveryKeyRequiredError) أو تعذّرت قراءته */
export async function backupSecretForSealing(account: string | null): Promise<string> {
  const slot = slotOf(account);
  try { await claimLegacy(slot); } catch { /* يُقرأ ما هو قائم */ }
  return secretForSealing(storeOf(slot));
}

/** مفتاحٌ جديد من مولّد النظام · يُعرض ولا يُحفظ حتى يؤكَّد بـ saveRecoveryKey */
export const newRecoveryKey = (): string => generateRecoveryKey((n) => getRandomBytes(n));

/** حفظ المفتاح بعد تأكيده لهذا الحساب · يحلّ محل السرّ الحالي للنسخ القادمة، والحالي يُحفظ سرّاً سابقاً تُفتح به النسخ السابقة */
export async function saveRecoveryKey(key: string, account: string | null): Promise<void> {
  if (!isValidRecoveryKey(key)) throw new Error(t('backup.key.invalid'));
  const slot = slotOf(account);
  try { await claimLegacy(slot); } catch { /* يُكتب الجديد */ }
  let cur: string | null = null;
  try { cur = (await SecureStore.getItemAsync(keyOf(slot))) || null; } catch { cur = null; }
  const next = sealingSecretOf(key);
  if (cur && cur !== next) {
    const prev = [cur, ...(await readPrevious(slot)).filter((x) => x !== cur && x !== next)].slice(0, KEEP_PREVIOUS);
    await SecureStore.setItemAsync(previousKeyOf(slot), JSON.stringify(prev));
  }
  await SecureStore.setItemAsync(keyOf(slot), next);
  const f = flagFile(slot);
  if (f.exists) f.delete();
  f.write(KIND_KEY);
}

/** تفريغ الجهاز من الحساب (deviceReset.ts): يُمحى سرّه وسوابقه وعلامته، ومعها اسم الجهاز القديم · ولا زرّ في الواجهة يزيله، فالتشفير إجباري */
export async function clearBackupSecretForReset(account: string | null): Promise<void> {
  const slot = slotOf(account);
  for (const k of [keyOf(slot), previousKeyOf(slot), LEGACY_KEY]) {
    try { await SecureStore.deleteItemAsync(k); } catch { /* التالي */ }
  }
  for (const f of [flagFile(slot), legacyFlag()]) {
    try { if (f.exists) f.delete(); } catch { /* التالي */ }
  }
}
