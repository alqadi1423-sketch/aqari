/**
 * «نسيت رمز القفل» بمفتاح الاسترداد للمالك (ق٠-٦ · F-3 · قرار المالك 2026-11-13 س٥: لك (أ) أو (ب)) · يعمل الآن على الجهاز وحده،
 * فلا يُحبس المالك إن أُزيل الدخول بقوقل أو بُني التطبيق بلا سحابة (الطريق السريع §٧.٦) · والعضو لا يُعرض عليه: طريقه شهادة الخادم.
 */
import type { DB } from '../db/adapter';
import { appDb } from '../db/expoAdapter';
import { memberOnDevice, deviceAccountOf } from '../domain/lockReset';
import { backupSecretKind, recoveryKeyMatches } from './backupPassword';

/** يُعرض الطريق: المالك على هذا الجهاز (لا عضوية) ولحسابه مفتاح استرداد محفوظ · وتعذّر القراءة لا يعرضه */
export async function keyResetOffered(db: DB = appDb()): Promise<boolean> {
  try {
    if (memberOnDevice(db)) return false;
    return (await backupSecretKind(deviceAccountOf(db))) === 'key';
  } catch { return false; }
}

/** ما كتبه المالك هو مفتاح استرداد حسابه على هذا الجهاز (كما تُفتح به نسخه) */
export async function checkRecoveryKey(typed: string, db: DB = appDb()): Promise<boolean> {
  if (memberOnDevice(db)) return false;
  return recoveryKeyMatches(typed, deviceAccountOf(db));
}
