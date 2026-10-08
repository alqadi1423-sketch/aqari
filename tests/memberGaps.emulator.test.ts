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

d('ثغرات الأعضاء · ملاحظات التحقق المستقل (2026-10-08)', () => {
  const TECH = member('U-VTEC', { props: 3 }, ['P1']);
  const CONTR = member('U-VCON', { contracts: 3, props: 1, tenants: 3 }, ['P1']);
  const COL3 = member('U-VCOL', { collect: 3, contracts: 1, props: 1 }, ['P1']);
  const COMPANY = member('U-VCMP', { company: 3 }, 'all');
  const ALLCON = member('U-VALL', { contracts: 3, props: 1 }, 'all');
  const COLLECTOR = member('U-VCO2', { collect: 2, contracts: 1, props: 1 }, ['P1']);
  const TWO = member('U-VTWO', { contracts: 3, props: 1 }, ['P1', 'P3']);
  let db: import('@/db/adapter').DB;
  let C1 = '', C2 = '', C3 = '', T0 = '';

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    db = memDb();
    addProperty(db, { id: 'P1', name: 'عقار أول مصطنع' });
    addProperty(db, { id: 'P2', name: 'عقار ثانٍ مصطنع' });
    addUnit(db, 'P1', { id: 'VUN1' });
    addUnit(db, 'P2', { id: 'VUN2' });
    addProperty(db, { id: 'P3', name: 'عقار ثالث مصطنع' });
    addUnit(db, 'P3', { id: 'VUN3' });
    addUnit(db, 'P1', { id: 'VUN4' });
    for (const [id, unit] of [['VR1', 'VUN1'], ['VR2', 'VUN2']]) {
      db.run(`INSERT INTO unit_rooms (id, unit_id, room_name) VALUES (?,?,?)`, [id, unit, 'غرفة مصطنعة']);
    }
    C1 = confirmContract(db, contractInput('VUN1', { tenant: 'مستأجر أول مصطنع', idNumber: '1000000132', phone: '0500000091' }));
    C2 = confirmContract(db, contractInput('VUN2', { tenant: 'مستأجر ثانٍ مصطنع', idNumber: '1000000140', phone: '0500000092' }));
    C3 = confirmContract(db, contractInput('VUN4', { tenant: 'مستأجر ثالث مصطنع', idNumber: '1000000157', phone: '0500000095' }));
    T0 = 'VT0';
    db.run(`INSERT INTO tenants (id, name, phone, created_at) VALUES ('VT0', 'مستأجر بلا عقد مصطنع', '0500000093', '2026-01-01T00:00:00.000Z')`);
    db.run(`INSERT INTO journal_entries (id, no, date, memo, status, created_at) VALUES ('VJE', 'JE-V1', '2026-03-01', 'مسودة قيد مصطنعة', 'قيد الإنشاء', '2026-03-01T00:00:00.000Z')`);
    enableSync(db, ORG);
    expect((await syncOnce(db, remoteFor(ORG, null), 'dev-owner')).pending).toBe(0);
    for (const a of [TECH, CONTR, COL3, COMPANY, ALLCON, COLLECTOR, TWO]) {
      expect(await putDoc(`orgs/${ORG}/members/${a.uid}`, {
        email: a.uid!.toLowerCase() + '@example.test', perm: a.perms, all: a.allProps, props: a.props, tokens: memberTokens(a),
      }, ORG)).toBe(200);
    }
  });
  const write = async (a: Access, doc: RemoteDoc, forge: Partial<RemoteDoc> = {}) =>
    (await remoteFor(a.uid!, a).write([{ ...annotate(db, doc, a).doc, ...forge }]))[0];
  const row = (t: string, id: string) => db.get<Record<string, unknown>>(`SELECT * FROM "${t}" WHERE id = ?`, [id])!;
  const doc = (t: string, k: string, d: Record<string, unknown> | null, u = 'v1'): RemoteDoc =>
    ({ id: t + '__' + k, t, k, u, dev: 'dev-v', del: d === null, d: d as never });

  test('المحصور يحذف صفاً في عقاره (شاهد الحذف بحقول الصف الفارغ) · ولا يحذف في عقار آخر', async () => {
    expect(await write(TECH, doc('unit_rooms', 'VR1', null))).toMatchObject({ ok: true });
    expect(await write(TECH, doc('unit_rooms', 'VR2', null))).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('لا يُعاد ربط صفٍّ قائم بعقار آخر بتغيير روابطه وعقاراته كما هي', async () => {
    // عقده إلى وحدة في عقار آخر · بعقارات الصف ورؤيته كما هما (يزوّرهما العميل المعدَّل)
    const same = (t: string, k: string, a: Access) => { const o = annotate(db, doc(t, k, row(t, k)), a).doc; return { pids: o.pids, g: o.g }; };
    expect(await write(CONTR, doc('contracts', C1, { ...row('contracts', C1), unit_id: 'VUN2' }), same('contracts', C1, CONTR)))
      .toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // دفعته إلى عقد في عقار آخر
    const pay = (contract: string) => doc('contract_payments', 'VPZ1', { id: 'VPZ1', contract_id: contract, installment_id: null, date: '2026-05-01',
      gross_halalas: 1000, discount_halalas: 0, net_halalas: 1000 });
    expect(await write(COL3, pay(C1))).toMatchObject({ ok: true });
    const g1 = annotate(db, pay(C1), COL3).doc.g;
    expect(await write(COL3, pay(C2), { pids: ['P1'], g: g1 })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // وتعديله المشروع يمرّ
    expect(await write(CONTR, doc('contracts', C1, { ...row('contracts', C1), notes: 'ملاحظة مصطنعة' }))).toMatchObject({ ok: true });
  });

  test('ولا يُحيا شاهد حذف بصفٍّ لعقار آخر', async () => {
    const pay = (contract: string | null) => doc('contract_payments', 'VPZ2', contract === null ? null : { id: 'VPZ2', contract_id: contract, installment_id: null,
      date: '2026-05-01', gross_halalas: 1000, discount_halalas: 0, net_halalas: 1000 });
    expect(await write(COL3, pay(C1))).toMatchObject({ ok: true });
    expect(await write(COL3, pay(null))).toMatchObject({ ok: true });
    expect(await write(COL3, pay(C2), { pids: ['*'], g: ['collect|*', 'collect|@'] })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(await write(COL3, pay(C1))).toMatchObject({ ok: true });
  });

  test('صفّ المنشأة رقمه عدد: يعدّله قسم المنشأة', async () => {
    const c = db.get<Record<string, unknown>>(`SELECT * FROM company WHERE id = 1`)!;
    expect(await write(COMPANY, doc('company', '1', { ...c, name: 'منشأة مصطنعة' }))).toMatchObject({ ok: true });
  });

  test('المستأجر تتبع عقاراته عقوده: المحصور يكتبه بعقاره بعد أن كان عاماً', async () => {
    expect(await write(CONTR, doc('tenants', T0, { ...row('tenants', T0), phone: '0500000094' }), { pids: ['P1'] })).toMatchObject({ ok: true });
  });

  test('ذو كل العقارات ينقل عقده إلى وحدة في عقار آخر بحقيقته', async () => {
    const moved = doc('contracts', C1, { ...row('contracts', C1), unit_id: 'VUN2' }, 'v9');
    expect(annotate(db, { ...moved, d: { ...moved.d!, unit_id: 'VUN1' } as never }, ALLCON).doc.pids).toEqual(['P1']);
    db.run(`UPDATE contracts SET unit_id = 'VUN2' WHERE id = ?`, [C1]);
    // كما يرفعه جهازه: المستند وإسقاطه في طلب واحد
    const r = remoteFor(ALLCON.uid!, ALLCON);
    const sent = r.annotate!(db, moved);
    expect(sent.companions?.length).toBe(1);
    expect((await r.write([sent]))[0]).toMatchObject({ ok: true });
    db.run(`UPDATE contracts SET unit_id = 'VUN1' WHERE id = ?`, [C1]);
  });

  test('#٣٩ اللمس الجانبي لا يغيّر سطور القيد', async () => {
    const je = row('journal_entries', 'VJE');
    const entry = { ...doc('journal_entries', 'VJE', { ...je, reversed_by: null }), lines: [] as never[] };
    const base = annotate(db, entry, COLLECTOR).doc;
    // يغيّر السطور وd كما هو (اللمس الفارغ)، ومع لمس reversed_by
    expect((await remoteFor(COLLECTOR.uid!, COLLECTOR).write([{ ...base, lines: [{ id: 'X', entry_id: 'VJE', account_code: '1100', debit_halalas: 1, credit_halalas: 0 }] as never }]))[0])
      .toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect((await remoteFor(COLLECTOR.uid!, COLLECTOR).write([{ ...base, d: { ...base.d!, reversed_by: 'VJX' }, lines: [{ id: 'X', entry_id: 'VJE', account_code: '1100', debit_halalas: 1, credit_halalas: 0 }] as never }]))[0])
      .toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('المحصور لا ينقل صفاً بين عقاراته (رؤيته لا تُفحص بعد النقل) · ولا إلى عقار ليس له', async () => {
    const r = remoteFor(TWO.uid!, TWO);
    // عقدٌ له وحده في عقاره الأول (لا يمسّه اختبار قبله)
    const to = (unit: string) => doc('contracts', C3, { ...row('contracts', C3), unit_id: unit }, 'v' + unit);
    db.run(`UPDATE contracts SET unit_id = 'VUN2' WHERE id = ?`, [C3]);
    expect((await r.write([r.annotate!(db, to('VUN2'))]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    db.run(`UPDATE contracts SET unit_id = 'VUN3' WHERE id = ?`, [C3]);
    expect((await r.write([r.annotate!(db, to('VUN3'))]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    db.run(`UPDATE contracts SET unit_id = 'VUN4' WHERE id = ?`, [C3]);
  });

  test('شاهد الحذف فارغ: لا يُبقي d برؤية أوسع فيكشف المبالغ', async () => {
    const unit = row('units', 'VUN1');
    // كما أرسله المتحقق: شاهدٌ يُبقي d (كتابة جزئية) برموز رؤية قسمه
    const res = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents:commit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(TECH.uid!) },
      body: JSON.stringify({ writes: [{
        update: { name: `projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/rows/units__VUN1`,
          fields: encodeFields({ del: true, g: ['props|P1'], u: 'x9', dev: 'dev-v', op: 'props' }) },
        updateMask: { fieldPaths: ['del', 'g', 'u', 'dev', 'op'] },
        updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }] }] }) });
    expect(res.status).toBe(403);
    expect(unit.id).toBe('VUN1');
  });

  test('المستأجر: لا يأخذه محصورٌ من عقار ليس له', async () => {
    db.run(`INSERT INTO tenants (id, name, phone, created_at) VALUES ('VT2', 'مستأجر عقار آخر مصطنع', '0500000096', '2026-01-01T00:00:00.000Z')`);
    const owner = remoteFor(ORG, null);
    const td = owner.annotate!(db, doc('tenants', 'VT2', row('tenants', 'VT2')));
    expect((await owner.write([{ ...td, pids: ['P2'], g: ['tenants|P2', 'tenants|@'], companions: undefined }]))[0]).toMatchObject({ ok: true });
    expect(await write(CONTR, doc('tenants', 'VT2', { ...row('tenants', 'VT2'), name: 'اسم مزوّر' }), { pids: ['*'], g: ['tenants|*', 'tenants|@'] }))
      .toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('R1 المستأجر المشترك: لا يغيّر المحصور رؤيته فيقرأ رصيده، ولا يُسقط عنه عقاراً ليس له', async () => {
    db.run(`INSERT INTO tenants (id, name, phone, credit_halalas, notes, created_at) VALUES ('VT3', 'مستأجر مشترك مصطنع', '0500000097', 7777, 'ملاحظة مصطنعة', '2026-01-01T00:00:00.000Z')`);
    const owner = remoteFor(ORG, null);
    const base = owner.annotate!(db, doc('tenants', 'VT3', row('tenants', 'VT3')));
    const mainG = base.g!;
    const pubG = ['tenants|P1', 'tenants|P2', 'tenants|@', 'contracts|P1', 'contracts|P2', 'contracts|@'];
    expect((await owner.write([{ ...base, pids: ['P1', 'P2'], companions: undefined }]))[0]).toMatchObject({ ok: true });
    expect((await owner.write([{ ...base.companions![0], pids: ['P1', 'P2'], g: pubG }]))[0]).toMatchObject({ ok: true });
    const r = remoteFor(CONTR.uid!, CONTR);
    const mine = annotate(db, doc('tenants', 'VT3', { ...row('tenants', 'VT3'), phone: '0500000098' }), CONTR).doc;
    // المستند الكامل برؤية قسمه وعقاره وحده
    expect((await r.write([{ ...mine, pids: ['P1'], g: ['tenants|P1'] }]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // والإسقاط بلا عقار ليس له
    const pub = { ...base.companions![0], u: 'r1', dev: 'dev-v', op: 'tenants', d: { ...base.companions![0].d!, phone: '0500000098' } };
    expect((await r.write([{ ...pub, pids: ['P1'], g: ['tenants|P1', 'tenants|@', 'contracts|P1', 'contracts|@'] }]))[0])
      .toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(mainG.length).toBeGreaterThan(0);
  });

  test('التحقق المستقل: عضوٌ بإدخال لا يعيد كتابة مبالغ تسوية غيره ولا يحذف مطالبة', async () => {
    const ADD = member('U-VADD', { contracts: 2, deposits: 2, props: 1 }, ['P1']);
    expect(await putDoc(`orgs/${ORG}/members/${ADD.uid}`, { email: 'u-vadd@example.test', perm: ADD.perms, all: false, props: ['P1'], tokens: memberTokens(ADD) }, ORG)).toBe(200);
    db.run(`INSERT INTO deposit_settlements (contract_id, date, deduction_halalas, deduction_reason, refund_halalas, notes, deduct_destination) VALUES (?, '2026-07-01', 100, '', 0, '', '')`, [C1]);
    db.run(`INSERT INTO claims (id, contract_id, amount_halalas, reason, date, status, source, created_at) VALUES ('VCL', ?, 500, 'مطالبة مصطنعة', '2026-07-01', 'مفتوحة', 'يدوية', 'x')`, [C1]);
    const owner = remoteFor(ORG, null);
    const ds = owner.annotate!(db, doc('deposit_settlements', C1, db.get<Record<string, unknown>>(`SELECT * FROM deposit_settlements WHERE contract_id = ?`, [C1])!));
    const cl = owner.annotate!(db, doc('claims', 'VCL', row('claims', 'VCL')));
    expect((await owner.write([ds, cl]))).toEqual([{ ok: true, code: 'OK' }, { ok: true, code: 'OK' }]);
    const dsRow = db.get<Record<string, unknown>>(`SELECT * FROM deposit_settlements WHERE contract_id = ?`, [C1])!;
    expect(await write(ADD, doc('deposit_settlements', C1, { ...dsRow, deduction_halalas: 999999 }))).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(await write(ADD, doc('claims', 'VCL', { ...row('claims', 'VCL'), deleted_at: '2026-07-02' }))).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('التحقق المستقل: إسقاط المستأجر يزيد برموز عقارين أُضيفا معاً · ولا تُنقص رؤيته وعقاراته كما هي', async () => {
    db.run(`INSERT INTO tenants (id, name, phone, created_at) VALUES ('VT4', 'مستأجر نمو مصطنع', '0500000172', '2026-01-01T00:00:00.000Z')`);
    const owner = remoteFor(ORG, null);
    const base = owner.annotate!(db, doc('tenants', 'VT4', row('tenants', 'VT4')));
    expect((await owner.write([base]))[0]).toMatchObject({ ok: true });
    const pub0 = base.companions![0];
    const TALL = member('U-VTAL', { tenants: 3, contracts: 1 }, 'all');
    expect(await putDoc(`orgs/${ORG}/members/${TALL.uid}`, { email: 'u-vtal@example.test', perm: TALL.perms, all: true, props: [], tokens: memberTokens(TALL) }, ORG)).toBe(200);
    // ذو كل العقارات: من «*» إلى عقارين معاً
    const grown = { ...pub0, u: 'g2', dev: 'dev-v', op: 'tenants', pids: ['P1', 'P2'],
      g: [...pub0.g!.filter((x) => x.endsWith('|@')), ...pub0.g!.filter((x) => x.endsWith('|@')).flatMap((x) => [x.replace('|@', '|P1'), x.replace('|@', '|P2')])].sort() };
    expect((await remoteFor(TALL.uid!, TALL).write([grown]))[0]).toMatchObject({ ok: true });
    // وعقاراته كما هي: لا تُنقص رؤيته
    expect((await remoteFor(TALL.uid!, TALL).write([{ ...grown, u: 'g3', g: grown.g!.filter((x) => !x.endsWith('|P2')) }]))[0])
      .toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('التحقق المستقل: المحصور يعدّل مستأجراً مشتركاً بين عقاره وعقار غيره (بعقاراته في السحابة كما هي)', async () => {
    db.run(`INSERT INTO tenants (id, name, phone, created_at) VALUES ('VT5', 'مستأجر مشترك آخر مصطنع', '0500000173', '2026-01-01T00:00:00.000Z')`);
    const owner = remoteFor(ORG, null);
    const base = owner.annotate!(db, doc('tenants', 'VT5', row('tenants', 'VT5')));
    const g2 = (g: string[]) => [...g.filter((x) => x.endsWith('|@')), ...g.filter((x) => x.endsWith('|@')).flatMap((x) => [x.replace('|@', '|P1'), x.replace('|@', '|P2')])].sort();
    expect((await owner.write([{ ...base, pids: ['P1', 'P2'], companions: [{ ...base.companions![0], pids: ['P1', 'P2'], g: g2(base.companions![0].g!) }] }]))[0])
      .toMatchObject({ ok: true });
    // جهاز المحصور حفظ عقاراته في السحابة عند السحب · فيرفع تعديله بها
    db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('tenant_pids:VT5', '["P1","P2"]')`);
    const r = remoteFor(CONTR.uid!, CONTR);
    const sent = r.annotate!(db, doc('tenants', 'VT5', { ...row('tenants', 'VT5'), phone: '0500000174' }, 't5'));
    expect(sent.pids).toEqual(['P1', 'P2']);
    expect((await r.write([sent]))[0]).toMatchObject({ ok: true });
    db.run(`DELETE FROM sync_state WHERE k = 'tenant_pids:VT5'`);
  });

  test('التحقق المستقل: نموّ إسقاط المستأجر لا يُنقص رؤية عقارٍ قائم', async () => {
    db.run(`INSERT INTO tenants (id, name, phone, created_at) VALUES ('VT6', 'مستأجر ثلاثي مصطنع', '0500000175', '2026-01-01T00:00:00.000Z')`);
    const owner = remoteFor(ORG, null);
    const base = owner.annotate!(db, doc('tenants', 'VT6', row('tenants', 'VT6')));
    const at = base.companions![0].g!.filter((x) => x.endsWith('|@'));
    const toks = (ps: string[]) => [...at, ...at.flatMap((x) => ps.map((p) => x.replace('|@', '|' + p)))].sort();
    expect((await owner.write([{ ...base, pids: ['P1', 'P2'], companions: [{ ...base.companions![0], pids: ['P1', 'P2'], g: toks(['P1', 'P2']) }] }]))[0])
      .toMatchObject({ ok: true });
    const TALL2 = member('U-VTA2', { tenants: 3 }, 'all');
    expect(await putDoc(`orgs/${ORG}/members/${TALL2.uid}`, { email: 'u-vta2@example.test', perm: TALL2.perms, all: true, props: [], tokens: memberTokens(TALL2) }, ORG)).toBe(200);
    const pub = { ...base.companions![0], u: 'g6', dev: 'dev-v', op: 'tenants', pids: ['P1', 'P2', 'P3'] };
    // يضيف عقاراً ويُسقط رموز عقارٍ قائم
    expect((await remoteFor(TALL2.uid!, TALL2).write([{ ...pub, g: toks(['P1', 'P3']) }]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect((await remoteFor(TALL2.uid!, TALL2).write([{ ...pub, g: toks(['P1', 'P2', 'P3']) }]))[0]).toMatchObject({ ok: true });
  });

  test('التحقق المستقل: المحصور لا يكتب ملاحظات المستأجر المشترك ولا يحذفه عن غيره ولا يكتبها في إسقاطه', async () => {
    db.run(`INSERT INTO tenants (id, name, phone, notes, created_at) VALUES ('VT7', 'مستأجر ملاحظات مصطنع', '0500000176', 'ملاحظة المالك', '2026-01-01T00:00:00.000Z')`);
    const owner = remoteFor(ORG, null);
    const base = owner.annotate!(db, doc('tenants', 'VT7', row('tenants', 'VT7')));
    const at = base.companions![0].g!.filter((x) => x.endsWith('|@'));
    const toks = [...at, ...at.flatMap((x) => [x.replace('|@', '|P1'), x.replace('|@', '|P2')])].sort();
    expect((await owner.write([{ ...base, pids: ['P1', 'P2'], companions: [{ ...base.companions![0], pids: ['P1', 'P2'], g: toks }] }]))[0])
      .toMatchObject({ ok: true });
    const r = remoteFor(CONTR.uid!, CONTR);
    const main = { ...base, u: 't7', dev: 'dev-v', op: 'tenants', pids: ['P1', 'P2'], companions: undefined };
    const pub = { ...base.companions![0], u: 't7', dev: 'dev-v', op: 'tenants', pids: ['P1', 'P2'], g: toks };
    expect((await r.write([{ ...main, d: { ...main.d!, notes: 'مُسحت' } }]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect((await r.write([{ ...main, d: { ...main.d!, deleted_at: '2026-07-01' } }]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect((await r.write([{ ...pub, d: { ...pub.d!, notes: 'في الإسقاط' } }]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect((await r.write([{ ...main, d: { ...main.d!, phone: '0500000177' } }]))[0]).toMatchObject({ ok: true });
  });

  test('التحقق المستقل: الإقرار المقدَّم للمنشأة كلها يكتبه ذو كل العقارات وحده · ولا يقرؤه المحصور', async () => {
    const q2 = { id: '2026-Q2', period_from: '2026-04-01', period_to: '2026-06-30', filed_at: '2026-07-15', snapshot: '{}', created_at: '2026-07-15T00:00:00.000Z', deleted_at: null as string | null };
    db.run(`INSERT INTO vat_filings (id, period_from, period_to, filed_at, snapshot, created_at) VALUES (?,?,?,?,?,?)`,
      [q2.id, q2.period_from, q2.period_to, q2.filed_at, q2.snapshot, q2.created_at]);
    const owner = remoteFor(ORG, null);
    const base = owner.annotate!(db, doc('vat_filings', q2.id, q2));
    // رؤيته رموز «كل العقارات» وحدها
    expect(base.g!.length).toBeGreaterThan(0);
    expect(base.g!.every((x) => x.endsWith('|@'))).toBe(true);
    expect((await owner.write([base]))[0]).toMatchObject({ ok: true });
    const RREST = member('U-VRPR', { reports: 3, collect: 1 }, ['P1']);
    const RALL = member('U-VRPA', { reports: 3 }, 'all');
    for (const a of [RREST, RALL]) {
      expect(await putDoc(`orgs/${ORG}/members/${a.uid}`, { email: a.uid!.toLowerCase() + '@example.test', perm: a.perms, all: a.allProps, props: a.props, tokens: memberTokens(a) }, ORG)).toBe(200);
    }
    const q3 = { ...q2, id: '2026-Q3', period_from: '2026-07-01', period_to: '2026-09-30' };
    const as = (a: typeof RREST, d: typeof q2, u: string) => remoteFor(a.uid!, a).annotate!(db, doc('vat_filings', d.id, d, u));
    // المحصور: لا ينشئ ولا يسحب
    expect((await remoteFor(RREST.uid!, RREST).write([as(RREST, q3, 'f1')]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect((await remoteFor(RREST.uid!, RREST).write([as(RREST, { ...q2, deleted_at: '2026-08-01T00:00:00.000Z' }, 'f2')]))[0])
      .toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // ولا يقرؤه
    const res = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/rows/${base.id}`,
      { headers: { Authorization: 'Bearer ' + token(RREST.uid!) } });
    expect(res.status).toBe(403);
    // ذو كل العقارات ينشئ
    expect((await remoteFor(RALL.uid!, RALL).write([as(RALL, q3, 'f3')]))[0]).toMatchObject({ ok: true });
  });
});

