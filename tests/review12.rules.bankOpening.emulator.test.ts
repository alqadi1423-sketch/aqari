/**
 * المراجعة ١٢ · بقية المرحلة ١ «حارس القواعد في السحابة» لـ A2.4 (DESIGN §١٣.٢٣، R11-A2.4-2) · على محاكي Firestore (يُتخطّى بلا
 * FIRESTORE_EMULATOR_HOST) · بيانات مصطنعة كلها:
 *  - البنك الذي افتتاحيّه في السحابة غير صفر لا يحذفه العضو (ناعماً أو نهائياً) ولا يستعيده من السلة ولا يغيّر افتتاحيّه، ويعدّل اسمه ·
 *  - والبنك بلا افتتاحيّ يحذفه العضو حذفاً ناعماً كما اليوم · والمالك يكتب كل ذلك.
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/review12.rules.bankOpening.emulator.test.ts"
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import { OWNER_ACCESS, type Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';
import { buildDoc } from '@/sync/engine';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'OWNER-R12BO';
const d = HOST ? describe : describe.skip;

function token(uid: string, email = uid.toLowerCase() + '@example.test'): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const remoteFor = (uid: string, a: Access | null) => new FirestoreRemote({
  projectId: PROJECT, uid, org: ORG, idToken: async () => token(uid), baseUrl: 'http://' + HOST,
  memberTokens: () => (a ? memberTokens(a) : null),
  fullReadTables: () => (a ? fullReadTables(a, SYNC_TABLES.map((t) => t.name)) : new Set()),
  access: () => a ?? OWNER_ACCESS,
});
async function addMember(a: Access): Promise<void> {
  const res = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/members/${a.uid}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(ORG) },
    body: JSON.stringify({ fields: encodeFields({
      email: a.uid!.toLowerCase() + '@example.test', perm: a.perms, all: a.allProps, props: a.props, tokens: memberTokens(a),
      orgName: 'منشأة مصطنعة', name: '', phone: '', nid: '', title: '',
    }) }),
  });
  expect(res.status).toBe(200);
}
const now = () => new Date().toISOString();
const DENIED = { ok: false, code: 'PERMISSION_DENIED' };

d('A2.4 في السحابة · البنك ذو الافتتاحي لا يحذفه العضو', () => {
  const M: Access = { owner: false, uid: 'R12BO-M', perms: { banks: 3 }, allProps: true, props: [] };
  let db: import('@/db/adapter').DB;
  let withOpening = '';
  let noOpening = '';

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addBank } = await import('./helpers/fixtures');
    db = memDb();
    withOpening = addBank(db, 'بنك مصطنع بافتتاحي', 500_000);
    noOpening = addBank(db, 'بنك مصطنع بلا افتتاحي', 0);
    const docs = [buildDoc(db, 'banks', withOpening, 'upsert', now(), 'DEV-OWNER'), buildDoc(db, 'banks', noOpening, 'upsert', now(), 'DEV-OWNER')]
      .map((x) => { const { doc, pub } = annotate(db, x, OWNER_ACCESS); return pub ? { ...doc, companions: [pub] } : doc; });
    expect((await remoteFor(ORG, null).write(docs)).every((r) => r.ok)).toBe(true);
    await addMember(M);
  });
  afterAll(() => db?.close());

  const writeAs = async (a: Access | null, doc: RemoteDoc) =>
    (await remoteFor(a ? a.uid! : ORG, a).write([annotate(db, doc, a ?? OWNER_ACCESS).doc]))[0];
  const bankWith = (id: string, over: Record<string, string | number | null>): RemoteDoc => {
    const cur = buildDoc(db, 'banks', id, 'upsert', now(), 'DEV-M');
    return { ...cur, d: { ...cur.d!, ...over } };
  };
  const tomb = (id: string): RemoteDoc => ({ id: 'banks__' + id, t: 'banks', k: id, u: now(), dev: 'DEV-M', del: true, d: null, dby: M.uid!, pids: ['*'] });

  test('العضو لا يحذف البنك ذا الافتتاحي ناعماً ولا نهائياً، ولا يغيّر افتتاحيّه', async () => {
    expect(await writeAs(M, bankWith(withOpening, { deleted_at: now() }))).toMatchObject(DENIED);
    expect(await writeAs(M, tomb(withOpening))).toMatchObject(DENIED);
    expect(await writeAs(M, bankWith(withOpening, { opening_halalas: 0 }))).toMatchObject(DENIED);
    expect(await writeAs(M, bankWith(withOpening, { opening_halalas: 0, deleted_at: now() }))).toMatchObject(DENIED);
    expect(await writeAs(M, bankWith(withOpening, { opening_halalas: 900_000 }))).toMatchObject(DENIED);
  });

  test('ويعدّل اسمه وبياناته الأخرى', async () => {
    expect(await writeAs(M, bankWith(withOpening, { name: 'بنك مصطنع باسمٍ جديد', iban: 'SA0000000000000000000000' }))).toMatchObject({ ok: true });
  });

  test('البنك بلا افتتاحي: العضو يعدّله ويحذفه حذفاً ناعماً كما اليوم، ولا يحذفه نهائياً', async () => {
    expect(await writeAs(M, bankWith(noOpening, { name: 'بنك مصطنع آخر' }))).toMatchObject({ ok: true });
    expect(await writeAs(M, tomb(noOpening))).toMatchObject(DENIED);
    expect(await writeAs(M, bankWith(noOpening, { name: 'بنك مصطنع آخر', deleted_at: now() }))).toMatchObject({ ok: true });
  });

  test('المالك يحذف ذا الافتتاحي ناعماً، والعضو لا يستعيده من السلة، والمالك يستعيده ويغيّر افتتاحيّه', async () => {
    const trashed = now();
    expect(await writeAs(null, bankWith(withOpening, { deleted_at: trashed }))).toMatchObject({ ok: true });
    db.run(`UPDATE banks SET deleted_at = ? WHERE id = ?`, [trashed, withOpening]);
    expect(await writeAs(M, bankWith(withOpening, { deleted_at: null }))).toMatchObject(DENIED);
    expect(await writeAs(null, bankWith(withOpening, { deleted_at: null, opening_halalas: 700_000 }))).toMatchObject({ ok: true });
  });
});
