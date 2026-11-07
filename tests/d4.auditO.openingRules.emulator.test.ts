/**
 * المدقق الخارجي O · الجولة الثامنة · حارس الافتتاحي والحساب النظامي في قاعدة السحابة (openingKept في rulesGen.ts) على محاكي Firestore ·
 * O٥: جهاز المالك يثق بافتتاحيّ نسخة العضو لأن القاعدة لا تجيز للعضو غير افتتاحيّ النسخة السابقة (وصفرٍ للجديد) · O١: والحساب النظامي
 * لا يغيّر العضو نوعه ولا مجموعته ولا حذفه ولا كونه نظامياً.
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/d4.auditO.openingRules.emulator.test.ts"
 * البيانات مصطنعة كلها.
 */
import { FirestoreRemote } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import type { Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';
import { encodeFields } from '@/cloud/firestore';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'OWNER-O5';
const d = HOST ? describe : describe.skip;

function token(uid: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email: uid.toLowerCase() + '@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}

function remoteFor(uid: string, a: Access | null): FirestoreRemote {
  return new FirestoreRemote({
    projectId: PROJECT, uid, org: ORG, idToken: async () => token(uid), baseUrl: 'http://' + HOST,
    memberTokens: () => (a ? memberTokens(a) : null),
    fullReadTables: () => (a ? fullReadTables(a, SYNC_TABLES.map((t) => t.name)) : new Set()),
    access: () => a ?? { owner: true, uid, perms: {}, allProps: true, props: [] },
  });
}

d('O٥ وO١ · الافتتاحي للمالك وحده، والحساب النظامي كما هو، في قاعدة السحابة', () => {
  const M: Access = { owner: false, uid: 'U-O5', perms: { banks: 3, ledger: 3, props: 1 }, allProps: true, props: [] };
  let db: import('@/db/adapter').DB;
  let bank = '';
  let buildDoc: typeof import('@/sync/engine').buildDoc;

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addBank } = await import('./helpers/fixtures');
    const engine = await import('@/sync/engine');
    buildDoc = engine.buildDoc;
    db = memDb();
    bank = addBank(db, 'بنك مصطنع O5', 500000);
    db.run(`INSERT INTO accounts (code, name, type, opening_halalas, created_at) VALUES ('5999', 'حساب مصطنع O5', 'مصروف', 0, ?)`, [new Date().toISOString()]);
    db.run(`UPDATE accounts SET opening_halalas = 700000 WHERE code = '1100'`);
    engine.enableSync(db, ORG);
    const r = await engine.syncOnce(db, remoteFor(ORG, null), 'dev-owner');
    expect(r.pending).toBe(0);
    db.exec((await import('@/db/schema')).MIGRATION_42);
    const put = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/members/${M.uid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(ORG) },
      body: JSON.stringify({ fields: encodeFields({ email: M.uid!.toLowerCase() + '@example.test', perm: M.perms, all: true, props: [], tokens: memberTokens(M) }) }),
    });
    expect(put.status).toBe(200);
  });

  const write = async (doc: RemoteDoc) => (await remoteFor(M.uid!, M).write([annotate(db, doc, M).doc]))[0];
  const docOf = (t: string, k: string, over: Record<string, unknown>, u: string): RemoteDoc => {
    const base = buildDoc(db, t, k, 'upsert', '2026-11-07T00:00:00.000Z', 'dev-o5');
    return { ...base, u, d: { ...base.d!, ...over } as RemoteDoc['d'] };
  };
  const DENIED = { ok: false, code: 'PERMISSION_DENIED' };

  test('البنك: التسمية بالافتتاحي كما هو تُقبل، وتغييره يُرفض، والبنك الجديد بافتتاحيٍّ صفر وحده', async () => {
    expect(await write(docOf('banks', bank, { name: 'اسمٌ جديد مصطنع O5' }, 'b1'))).toMatchObject({ ok: true });
    expect(await write(docOf('banks', bank, { opening_halalas: 900000 }, 'b2'))).toMatchObject(DENIED);
    expect(await write(docOf('banks', bank, { opening_halalas: 0 }, 'b3'))).toMatchObject(DENIED);
    const fresh = (opening: number, id: string): RemoteDoc => ({ id: 'banks__' + id, t: 'banks', k: id, u: 'n-' + id, dev: 'dev-o5', del: false,
      d: { id, name: 'بنك العضو مصطنع ' + id, iban: '', opening_halalas: opening, created_at: '2026-11-07T00:00:00.000Z' } });
    expect(await write(fresh(300000, 'bank-o5-a'))).toMatchObject(DENIED);
    expect(await write(fresh(0, 'bank-o5-b'))).toMatchObject({ ok: true });
  });

  test('الحساب: الافتتاحي كما هو، والنظامي لا يتغيّر نوعه ولا مجموعته ولا حذفه ولا كونه نظامياً · وغير النظامي يتغيّر نوعه', async () => {
    expect(await write(docOf('accounts', '1100', { name: 'النقدية مصطنع O5' }, 'a1'))).toMatchObject({ ok: true });
    expect(await write(docOf('accounts', '1100', { opening_halalas: 1700000 }, 'a2'))).toMatchObject(DENIED);
    expect(await write(docOf('accounts', '1100', { type: 'خصم' }, 'a3'))).toMatchObject(DENIED);
    expect(await write(docOf('accounts', '1100', { deleted_at: '2026-11-07T00:00:00.000Z' }, 'a4'))).toMatchObject(DENIED);
    expect(await write(docOf('accounts', '1100', { is_system: 0 }, 'a5'))).toMatchObject(DENIED);
    expect(await write(docOf('accounts', '1100', { grp: 'مجموعة مصطنعة' }, 'a6'))).toMatchObject(DENIED);
    // غير النظامي: نوعه يتغيّر (والمستعمل في قيدٍ يحرسه جهاز المالك)، ولا يصير نظامياً
    expect(await write(docOf('accounts', '5999', { type: 'إيراد' }, 'a7'))).toMatchObject({ ok: true });
    expect(await write(docOf('accounts', '5999', { is_system: 1 }, 'a8'))).toMatchObject(DENIED);
  });
});
