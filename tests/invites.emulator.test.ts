/**
 * مراجعة التثبيت #36 و#41 على محاكي Firestore · بيانات مصطنعة:
 *  #٣٦ الدعوة لا تبقى بعد قبولها ولا بعد إزالة العضو، فلا يعود المُزال بنفسه
 *  #٤١ الدعوة تُقرأ وتُحذف بإيميلٍ متحقَّق وحده
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import { removeMember, acceptInvite, sendInvite, ownOrgExists } from '@/services/org';
import { SCHEMA_VERSION } from '@/db/schema';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'INVOWNER';
const d = HOST ? describe : describe.skip;

function token(uid: string, email: string, verified = true): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: verified, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const remote = (uid: string, email: string) => new FirestoreRemote({ projectId: PROJECT, uid, org: ORG, idToken: async () => token(uid, email), baseUrl: 'http://' + HOST });
const docUrl = (path: string) => `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`;
const put = async (path: string, data: Record<string, unknown>, tok: string) => (await fetch(docUrl(path), {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ fields: encodeFields(data) }) })).status;
const get = async (path: string, tok: string) => (await fetch(docUrl(path), { headers: { Authorization: 'Bearer ' + tok } })).status;

d('الدعوات (مراجعة التثبيت #36 و#41)', () => {
  const EMAIL = 'invited-x@example.test';
  const inv = { email: EMAIL, perm: { collect: 1 }, all: true, props: [], tokens: ['collect|@'] };
  beforeEach(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    expect(await put(`orgs/${ORG}/invites/${EMAIL}`, inv, token(ORG, 'owner-x@example.test'))).toBe(200);
  });

  test('#٣٦ العضوية من الدعوة تحذفها في الالتزام نفسه · وتبقى الدعوة فلا عضوية', async () => {
    expect(await put(`orgs/${ORG}/members/U-INV`, inv, token('U-INV', EMAIL))).toBe(403);
    await remote('U-INV', EMAIL).commitDocs([{ path: `orgs/${ORG}/members/U-INV`, data: inv }], [`orgs/${ORG}/invites/${EMAIL}`]);
    expect(await get(`orgs/${ORG}/invites/${EMAIL}`, token(ORG, 'owner-x@example.test'))).toBe(404);
  });

  test('#٣٦ إزالة العضو تحذف دعوةً باقية بإيميله', async () => {
    expect(await put(`orgs/${ORG}/members/U-OLD`, { ...inv }, token(ORG, 'owner-x@example.test'))).toBe(200);
    await removeMember(remote(ORG, 'owner-x@example.test'), ORG, 'U-OLD', EMAIL);
    expect(await get(`orgs/${ORG}/invites/${EMAIL}`, token(ORG, 'owner-x@example.test'))).toBe(404);
    expect(await get(`orgs/${ORG}/members/U-OLD`, token(ORG, 'owner-x@example.test'))).toBe(404);
  });

  // #36 (قرار المالك 2026-10-09): «والإصدار الأقدم يطلب التحديث قبل الانضمام»
  test('#٣٦ دعوةٌ تطلب إصداراً أحدث لا تُقبل قبل التحديث', async () => {
    expect(await put(`orgs/${ORG}/invites/${EMAIL}`, { ...inv, minApp: SCHEMA_VERSION + 1 }, token(ORG, 'owner-x@example.test'))).toBe(200);
    const { memDb } = await import('./helpers/testDb');
    const db = memDb();
    await expect(acceptInvite(db, remote('U-NEW', EMAIL), ORG, 'U-NEW', { email: EMAIL } as never)).rejects.toThrow();
    expect(await get(`orgs/${ORG}/members/U-NEW`, token(ORG, 'owner-x@example.test'))).toBe(404);
    db.close();
  });

  // مراجعة التثبيت #52: بريد صاحب الدعوة فيها، وتُعرف منشأة الحساب القائمة
  test('#٥٢ الدعوة تحمل بريد صاحبها · ومنشأة الحساب القائمة تُعرف', async () => {
    const owner = remote(ORG, 'owner-x@example.test');
    await sendInvite(owner, ORG, { email: 'second-x@example.test', perms: { collect: 1 }, allProps: true, props: [] }, 'منشأة مصطنعة', 'owner-x@example.test');
    const tok = token(ORG, 'owner-x@example.test');
    const res = await fetch(docUrl(`orgs/${ORG}/invites/second-x@example.test`), { headers: { Authorization: 'Bearer ' + tok } });
    expect(JSON.stringify(await res.json())).toContain('owner-x@example.test');
    expect(await ownOrgExists(remote('U-FRESH', 'fresh-x@example.test'), 'U-FRESH')).toBe(false);
    expect(await put(`orgs/${ORG}/meta/devices`, { letters: {} }, tok)).toBe(200);
    expect(await ownOrgExists(owner, ORG)).toBe(true);
  });

  test('#٤١ الدعوة لا تُقرأ ولا تُحذف بإيميلٍ غير متحقَّق', async () => {
    expect(await get(`orgs/${ORG}/invites/${EMAIL}`, token('U-UNV', EMAIL, false))).toBe(403);
    const del = await fetch(docUrl(`orgs/${ORG}/invites/${EMAIL}`), { method: 'DELETE', headers: { Authorization: 'Bearer ' + token('U-UNV', EMAIL, false) } });
    expect(del.status).toBe(403);
    expect(await get(`orgs/${ORG}/invites/${EMAIL}`, token('U-VER', EMAIL))).toBe(200);
  });
});
