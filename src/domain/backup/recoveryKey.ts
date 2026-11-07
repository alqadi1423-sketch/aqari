/**
 * مفتاح استرداد النسخ الاحتياطية (التوجيه الرابع ٤ · ٣ · قرار المالك 2026-11-07 «تشفير النسخ الاحتياطي إجبارياً مع مفتاح استرداد يظهر
 * مرة»): سرٌّ يولّده الجهاز عشوائياً، يُعرض مرةً واحدة، ولا يُعتمد حتى يكتب المستخدم آخر خمسة أحرفٍ منه دليلاً على حفظه · وبه تُشفَّر
 * كل نسخة تخرج من الجهاز (التصدير وDrive) بالشكل القائم نفسه (encryption.ts: PBKDF2 ثم AES-256-GCM)، فلا يتغيّر شكل الملف.
 *
 * الشكل: ٢٥ محرفاً من أبجدية كروكفورد (٠-٩ وA-Z بلا I وL وO وU) في خمس مجموعات «XXXXX-XXXXX-XXXXX-XXXXX-XXXXX» · أولها ٢٣ عشوائياً
 * (١١٥ بتاً) وآخرها محرفا تحقق يكشفان كل خطأٍ في محرفٍ واحد وكل تبديلٍ لمحرفين متجاورين · والكتابة تتسامح في الشرطات والمسافات وحالة الحروف،
 * وO تُقرأ صفراً وI وL تُقرآن واحداً كما في الأبجدية نفسها.
 * والمفتاح المنسي لا يُستعاد: لا مفتاح خلفي، فالنسخة المشفّرة به لا تُفتح بغيره.
 */

export const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DATA_CHARS = 23;
export const KEY_LENGTH = DATA_CHARS + 2;
const GROUP = 5;

/**
 * محرفا التحقق: مجموع القيم بأوزانٍ متتالية (١ إلى ٢٣) باقي القسمة على ١٠٢١ (أوليٌّ أكبر من كل فرقٍ يحدثه خطأٌ واحد: ٢٣ × ٣١)، بمحرفين
 * · فتغيير محرفٍ يغيّر المجموع بوزنه في الفرق (لا يقسمه ١٠٢١)، وتبديل جارين يغيّره بفرق قيمتيهما
 */
function checkChars(data: string): string {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += (i + 1) * KEY_ALPHABET.indexOf(data[i]);
  const c = sum % 1021;
  return KEY_ALPHABET[Math.floor(c / 32)] + KEY_ALPHABET[c % 32];
}

/** مفتاحٌ جديد من ١٥ بايتاً عشوائياً (يُؤخذ منها ١١٥ بتاً) · random من مولّد النظام (CipherProvider.random) */
export function generateRecoveryKey(random: (n: number) => Uint8Array): string {
  const bytes = random(15);
  if (bytes.length < 15) throw new Error('random');
  let bits = 0;
  let acc = 0;
  let data = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      data += KEY_ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return data.slice(0, DATA_CHARS) + checkChars(data.slice(0, DATA_CHARS));
}

/** ما كتبه المستخدم بلا شرطات ومسافات، بحروفٍ كبيرة، وO صفراً وI وL واحداً · وأرقامٌ عربية هندية تُقرأ لاتينية */
export function normalizeKey(input: string): string {
  return String(input ?? '')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .toUpperCase()
    .replace(/[\s\-_.·]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** مفتاحٌ صحيح الشكل ومحرف التحقق */
export function isValidRecoveryKey(input: string): boolean {
  const k = normalizeKey(input);
  if (k.length !== KEY_LENGTH) return false;
  for (const c of k) if (!KEY_ALPHABET.includes(c)) return false;
  return checkChars(k.slice(0, DATA_CHARS)) === k.slice(DATA_CHARS);
}

/** للعرض: خمس مجموعاتٍ بشرطات */
export function formatRecoveryKey(input: string): string {
  const k = normalizeKey(input);
  const groups: string[] = [];
  for (let i = 0; i < k.length; i += GROUP) groups.push(k.slice(i, i + GROUP));
  return groups.join('-');
}

/** تأكيد الحفظ: آخر مجموعةٍ من المفتاح كما كتبها المستخدم */
export function confirmsRecoveryKey(key: string, typedTail: string): boolean {
  const k = normalizeKey(key);
  const tail = normalizeKey(typedTail);
  return tail.length === GROUP && k.endsWith(tail);
}

/** السرّ الذي تُختم به النسخة: المفتاح بصيغته الموحّدة، فكتابته بشرطاتٍ أو بدونها تفكّ النسخة نفسها */
export const sealingSecretOf = (key: string): string => normalizeKey(key);
