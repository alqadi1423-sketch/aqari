/**
 * كلمة مرور النسخ لا تسقط بصمت (المراجعات الخارجية «ثالثاً أ ٩» · قرار المالك 2026-10-09): علامةٌ على الجهاز خارج المخزن الآمن
 * تقول إن كلمة مرورٍ وُضعت · فإن تعذّرت قراءتها (مخزنٌ آمنٌ تالف، أو جهازٌ استُعيدت ملفاته بلا مفاتيحه) توقف التصدير والرفع
 * ولا تخرج النسخة بلا تشفير، حتى يضع المستخدم كلمته من جديد أو يزيلها بنفسه
 */
import { t } from '../../i18n';

export interface PasswordStore {
  /** الكلمة من المخزن الآمن · قد يرمي */
  get(): Promise<string | null>;
  /** علامة «وُضعت كلمة مرور» · خارج المخزن الآمن · وتعذّر فحصها يُعدّ «وُضعت» (لا تخرج نسخةٌ بلا تشفير بالشك) */
  flagged(): boolean;
  setFlag(on: boolean): void;
}

export type PasswordState = 'on' | 'off' | 'lost';

export class BackupPasswordLostError extends Error {
  constructor() {
    super(t('backup.passwordLost'));
    this.name = 'BackupPasswordLostError';
  }
}

async function read(s: PasswordStore): Promise<string | null> {
  try { return (await s.get()) || null; } catch { return null; }
}

/** الحال والكلمة من قراءةٍ واحدة (المتحقق المستقل: قراءةٌ ثانية تتعذّر عابرةً كانت تُخرج النسخة بلا تشفير) */
async function stateAndPassword(s: PasswordStore): Promise<{ st: PasswordState; pw: string | null }> {
  const pw = await read(s);
  if (pw) {
    // كلمةٌ وُضعت قبل العلامة: تُعلَّم الآن
    if (!s.flagged()) { try { s.setFlag(true); } catch { /* تُعلَّم في المرة التالية */ } }
    return { st: 'on', pw };
  }
  return { st: s.flagged() ? 'lost' : 'off', pw: null };
}

export async function passwordState(s: PasswordStore): Promise<PasswordState> {
  return (await stateAndPassword(s)).st;
}

/** الكلمة التي تُختم بها النسخة قبل تصديرها أو رفعها · null بلا كلمة · وترمي إن وُضعت كلمةٌ تعذّرت قراءتها */
export async function passwordForSealing(s: PasswordStore): Promise<string | null> {
  const { st, pw } = await stateAndPassword(s);
  if (st === 'lost') throw new BackupPasswordLostError();
  return pw;
}
