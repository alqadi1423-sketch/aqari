/**
 * المراجعات الخارجية «ثالثاً أ ٨» (قرار المالك 2026-10-09 · وقراراه #2 و#28): «مسح كل البيانات» و«حذف حسابي» يحذفان المحادثات
 * ورسائلها وكل مجموعاتها الفرعية وملفات التخزين · اختبارٌ يمشي شجرة المنشأة كلها بصلاحية المدير في المحاكي (لا بقواعد العميل)
 * فيثبت ألا يبقى شيء · بيانات وملفات مصطنعة.
 *   firebase emulators:exec --only firestore,storage --project demo-aqari "npx jest -i tests/wipeComplete.emulator.test.ts"
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { encodeFields, FirestoreRemote } from '@/cloud/firestore';
import { ChatRemote } from '@/chat/remote';
import { directId } from '@/chat';
import { objectName, uploadObject, listObjects, filesPrefix, type StorageTarget } from '@/cloud/storage';
import { wipeCloud, deleteOwnerCloud } from '@/services/cloudWipe';
import { nodeStorageIO } from './helpers/nodeStorageIO';

const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const ST_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const BUCKET = 'demo-aqari.appspot.com';
const ORG = 'WIPE-OWNER';
const A = 'WIPE-MA';
const B = 'WIPE-MB';
const d = FS_HOST && ST_HOST ? describe : describe.skip;

function token(uid: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email: uid.toLowerCase() + '@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const DOCS = () => `http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const ADMIN = { 'Content-Type': 'application/json', Authorization: 'Bearer owner' };
const chat = (uid: string) => new ChatRemote({ projectId: PROJECT, org: ORG, uid, idToken: async () => token(uid), baseUrl: 'http://' + FS_HOST });
const orgRemote = () => new FirestoreRemote({ projectId: PROJECT, uid: ORG, org: ORG, idToken: async () => token(ORG), baseUrl: 'http://' + FS_HOST });
const legacyRemote = () => new FirestoreRemote({ projectId: PROJECT, uid: ORG, idToken: async () => token(ORG), baseUrl: 'http://' + FS_HOST });
const chatSession = { projectId: PROJECT, uid: ORG, email: ORG.toLowerCase() + '@example.test', idToken: async () => token(ORG), baseUrl: 'http://' + FS_HOST };
const files = () => ({ io: nodeStorageIO, t: { base: 'http://' + ST_HOST, bucket: BUCKET, org: ORG, idToken: async () => token(ORG) } as StorageTarget });

/** كتابة بصلاحية المدير (البذر وحده) */
async function adminPut(rel: string, data: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${DOCS()}/${rel}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ fields: encodeFields(data) }) });
  expect(res.status).toBe(200);
}

/** كل مستندٍ تحت مسار (ومعه الغائب الذي تحته مجموعات) بمشي المدير الشجرةَ كلها · المسارات نسبية لجذر المستندات */
async function walk(rel: string): Promise<string[]> {
  const out: string[] = [];
  const ids = await fetch(`${DOCS()}/${rel}:listCollectionIds`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ pageSize: 300 }) });
  expect(ids.status).toBe(200);
  for (const c of ((await ids.json()) as { collectionIds?: string[] }).collectionIds ?? []) {
    const res = await fetch(`${DOCS()}/${rel}/${c}?showMissing=true&pageSize=300`, { headers: ADMIN });
    expect(res.status).toBe(200);
    for (const doc of ((await res.json()) as { documents?: Array<{ name: string }> }).documents ?? []) {
      const r = doc.name.slice(doc.name.indexOf('/documents/') + '/documents/'.length);
      // مستندٌ غائب لا يُعدّ إلا بما تحته
      const present = (await fetch(`${DOCS()}/${r}`, { headers: ADMIN })).status === 200;
      if (present) out.push(r);
      out.push(...(await walk(r)));
    }
  }
  return out.sort();
}
const exists = async (rel: string) => (await fetch(`${DOCS()}/${rel}`, { headers: ADMIN })).status === 200;

async function seed(): Promise<void> {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${ST_HOST}/emulator/v1/projects/${PROJECT}/buckets/${BUCKET}`, { method: 'DELETE' }).catch(() => {});
  // المنشأة: مستندها وأعضاؤها ودعوةٌ وما في meta وصفوفٌ وإسقاطاتها
  await adminPut(`orgs/${ORG}`, { name: 'منشأة مسح مصطنعة' });
  for (const u of [A, B]) {
    await adminPut(`orgs/${ORG}/members/${u}`, { email: u.toLowerCase() + '@example.test', perm: { contracts: 2 }, all: true, props: [], tokens: [], name: 'عضو ' + u });
  }
  await adminPut(`orgs/${ORG}/invites/new-x@example.test`, { perm: { contracts: 1 }, all: true, props: [] });
  await adminPut(`orgs/${ORG}/meta/counters`, { INV: 7 });
  await adminPut(`orgs/${ORG}/meta/devices`, { n: 2 });
  await adminPut(`orgs/${ORG}/meta/compat`, { min: 1 });
  await adminPut(`orgs/${ORG}/meta/moves`, { n: 0 });
  for (let i = 0; i < 5; i++) await adminPut(`orgs/${ORG}/rows/contracts~R${i}`, { t: 'contracts', k: 'R' + i, u: '2026-01-01', d: '{}' });
  await adminPut(`orgs/${ORG}/rows/contracts~R0~pub`, { t: 'contracts', k: 'R0', u: '2026-01-01', d: '{}' });
  // المسار القديم وتفضيلات المستخدم
  await adminPut(`users/${ORG}`, { langPref: 'ar', langAt: '2026-01-01T00:00:00Z' });
  await adminPut(`users/${ORG}/rows/units~L1`, { t: 'units', k: 'L1', u: '2026-01-01', d: '{}' });
  await adminPut(`users/${ORG}/meta/devices`, { n: 1 });
  // المحادثة بمساراتها الحقيقية: فردية ومجموعة ورسائل وتعديلٌ بسجله وتثبيتٌ وقراءة ومراجعةٌ مفتوحة والدليل والإشراف
  await chat(ORG).setRole('wipe-mb@example.test', ['contracts']);
  // اسم العضو في الدليل اسمه في عضويته، وإشرافه كما سجّله المالك (القواعد)
  for (const u of [ORG, A, B]) await chat(u).putMyDirectory(u === ORG ? 'مالك مصطنع' : 'عضو ' + u, u === B ? ['contracts'] : []);
  const dAB = directId(A, B);
  await chat(A).createThread({ id: dAB, k: 'direct', p: [A, B].sort(), name: '' });
  await chat(A).sendMessage(dAB, { id: 'WM1', name: 'عضو ' + A, body: 'رسالة مصطنعة', link: null });
  await chat(B).sendMessage(dAB, { id: 'WM2', name: 'عضو ' + B, body: 'رد مصطنع', link: null });
  expect(await chat(A).editMessage(dAB, 'WM1', 'رسالة معدلة', null)).toBe(1);
  expect(await chat(A).editMessage(dAB, 'WM1', 'تعديل ثان', null)).toBe(2);
  await chat(A).setPin(dAB, 'WM2', true);
  await chat(ORG).createThread({ id: 'g_wipegroup1', k: 'group', p: [ORG, A, B].sort(), name: 'مجموعة مصطنعة' });
  await chat(B).sendMessage('g_wipegroup1', { id: 'WM3', name: 'عضو ' + B, body: 'في المجموعة', link: null });
  await chat(ORG).openReview(dAB, 'سبب مصطنع');
  // ملفات التخزين
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-wipe-'));
  for (const i of [1, 2]) {
    const file = path.join(dir, `f${i}.bin`);
    const bytes = Buffer.from('ملف مصطنع للمسح ' + i);
    fs.writeFileSync(file, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    await uploadObject(nodeStorageIO, files().t, objectName(ORG, sha, 'bin'), file,
      { g: ['contracts|@'], op: null, sha256: sha, md5: createHash('md5').update(bytes).digest('base64'), contentType: 'application/octet-stream' });
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

d('المسح الكامل (ثالثاً أ ٨)', () => {
  beforeEach(seed);

  test('البذر يصل إلى كل مسار (فلا ينجح الاختبار بشجرةٍ فارغة)', async () => {
    const all = await walk(`orgs/${ORG}`);
    for (const p of ['rows/', 'members/', 'invites/', 'meta/', 'chats/', '/msgs/', '/ids/', '/edits/', '/st/', 'chatDir/', 'chatRoles/', 'chatReviews/', 'chatReviewOpen/']) {
      expect(all.some((x) => x.includes(p))).toBe(true);
    }
    expect((await listObjects(nodeStorageIO, files().t, filesPrefix(ORG))).length).toBe(2);
  });

  test('«مسح كل البيانات»: لا صفّ ولا محادثة ولا رسالة ولا ملف · ويبقى الأعضاء والدعوات وmeta والدليل والإشراف وحدها', async () => {
    const epoch = await wipeCloud({ remote: orgRemote(), chat: chatSession, org: ORG, files: files() });
    expect(epoch).toBe(1);
    const left = await walk(`orgs/${ORG}`);
    const kept = /^orgs\/WIPE-OWNER\/(members|invites|meta|chatDir|chatRoles)\/[^/]+$/;
    expect(left.filter((p) => !kept.test(p))).toEqual([]);
    expect(left.some((p) => p.includes('/members/'))).toBe(true);
    expect(left).not.toContain(`orgs/${ORG}/meta/deletion`);
    expect(await listObjects(nodeStorageIO, files().t, filesPrefix(ORG))).toEqual([]);
  });

  test('«حذف حسابي» للمالك: لا يبقى شيء تحت المنشأة ولا في المسار القديم ولا في التخزين', async () => {
    await deleteOwnerCloud({ remotes: [orgRemote(), legacyRemote()], chat: chatSession, org: ORG, files: files() });
    expect(await walk(`orgs/${ORG}`)).toEqual([]);
    expect(await exists(`orgs/${ORG}`)).toBe(false);
    expect(await walk(`users/${ORG}`)).toEqual([]);
    expect(await exists(`users/${ORG}`)).toBe(false);
    expect(await listObjects(nodeStorageIO, files().t, filesPrefix(ORG))).toEqual([]);
  });

  test('«حذف حسابي» للعضو: مساره ومساره القديم يُحذفان بلا رفض (السرد نفسه كان مرفوضاً)', async () => {
    await adminPut(`users/${A}`, { langPref: 'ar', langAt: '2026-01-01T00:00:00Z' });
    const mine = (org: boolean) => new FirestoreRemote({ projectId: PROJECT, uid: A, ...(org ? { org: A } : {}), idToken: async () => token(A), baseUrl: 'http://' + FS_HOST });
    for (const r of [mine(true), mine(false)]) await r.deleteAllData();
    expect(await walk(`users/${A}`)).toEqual([]);
    expect(await exists(`users/${A}`)).toBe(false);
    expect(await exists(`orgs/${ORG}/members/${B}`)).toBe(true);
  });

  test('سلبي (القاعدة ٩٨): المالك لا يحذف من meta خارج نافذة الحذف · والعضو لا يسردها ولا يحذف منها ولو فُتحت', async () => {
    const as = (uid: string, rel: string, method = 'GET') => fetch(`${DOCS()}/${rel}`, { method, headers: { Authorization: 'Bearer ' + token(uid) } });
    expect((await as(ORG, `orgs/${ORG}/meta/counters`, 'DELETE')).status).toBe(403);
    expect((await as(A, `orgs/${ORG}/meta`)).status).toBe(403);
    await chat(ORG).openDeletionWindow();
    expect((await as(A, `orgs/${ORG}/meta/counters`, 'DELETE')).status).toBe(403);
    expect((await as(A, `orgs/${ORG}/meta/epoch`, 'DELETE')).status).toBe(403);
    // وفي النافذة يسرد المالك ويحذف
    expect((await as(ORG, `orgs/${ORG}/meta`)).status).toBe(200);
    expect((await as(ORG, `orgs/${ORG}/meta/moves`, 'DELETE')).status).toBe(200);
    await chat(ORG).closeDeletionWindow();
  });
});
