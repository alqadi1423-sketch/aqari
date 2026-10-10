/**
 * المراجعات الخارجية «ثالثاً أ ١» (قرار المالك 2026-10-09) · توسيع رؤية الملف في Storage: العضو لا يضيف رمز عقارٍ أو قسمٍ ليس
 * له حق الكتابة فيه · اختبار سلبي يثبت الرفض وإيجابي يثبت أن الإضافة المشروعة تعمل (القاعدة ٩٨) · بيانات وملفات مصطنعة.
 *   firebase emulators:exec --only firestore,storage --project demo-aqari "npx jest -i tests/storageTokens.emulator.test.ts"
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { encodeFields } from '@/cloud/firestore';
import { memberTokens } from '@/sync/acl';
import { objectName, statObject, uploadObject, addTokens, type StorageTarget } from '@/cloud/storage';
import { nodeStorageIO } from './helpers/nodeStorageIO';

const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const ST_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const BUCKET = 'demo-aqari.appspot.com';
const OWNER = 'ST-OWNER';
const MEMBER = 'ST-MEM';
const d = FS_HOST && ST_HOST ? describe : describe.skip;

function token(uid: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email: uid.toLowerCase() + '@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const target = (uid: string): StorageTarget => ({ base: 'http://' + ST_HOST, bucket: BUCKET, org: OWNER, idToken: async () => token(uid) });

d('توسيع رؤية الملف (ثالثاً أ ١)', () => {
  let name = '';
  const perm = { collect: 2, ledger: 1, claims: 2 } as const;

  beforeAll(async () => {
    await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const res = await fetch(`http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${OWNER}/members/${MEMBER}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(OWNER) },
      body: JSON.stringify({ fields: encodeFields({ email: 'st-mem@example.test', perm, all: false, props: ['P1'],
        tokens: memberTokens({ owner: false, perms: perm, allProps: false, props: ['P1'] }) }) }),
    });
    expect(res.status).toBe(200);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-sttok-'));
    const file = path.join(dir, 'f.bin');
    const bytes = Buffer.from('ملف مصطنع لاختبار الرموز ' + Date.now());
    fs.writeFileSync(file, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    name = objectName(OWNER, sha, 'bin');
    const md5 = createHash('md5').update(bytes).digest('base64');
    await uploadObject(nodeStorageIO, target(OWNER), name, file, { g: ['collect|P1', 'collect|@'], op: null, sha256: sha, md5, contentType: 'application/octet-stream' });
  });

  const add = async (tok: string) => {
    const cur = (await statObject(nodeStorageIO, target(OWNER), name))!;
    try { await addTokens(nodeStorageIO, target(MEMBER), name, cur, [tok]); return 'ok'; } catch { return 'denied'; }
  };

  test('سلبي: رمز عقارٍ آخر، وقسمٍ يقرؤه ولا يكتب فيه، و«@» لقسمٍ ليس له، وقسمٍ غير معروف، و«*»', async () => {
    expect(await add('collect|P2')).toBe('denied');
    expect(await add('ledger|P1')).toBe('denied');
    expect(await add('props|@')).toBe('denied');
    expect(await add('xyz|P1')).toBe('denied');
    expect(await add('claims|*')).toBe('denied');
  });

  test('إيجابي: رمز قسمٍ يكتب فيه في عقاره، و«@» لقسمٍ يكتب فيه (مرفقه في قسمه يحمله)', async () => {
    expect(await add('claims|P1')).toBe('ok');
    expect(await add('claims|@')).toBe('ok');
  });
});
