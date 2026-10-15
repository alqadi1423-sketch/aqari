/**
 * المراجعة الخارجية ٧ · النتيجة ٤٢: مسارات في القواعد بلا اختبار سلبي · لكلٍّ سلبيٌّ وإيجابي على محاكي Firestore · بيانات مصطنعة.
 *  meta/epoch وmeta/moves · chatRoles وchatDir · قراءة الدعوة بإيميلٍ غير متحقَّق · svOk مع meta/compat · entrySumsOk ·
 *  orgOnlyLineDims وorgOnlyVisibility على القيد المرحّل
 */
import { FirestoreRemote, encodeFields, docToFields } from '@/cloud/firestore';
import { ChatRemote } from '@/chat/remote';
import { OWNER_ACCESS } from '@/domain/access/access';
import { annotate } from '@/sync/acl';
import type { RemoteDoc } from '@/sync/types';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'NEG42-OWNER';
const M = 'NEG42-M';
const M_EMAIL = 'neg42-m@example.test';
const d = HOST ? describe : describe.skip;

function token(uid: string, email = uid.toLowerCase() + '@example.test', verified = true): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: verified, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const DOCS = () => `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const put = async (path: string, data: Record<string, unknown>, tok: string) =>
  (await fetch(`${DOCS()}/${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ fields: encodeFields(data) }) })).status;
const get = async (path: string, tok: string) => (await fetch(`${DOCS()}/${path}`, { headers: { Authorization: 'Bearer ' + tok } })).status;
async function commit(tok: string, writes: unknown[]): Promise<number> {
  const res = await fetch(`${DOCS()}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ writes }) });
  await res.text();
  return res.status;
}
const OWN = () => token(ORG);
const MEM = () => token(M, M_EMAIL);
const ownerRemote = (sv: number) => new FirestoreRemote({ projectId: PROJECT, uid: ORG, org: ORG, idToken: async () => OWN(), baseUrl: 'http://' + HOST, access: () => OWNER_ACCESS, sv: () => sv });

d('المراجعة الخارجية ٧ · النتيجة ٤٢: مسارات القواعد بسلبيها وإيجابيها', () => {
  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    expect(await put(`orgs/${ORG}/members/${M}`, { email: M_EMAIL, perm: { collect: 2 }, all: true, props: [], tokens: ['collect|@'], name: 'عضو مصطنع ٤٢' }, OWN())).toBe(200);
  });

  test('meta/epoch وmeta/moves: العضو لا يكتب · والمالك يكتب', async () => {
    expect(await put(`orgs/${ORG}/meta/epoch`, { n: 3, at: '2026-10-15T00:00:00Z' }, MEM())).toBe(403);
    expect(await put(`orgs/${ORG}/meta/moves`, { moves: [] }, MEM())).toBe(403);
    expect(await put(`orgs/${ORG}/meta/moves`, { moves: [] }, OWN())).toBe(200);
  });

  test('chatRoles: العضو لا يكتب ولا يقرأ إيميل غيره · ويقرأ إشرافه · والمالك يكتب', async () => {
    expect(await put(`orgs/${ORG}/chatRoles/${M_EMAIL}`, { sup: ['collect'] }, OWN())).toBe(200);
    expect(await put(`orgs/${ORG}/chatRoles/other42@example.test`, { sup: ['collect'] }, MEM())).toBe(403);
    expect(await put(`orgs/${ORG}/chatRoles/other42@example.test`, { sup: [] }, OWN())).toBe(200);
    expect(await get(`orgs/${ORG}/chatRoles/other42@example.test`, MEM())).toBe(403);
    expect(await get(`orgs/${ORG}/chatRoles/${M_EMAIL}`, MEM())).toBe(200);
  });

  test('chatDir: العضو لا ينشئ دليل غيره · وينشئ دليله باسم عضويته وإشرافه', async () => {
    const other = `projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/chatDir/NEG42-OTHER`;
    expect(await commit(MEM(), [{ update: { name: other, fields: encodeFields({ name: 'عضو مصطنع ٤٢', sup: ['collect'] }) },
      updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }] }])).toBe(403);
    const me = new ChatRemote({ projectId: PROJECT, org: ORG, uid: M, idToken: async () => MEM(), baseUrl: 'http://' + HOST });
    await expect(me.putMyDirectory('عضو مصطنع ٤٢', ['collect'])).resolves.toBeUndefined();
  });

  test('الدعوة: لا تُقرأ بإيميلٍ غير متحقَّق · وتُقرأ بالمتحقَّق', async () => {
    const email = 'new42@example.test';
    expect(await put(`orgs/${ORG}/invites/${email}`, { email, perm: { collect: 1 }, all: true, props: [] }, OWN())).toBe(200);
    expect(await get(`orgs/${ORG}/invites/${email}`, token('NEG42-NEW', email, false))).toBe(403);
    expect(await get(`orgs/${ORG}/invites/${email}`, token('NEG42-NEW', email, true))).toBe(200);
  });

  test('svOk وentrySumsOk وorgOnlyLineDims وorgOnlyVisibility على القيد المرحّل', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { postEntry } = await import('@/domain/accounting/post');
    const { buildDoc } = await import('@/sync/engine');
    const db = memDb();
    const e1 = postEntry(db, { date: '2026-10-01', memo: 'قيد مصطنع ٤٢', lines: [{ account: '1100', debit: 500, credit: 0 }, { account: '3100', debit: 0, credit: 500 }] })!;
    const e2 = postEntry(db, { date: '2026-10-02', memo: 'قيد مصطنع ٤٢ ب', lines: [{ account: '1100', debit: 700, credit: 0 }, { account: '3100', debit: 0, credit: 700 }] })!;
    const doc = (id: string): RemoteDoc => annotate(db, buildDoc(db, 'journal_entries', id, 'upsert', new Date().toISOString(), 'dev-42'), OWNER_ACCESS).doc;
    // svOk: حدّ الإصدار ٩٩ · إصدارٌ أقدم يُرفض وإصداره يُقبل
    expect(await put(`orgs/${ORG}/meta/compat`, { min: 99 }, OWN())).toBe(200);
    expect((await ownerRemote(45).write([doc(e1.id)]))[0].ok).toBe(false);
    expect((await ownerRemote(99).write([doc(e1.id)]))[0].ok).toBe(true);
    // entrySumsOk: مجموعا المدين والدائن المعلنان مختلفان يُرفض
    const d2 = doc(e2.id);
    const fields = docToFields(d2, 99) as Record<string, unknown>;
    const name = `projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/rows/${d2.id}`;
    expect(await commit(OWN(), [{ update: { name, fields: { ...fields, dr: { integerValue: '700' }, cr: { integerValue: '600' } } },
      updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }] }])).toBe(403);
    expect(await commit(OWN(), [{ update: { name, fields }, updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }] }])).toBe(200);
    // orgOnlyLineDims: سطور القيد المرحّل لا تتغير مبالغها ولو تساوت · وتُملأ أبعادها
    const base = doc(e1.id);
    const amounts = { ...base, u: base.u + '1', lines: base.lines!.map((l) => ({ ...l, debit_halalas: Number(l.debit_halalas) ? 600 : 0, credit_halalas: Number(l.credit_halalas) ? 600 : 0 })) };
    expect((await ownerRemote(99).write([amounts]))[0].ok).toBe(false);
    const dims = { ...base, u: base.u + '2', lines: base.lines!.map((l) => ({ ...l, property_id: 'P-DIM42' })) };
    expect((await ownerRemote(99).write([dims]))[0].ok).toBe(true);
    // orgOnlyVisibility: رؤيته تتغير وحدها · ونصّه لا يتغير
    const vis = { ...base, u: base.u + '3', lines: dims.lines, g: [...(base.g ?? []), 'ledger|@'] };
    expect((await ownerRemote(99).write([vis]))[0].ok).toBe(true);
    const memo = { ...vis, u: base.u + '4', d: { ...vis.d!, memo: 'مذكرة معدّلة' } };
    expect((await ownerRemote(99).write([memo]))[0].ok).toBe(false);
    db.close();
  });
});
