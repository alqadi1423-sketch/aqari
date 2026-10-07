/**
 * تفضيلات المستخدم في مستنده users/{uid} (يقرؤه ويكتبه صاحبه وحده في قواعد Firestore) ·
 * اليوم لغة الواجهة ووقت اختيارها (قرار المالك ٢٠٢٦-١٠-٠٧: تتبع المستخدم على كل أجهزته).
 * الكتابة بقناع الحقلين وحدهما فلا يُمسّ غيرهما في المستند.
 */
import type { CloudLang } from '../i18n/sync';
import { parseLangPref } from '../i18n';

export interface UserPrefsTarget { projectId: string; uid: string; idToken: () => Promise<string>; baseUrl?: string; fetchImpl?: typeof fetch }

const docUrl = (t: UserPrefsTarget) =>
  `${(t.baseUrl ?? 'https://firestore.googleapis.com').replace(/\/$/, '')}/v1/projects/${t.projectId}/databases/(default)/documents/users/${t.uid}`;

export async function getCloudLang(t: UserPrefsTarget): Promise<CloudLang | null> {
  const f = t.fetchImpl ?? fetch;
  const res = await f(docUrl(t) + '?mask.fieldPaths=langPref&mask.fieldPaths=langAt', { headers: { Authorization: 'Bearer ' + (await t.idToken()) } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('prefs ' + res.status);
  const j = (await res.json()) as { fields?: Record<string, { stringValue?: string }> };
  const pref = j.fields?.langPref?.stringValue;
  const at = j.fields?.langAt?.stringValue;
  return pref && at ? { pref: parseLangPref(pref), at } : null;
}

export async function putCloudLang(t: UserPrefsTarget, c: CloudLang): Promise<void> {
  const f = t.fetchImpl ?? fetch;
  const res = await f(docUrl(t) + '?updateMask.fieldPaths=langPref&updateMask.fieldPaths=langAt', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await t.idToken()) },
    body: JSON.stringify({ fields: { langPref: { stringValue: c.pref }, langAt: { stringValue: c.at } } }),
  });
  if (!res.ok) throw new Error('prefs ' + res.status);
}
