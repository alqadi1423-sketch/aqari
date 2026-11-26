/**
 * المدقق الخارجي Q · الجولة التاسعة · على e7c151c · بيانات مصطنعة كلها.
 * شواهد القاعدة الحقيقية (openingKept في firestore.rules) لما تفترضه اختبارات Q١ وQ١ب وQ٢ (هذا الملف يمرّ: يثبت أن المستندات فيها
 * تقبلها السحابة أو ترفضها كما في MemoryRemote، لا أنها حُقنت):
 *  - Q١: تسمية العضو بافتتاحيّ السحابة السابق تُقبل.
 *  - Q١ب: تغيير العضو مجموعة (grp) حسابٍ غير نظامي يُقبل في السحابة (حارسه جهاز المالك وحده).
 *  - Q٢: تسمية العضو بافتتاحيٍّ قديمٍ (قبل تصحيح المالك) تُرفض.
 *   firebase emulators:exec --only firestore --project demo-aqari "TZ=Asia/Riyadh npx jest -i tests/d4.auditQ.premise.emulator.test.ts"
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import type { Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'OWNER-Q9';
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

d('Q · شواهد القاعدة لاختبارات Q١ وQ١ب وQ٢', () => {
  const M: Access = { owner: false, uid: 'U-Q9', perms: { banks: 3, ledger: 3, props: 1 }, allProps: true, props: [] };
  let db: import('@/db/adapter').DB;
  let bank = '';
  let engine: typeof import('@/sync/engine');

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addBank } = await import('./helpers/fixtures');
    engine = await import('@/sync/engine');
    db = memDb();
    bank = addBank(db, 'بنك مصطنع Q9', 100000);
    db.run(`INSERT INTO accounts (code, name, type, grp, opening_halalas, created_at) VALUES ('1180', 'عهدة مصطنعة Q9', 'أصل', 'النقدية وما في حكمها', 100000, ?)`, [new Date().toISOString()]);
    engine.enableSync(db, ORG);
    expect((await engine.syncOnce(db, remoteFor(ORG, null), 'dev-owner-q9')).pending).toBe(0);
    db.exec((await import('@/db/schema')).MIGRATION_42);
    const put = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/members/${M.uid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(ORG) },
      body: JSON.stringify({ fields: encodeFields({ email: M.uid!.toLowerCase() + '@example.test', perm: M.perms, all: true, props: [], tokens: memberTokens(M) }) }),
    });
    expect(put.status).toBe(200);
  });

  const write = async (doc: RemoteDoc) => (await remoteFor(M.uid!, M).write([annotate(db, doc, M).doc]))[0];
  const docOf = (t: string, k: string, over: Record<string, unknown>, u: string): RemoteDoc => {
    const base = engine.buildDoc(db, t, k, 'upsert', '2026-11-07T00:00:00.000Z', 'dev-q9');
    return { ...base, u, d: { ...base.d!, ...over } as RemoteDoc['d'] };
  };

  test('Q1: تسمية العضو بافتتاحيّ السحابة تُقبل · Q1b: مجموعة حسابٍ غير نظامي تُقبل · Q2: الافتتاحي القديم بعد تصحيح المالك يُرفض', async () => {
    expect(await write(docOf('banks', bank, { name: 'اسم العضو مصطنع Q9' }, 'q1'))).toMatchObject({ ok: true });
    expect(await write(docOf('accounts', '1180', { grp: 'مجموعة أخرى مصطنعة' }, 'q1b'))).toMatchObject({ ok: true });
    // المالك يصحّح الافتتاحي ويرفعه · وجهاز العضو ما زال على القديم (100000)
    const ownerDoc = docOf('banks', bank, { opening_halalas: 20000 }, 'q2-owner');
    expect((await remoteFor(ORG, null).write([annotate(db, ownerDoc, { owner: true, uid: ORG, perms: {}, allProps: true, props: [] }).doc]))[0]).toMatchObject({ ok: true });
    expect(await write(docOf('banks', bank, { name: 'تسمية العضو الثانية مصطنعة Q9', opening_halalas: 100000 }, 'q2'))).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(await write(docOf('banks', bank, { name: 'تسمية العضو الثانية مصطنعة Q9', opening_halalas: 20000 }, 'q2b'))).toMatchObject({ ok: true });
  });
});

d('Q · ما صمد في القاعدة: القيم البديلة عن الافتتاحي وis_system', () => {
  const M: Access = { owner: false, uid: 'U-Q9b', perms: { banks: 3, ledger: 3, props: 1 }, allProps: true, props: [] };
  let db: import('@/db/adapter').DB;
  let bank = '';
  let engine: typeof import('@/sync/engine');
  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addBank } = await import('./helpers/fixtures');
    engine = await import('@/sync/engine');
    db = memDb();
    bank = addBank(db, 'بنك مصطنع Q9b', 0);
    engine.enableSync(db, ORG);
    expect((await engine.syncOnce(db, remoteFor(ORG, null), 'dev-owner-q9b')).pending).toBe(0);
    db.exec((await import('@/db/schema')).MIGRATION_42);
    const put = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/members/${M.uid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(ORG) },
      body: JSON.stringify({ fields: encodeFields({ email: M.uid!.toLowerCase() + '@example.test', perm: M.perms, all: true, props: [], tokens: memberTokens(M) }) }),
    });
    expect(put.status).toBe(200);
  });
  const write = async (doc: RemoteDoc) => (await remoteFor(M.uid!, M).write([annotate(db, doc, M).doc]))[0];
  const docOf = (t: string, k: string, over: Record<string, unknown>, u: string): RemoteDoc => {
    const base = engine.buildDoc(db, t, k, 'upsert', '2026-11-07T00:00:00.000Z', 'dev-q9b');
    return { ...base, u, d: { ...base.d!, ...over } as RemoteDoc['d'] };
  };
  test('افتتاحيٌّ null أو نصٌّ أو غائبٌ مع سابقٍ صفر، وis_system نصاً أو منطقياً', async () => {
    const DENIED = { ok: false, code: 'PERMISSION_DENIED' };
    expect(await write(docOf('banks', bank, { opening_halalas: null }, 'n1'))).toMatchObject(DENIED);
    expect(await write(docOf('banks', bank, { opening_halalas: '0' }, 'n2'))).toMatchObject(DENIED);
    expect(await write(docOf('accounts', '1100', { is_system: '1' }, 'n3'))).toMatchObject(DENIED);
    expect(await write(docOf('accounts', '1100', { is_system: true }, 'n4'))).toMatchObject(DENIED);
    // الغياب يساوي الصفر السابق، وجهاز المالك لا يكتب عموداً غائباً (upsertRow) · فلا أثر
    const base = engine.buildDoc(db, 'banks', bank, 'upsert', '2026-11-07T00:00:00.000Z', 'dev-q9b');
    const { opening_halalas: _o, ...rest } = base.d as Record<string, unknown>;
    expect(await write({ ...base, u: 'n5', d: rest as RemoteDoc['d'] })).toMatchObject({ ok: true });
  });
});
