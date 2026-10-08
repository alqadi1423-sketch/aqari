/**
 * ثغرات الأعضاء من مراجعة التثبيت (#17 و#18 و#20 و#21 و#39) على محاكي Firestore · قرار المالك 2026-10-08:
 * «وأولها ثغرات الأعضاء (#17 و#18 و#20 و#21)، لأنها تمنعني من إضافة أعضاء بأمان.»
 * كل اختبار هنا عضوٌ بعميلٍ معدَّل يحاول ما لا تجيزه صلاحيته · البيانات مصطنعة كلها.
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import type { Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'GAPOWNER';
const d = HOST ? describe : describe.skip;

function token(uid: string, email = uid.toLowerCase() + '@example.test'): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const member = (uid: string, perms: Access['perms'], props: string[] | 'all'): Access =>
  ({ owner: false, uid, perms, allProps: props === 'all', props: props === 'all' ? [] : props });
const fullTables = (a: Access) => fullReadTables(a, SYNC_TABLES.map((t) => t.name));
function remoteFor(uid: string, a: Access | null): FirestoreRemote {
  return new FirestoreRemote({
    projectId: PROJECT, uid, org: ORG, idToken: async () => token(uid), baseUrl: 'http://' + HOST,
    memberTokens: () => (a ? memberTokens(a) : null),
    fullReadTables: () => (a ? fullTables(a) : new Set()),
    access: () => a ?? { owner: true, uid, perms: {}, allProps: true, props: [] },
  });
}
async function putDoc(path: string, data: Record<string, unknown>, uid: string): Promise<number> {
  const res = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) },
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  return res.status;
}
async function readRow(id: string): Promise<RemoteDoc> {
  const res = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/rows/${id}`,
    { headers: { Authorization: 'Bearer ' + token(ORG) } });
  const { fieldsToDoc } = await import('@/cloud/firestore');
  return fieldsToDoc(id, ((await res.json()) as { fields: never }).fields);
}

d('ثغرات الأعضاء (المراجعة #17 و#18 و#20 و#21 و#39)', () => {
  const COLLECTOR = member('U-GCOL', { collect: 2, contracts: 1, props: 1 }, ['P1']);
  const CONTR = member('U-GCON', { contracts: 3, props: 1 }, ['P1']);
  const TECH = member('U-GTEC', { props: 3 }, ['P1']); // بلا قسم مالي
  let db: import('@/db/adapter').DB;
  let C1 = '', C2 = '', I1 = '';

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    db = memDb();
    addProperty(db, { id: 'P1', name: 'عقار أول مصطنع' });
    addProperty(db, { id: 'P2', name: 'عقار ثانٍ مصطنع' });
    const u1 = addUnit(db, 'P1', { id: 'GUN1', rent: 300000 });
    const u2 = addUnit(db, 'P2', { id: 'GUN2', rent: 400000 });
    C1 = confirmContract(db, contractInput(u1, { tenant: 'مستأجر أول مصطنع', idNumber: '1000000058', phone: '0500000021' }));
    C2 = confirmContract(db, contractInput(u2, { tenant: 'مستأجر ثانٍ مصطنع', idNumber: '1000000066', phone: '0500000022' }));
    I1 = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [C1])!.id;
    enableSync(db, ORG);
    expect((await syncOnce(db, remoteFor(ORG, null), 'dev-owner')).pending).toBe(0);
    for (const a of [COLLECTOR, CONTR, TECH]) {
      expect(await putDoc(`orgs/${ORG}/members/${a.uid}`, {
        email: a.uid!.toLowerCase() + '@example.test', perm: a.perms, all: a.allProps, props: a.props, tokens: memberTokens(a),
      }, ORG)).toBe(200);
    }
  });

  /** يكتب كما يكتب جهاز العضو (حقول الرؤية من صلاحيته) ثم يعدّل ما يعدّله العميل المعدَّل */
  const write = async (a: Access, doc: RemoteDoc, forge: Partial<RemoteDoc> = {}) =>
    (await remoteFor(a.uid!, a).write([{ ...annotate(db, doc, a).doc, ...forge }]))[0];
  const payment = (k: string, contract: string, inst = I1): RemoteDoc => ({
    id: 'contract_payments__' + k, t: 'contract_payments', k, u: 'x', dev: 'dev-gap', del: false,
    d: { id: k, contract_id: contract, installment_id: inst, date: '2026-05-01', gross_halalas: 1000, discount_halalas: 0, net_halalas: 1000 },
  });

  test('#١٨ عضوٌ محصور بعقار لا ينشئ صفاً لعقار آخر بإعلان عقاراته كذباً', async () => {
    const forged = { pids: ['P1'], g: ['collect|P1', 'collect|@'] };
    expect(await write(COLLECTOR, payment('GPX2', C2), forged)).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(await write(COLLECTOR, payment('GPX1', C1))).toMatchObject({ ok: true });
  });

  test('#١٨ ولا يعدّل صفاً في عقار آخر بنقله إلى عقاره', async () => {
    const row = db.get<Record<string, unknown>>(`SELECT * FROM contracts WHERE id = ?`, [C2])!;
    const doc: RemoteDoc = { id: 'contracts__' + C2, t: 'contracts', k: C2, u: 'y', dev: 'dev-gap', del: false, d: { ...row, notes: 'عدّلها عضو عقار آخر' } as never };
    expect(await write(CONTR, doc, { pids: ['P1'], g: ['contracts|P1', 'contracts|@', 'ledger|P1', 'ledger|@', 'reports|P1', 'reports|@'] }))
      .toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // وعقده هو يعدّله
    const mine = db.get<Record<string, unknown>>(`SELECT * FROM contracts WHERE id = ?`, [C1])!;
    expect(await write(CONTR, { ...doc, id: 'contracts__' + C1, k: C1, d: { ...mine, notes: 'ملاحظة مصطنعة' } as never })).toMatchObject({ ok: true });
  });

  test('#١٨ ولا يغيّر رؤية صفٍّ قائم: لا عقاراً آخر ولا قسماً آخر', async () => {
    const inst = db.get<Record<string, unknown>>(`SELECT * FROM contract_installments WHERE id = ?`, [I1])!;
    const doc: RemoteDoc = { id: 'contract_installments__' + I1, t: 'contract_installments', k: I1, u: 'g1', dev: 'dev-gap', del: false, d: { ...inst, status: 'مدفوعة جزئياً' } as never };
    const g = annotate(db, doc, COLLECTOR).doc.g!;
    expect(await write(COLLECTOR, doc, { g: [...g, 'props|P1'] })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(await write(COLLECTOR, doc, { g: [...g, 'collect|P2'] })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(await write(COLLECTOR, doc)).toMatchObject({ ok: true });
  });

  test('#٢٠ مفتاح الصف داخل المستند هو مفتاحه · فلا يستبدل مستندٌ صفاً آخر', async () => {
    const p = payment('GPX4', C1);
    expect(await write(COLLECTOR, { ...p, d: { ...p.d!, id: 'GPX1' } })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(await write(COLLECTOR, p)).toMatchObject({ ok: true });
  });

  test('#٢١ بصمة الملف وامتداده بشكلهما · فلا يُبنى منهما مسارٌ خارج المرفقات', async () => {
    // معرّف المستند لا يحمل «..» (يرفضه Firestore نفسه) · والخطر في المحتوى: صف المرفق ببصمة أو امتداد مسارٍ
    const att = (id: string, sha: string, _ext?: string): RemoteDoc => ({ id: 'attachments__' + id, t: 'attachments', k: id, u: 'b', dev: 'dev-gap', del: false,
      d: { id, sha256: sha, entity_type: 'library', entity_id: '', kind: 'other', original_name: '', mime: '', note: '', display_name: '', created_at: '2026-01-01T00:00:00.000Z' } });
    expect(await write(COLLECTOR, att('GAT1', '../../data', 'db'))).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(await write(COLLECTOR, att('GAT3', 'a'.repeat(64), 'pdf'))).toMatchObject({ ok: true });
    const blobDoc = (sha: string, ext: string): RemoteDoc => ({ id: 'blobs__' + sha, t: 'blobs', k: sha, u: 'b', dev: 'dev-gap', del: false,
      d: { sha256: sha, ext, size_bytes: 1, created_at: '2026-01-01T00:00:00.000Z' } });
    expect(await write(COLLECTOR, blobDoc('b'.repeat(64), 'db..'))).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(await write(COLLECTOR, blobDoc('b'.repeat(64), 'pdf'))).toMatchObject({ ok: true });
    // وصف البصمة: مفتاحه البصمة نفسها بشكلها
    const blob: RemoteDoc = { id: 'blobs__evil', t: 'blobs', k: 'evil', u: 'b', dev: 'dev-gap', del: false,
      d: { sha256: '../../data', ext: 'db', size_bytes: 1, created_at: '2026-01-01T00:00:00.000Z' } };
    expect(await write(COLLECTOR, blob)).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('#١٧ عضوٌ لا يقرأ المبالغ لا يغيّرها · وكتابته الجزئية تُبقيها كما هي', async () => {
    const unit = db.get<Record<string, unknown>>(`SELECT * FROM units WHERE id = 'GUN1'`)!;
    // ما يكتبه جهاز الفني لو رفع صفّه كاملاً: الإيجار بقيمته الافتراضية من الإسقاط
    const full: RemoteDoc = { id: 'units__GUN1', t: 'units', k: 'GUN1', u: 'm1', dev: 'dev-tech', del: false, d: { ...unit, unit_no: 'A-9', rent_monthly_halalas: 0 } as never };
    expect(await write(TECH, full)).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // جهاز الفني كما يعمل الآن: الحقول التي يقرؤها وحدها
    const r = remoteFor(TECH.uid!, TECH);
    const masked = r.annotate!(db, full);
    expect(Object.keys(masked.d!).some((k) => k.endsWith('_halalas'))).toBe(false);
    expect((await r.write([masked]))[0]).toMatchObject({ ok: true });
    const after = await readRow('units__GUN1');
    expect([after.d!.unit_no, after.d!.rent_monthly_halalas]).toEqual(['A-9', 300000]);
  });

  test('#٣٩ اللمس الجانبي يغيّر حقوله وحدها · لا سطوراً ولا عقارات ولا رؤية أوسع', async () => {
    const inst = db.get<Record<string, unknown>>(`SELECT * FROM contract_installments WHERE id = ?`, [I1])!;
    const doc: RemoteDoc = { id: 'contract_installments__' + I1, t: 'contract_installments', k: I1, u: 't1', dev: 'dev-gap', del: false, d: { ...inst } as never };
    const g = annotate(db, doc, COLLECTOR).doc.g!;
    // الفرق في d فارغ، والرؤية أوسع
    expect(await write(COLLECTOR, doc, { g: [...g, 'props|P1'] })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // سطورٌ في غير القيد
    expect(await write(COLLECTOR, { ...doc, lines: [{ x: 1 }] as never })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // والمجاز كما هو
    expect(await write(COLLECTOR, { ...doc, u: 't2', d: { ...inst, status: 'مدفوعة جزئياً' } as never })).toMatchObject({ ok: true });
  });
});
