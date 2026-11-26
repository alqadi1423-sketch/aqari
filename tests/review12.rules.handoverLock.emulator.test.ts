/**
 * المراجعة ١٢ · بقية المرحلة ١ «حارس القواعد في السحابة» لـ E-1 (DESIGN §١٣.٢٣) · على محاكي Firestore (يُتخطّى بلا FIRESTORE_EMULATOR_HOST) ·
 * بيانات مصطنعة كلها:
 *  - محضر الاستلام والتسليم المقفل في السحابة (d.locked = 1) لا يغيّر العضو بنوده ولا يفتح قفله ولا يحذفه (ناعماً أو نهائياً)،
 *    ويعيد رفعه كما هو (نقل الوحدة وإعادة الرفع للرؤية) · والمالك يكتبه.
 *  - وغير المقفل يعدّله العضو ويقفله كما اليوم، وينشئ محضراً جديداً.
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/review12.rules.handoverLock.emulator.test.ts"
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import { OWNER_ACCESS, type Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';
import { buildDoc } from '@/sync/engine';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'OWNER-R12HL';
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

d('E-1 في السحابة · المحضر المقفل لا يكتبه العضو', () => {
  const M: Access = { owner: false, uid: 'R12HL-M', perms: { handover: 3 }, allProps: true, props: [] };
  let db: import('@/db/adapter').DB;
  let unit = '';
  const LOCKED = 'R12HL-LOCKED';
  const OPEN = 'R12HL-OPEN';

  const insertHandover = (id: string, locked: number) => db.run(
    `INSERT INTO handovers (id, contract_id, unit_id, type, tenant_name, date, other_notes, sections_json, locked, created_at)
     VALUES (?, NULL, ?, 'استلام', 'مستأجر مصطنع', '2026-11-01', 'ملاحظة مصطنعة', ?, ?, ?)`,
    [id, unit, JSON.stringify([{ section: 'الصالة', items: [{ name: 'مكيف', receiveCondition: 'سليم' }] }]), locked, now()]);

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit } = await import('./helpers/fixtures');
    db = memDb();
    const prop = addProperty(db, { id: 'R12HLP' });
    unit = addUnit(db, prop, { id: 'R12HLU' });
    insertHandover(LOCKED, 1);
    insertHandover(OPEN, 0);
    const docs = [buildDoc(db, 'properties', prop, 'upsert', now(), 'DEV-OWNER'), buildDoc(db, 'units', unit, 'upsert', now(), 'DEV-OWNER'),
      buildDoc(db, 'handovers', LOCKED, 'upsert', now(), 'DEV-OWNER'), buildDoc(db, 'handovers', OPEN, 'upsert', now(), 'DEV-OWNER')]
      .map((x) => { const { doc, pub } = annotate(db, x, OWNER_ACCESS); return pub ? { ...doc, companions: [pub] } : doc; });
    expect((await remoteFor(ORG, null).write(docs)).every((r) => r.ok)).toBe(true);
    await addMember(M);
  });
  afterAll(() => db?.close());

  const writeAs = async (a: Access | null, doc: RemoteDoc) =>
    (await remoteFor(a ? a.uid! : ORG, a).write([annotate(db, doc, a ?? OWNER_ACCESS).doc]))[0];
  const handoverWith = (id: string, over: Record<string, string | number | null>): RemoteDoc => {
    const cur = buildDoc(db, 'handovers', id, 'upsert', now(), 'DEV-M');
    return { ...cur, d: { ...cur.d!, ...over } };
  };

  test('العضو لا يغيّر بنود المقفل ولا يفتح قفله ولا يحذفه ناعماً ولا نهائياً', async () => {
    expect(await writeAs(M, handoverWith(LOCKED, { other_notes: 'تعديل متأخر مصطنع' }))).toMatchObject(DENIED);
    expect(await writeAs(M, handoverWith(LOCKED, { sections_json: JSON.stringify([{ section: 'الصالة', items: [{ name: 'مكيف', receiveCondition: 'تالف' }] }]) }))).toMatchObject(DENIED);
    expect(await writeAs(M, handoverWith(LOCKED, { locked: 0 }))).toMatchObject(DENIED);
    // نسخةٌ غير مقفلة بالبنود نفسها (نافذة أمان السحب) لا تفتحه كذلك
    expect(await writeAs(M, handoverWith(LOCKED, { locked: 0, other_notes: 'تعديل متأخر مصطنع' }))).toMatchObject(DENIED);
    expect(await writeAs(M, handoverWith(LOCKED, { deleted_at: now() }))).toMatchObject(DENIED);
    const tomb: RemoteDoc = { id: 'handovers__' + LOCKED, t: 'handovers', k: LOCKED, u: now(), dev: 'DEV-M', del: true, d: null, dby: M.uid!, pids: ['R12HLP'] };
    expect(await writeAs(M, tomb)).toMatchObject(DENIED);
  });

  test('ويعيد رفع المقفل كما هو (الرؤية ونقل الوحدة)', async () => {
    expect(await writeAs(M, handoverWith(LOCKED, {}))).toMatchObject({ ok: true });
  });

  test('غير المقفل: العضو يعدّله ويقفله كما اليوم، ثم لا يعدّله · وينشئ محضراً جديداً', async () => {
    expect(await writeAs(M, handoverWith(OPEN, { other_notes: 'تعبئة مصطنعة' }))).toMatchObject({ ok: true });
    db.run(`UPDATE handovers SET other_notes = 'تعبئة مصطنعة', locked = 1 WHERE id = ?`, [OPEN]);
    expect(await writeAs(M, handoverWith(OPEN, {}))).toMatchObject({ ok: true });
    expect(await writeAs(M, handoverWith(OPEN, { other_notes: 'بعد القفل مصطنع' }))).toMatchObject(DENIED);
    insertHandover('R12HL-NEW', 0);
    expect(await writeAs(M, handoverWith('R12HL-NEW', {}))).toMatchObject({ ok: true });
  });

  test('المالك يكتب المقفل ويحذفه ناعماً', async () => {
    expect(await writeAs(null, handoverWith(LOCKED, { other_notes: 'تصحيح المالك مصطنع' }))).toMatchObject({ ok: true });
    expect(await writeAs(null, handoverWith(LOCKED, { other_notes: 'تصحيح المالك مصطنع', deleted_at: now() }))).toMatchObject({ ok: true });
  });
});
