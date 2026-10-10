/**
 * المراجعات الخارجية «ثالثاً أ» (قرار المالك 2026-10-09) على محاكي Firestore · القاعدة ٩٨: كل بند يُثبت باختبار سلبي يرفضه،
 * ومعه إيجابي يثبت أن الطريق المشروع يعمل · بيانات مصطنعة.
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/securityA.emulator.test.ts"
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import { OWNER_ACCESS, type Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'SECA-OWNER';
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
    access: () => a ?? OWNER_ACCESS,
  });
}
async function putDoc(path: string, data: Record<string, unknown>, uid: string): Promise<number> {
  const res = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) },
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  return res.status;
}

d('ثالثاً أ · الصفوف والقيود وسجل العمليات', () => {
  const COLLECTOR = member('SA-COL', { collect: 2, contracts: 1, props: 1 }, ['P1']);
  const LEDGER = member('SA-LED', { ledger: 3, props: 1 }, 'all');
  let db: import('@/db/adapter').DB;
  let C1 = '', I1 = '';

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract, recordRentPayment } = await import('@/domain/contracts/service');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    db = memDb();
    const p1 = addProperty(db, { id: 'P1', name: 'عقار أول تجريبي' });
    const p2 = addProperty(db, { id: 'P2', name: 'عقار ثانٍ تجريبي' });
    C1 = confirmContract(db, contractInput(addUnit(db, p1, { id: 'UN1' }), { tenant: 'مستأجر أول تجريبي', idNumber: '1000000033', phone: '0500000011' }));
    confirmContract(db, contractInput(addUnit(db, p2, { id: 'UN2' }), { tenant: 'مستأجر ثانٍ تجريبي', idNumber: '1000000041', phone: '0500000012' }));
    I1 = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [C1])!.id;
    recordRentPayment(db, C1, { installmentId: I1, period: 'الأول', date: '2026-01-05', lines: [{ method: 'cash', amountHalalas: 1000 }], discountHalalas: 0, notes: '' });
    enableSync(db, ORG);
    expect((await syncOnce(db, remoteFor(ORG, null), 'dev-owner')).pending).toBe(0);
    for (const a of [COLLECTOR, LEDGER]) {
      expect(await putDoc(`orgs/${ORG}/members/${a.uid}`, {
        email: a.uid!.toLowerCase() + '@example.test', perm: a.perms, all: a.allProps, props: a.props, tokens: memberTokens(a),
      }, ORG)).toBe(200);
    }
  });

  const writeRaw = async (a: Access | null, doc: RemoteDoc) => (await remoteFor(a ? a.uid! : ORG, a).write([doc]))[0];
  const ann = (a: Access | null, doc: RemoteDoc) => annotate(db, doc, a ?? OWNER_ACCESS).doc;

  test('٢ رموز رؤية الصف الجديد: صفٌّ عقاره أ ورموزه لعقار ب يُرفض · وبرموز عقاره يُقبل', async () => {
    const pay = (id: string): RemoteDoc => ({ id: 'contract_payments__' + id, t: 'contract_payments', k: id, u: 'x', dev: 'dev-col', del: false,
      d: { id, contract_id: C1, installment_id: I1, date: '2026-05-01', gross_halalas: 100, discount_halalas: 0, net_halalas: 100 } });
    const ok = ann(COLLECTOR, pay('SAP1'));
    expect(await writeRaw(COLLECTOR, ok)).toMatchObject({ ok: true });
    const forged = ann(COLLECTOR, pay('SAP2'));
    expect(await writeRaw(COLLECTOR, { ...forged, g: [...forged.g!, 'collect|P2', 'ledger|P2'] })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('٣ القيد العكسي الوهمي: reversed_by لقيدٍ غير موجود أو لا يعكسه يُرفض · والعكس الحقيقي يُقبل', async () => {
    const { buildDoc } = await import('@/sync/engine');
    const { reverseEntryById } = await import('@/domain/accounting/post');
    const e = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE status = 'مرحّل' AND src_type = 'rent' LIMIT 1`)!.id;
    const base = buildDoc(db, 'journal_entries', e, 'upsert', new Date().toISOString(), 'dev-owner');
    expect(await writeRaw(null, ann(null, { ...base, u: 'rv-1', d: { ...base.d!, reversed_by: 'FAKE-ENTRY' } }))).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // قيدٌ موجود لا يعكسه (قيد تأمين العقد مثلاً) يُرفض أيضاً
    const other = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE status = 'مرحّل' AND id != ? LIMIT 1`, [e])!.id;
    expect(await writeRaw(null, ann(null, { ...base, u: 'rv-2', d: { ...base.d!, reversed_by: other } }))).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // العكس الحقيقي: القيد العكسي يُرفع ثم يُربط
    const rev = reverseEntryById(db, e, 'عكس تجريبي')!;
    const revDoc = buildDoc(db, 'journal_entries', rev.id, 'upsert', new Date().toISOString(), 'dev-owner');
    expect(await writeRaw(null, ann(null, revDoc))).toMatchObject({ ok: true });
    const linked = buildDoc(db, 'journal_entries', e, 'upsert', new Date().toISOString(), 'dev-owner');
    expect(await writeRaw(null, ann(null, { ...linked, u: 'rv-3' }))).toMatchObject({ ok: true });
  });

  test('٤ مصدر القيد عند التعديل كالإنشاء: عضو الدفتر لا يجعل مصدر قيده «إيجار» ولا يرحّله به', async () => {
    const entry = (u: string, d: Record<string, unknown>): RemoteDoc => ({ id: 'journal_entries__SAJ1', t: 'journal_entries', k: 'SAJ1', u, dev: 'dev-led', del: false,
      d: { id: 'SAJ1', no: 'JE-SA1', date: '2026-05-01', memo: 'قيد يدوي تجريبي', status: 'قيد الإنشاء', auto: 0, created_at: '2026-05-01', src_type: null, src_id: null, ...d },
      lines: [{ id: 'SAJ1a', entry_id: 'SAJ1', account_code: '1100', descr: '', debit_halalas: 100, credit_halalas: 0 },
        { id: 'SAJ1b', entry_id: 'SAJ1', account_code: '3100', descr: '', debit_halalas: 0, credit_halalas: 100 }] });
    expect(await writeRaw(LEDGER, ann(LEDGER, entry('j1', {})))).toMatchObject({ ok: true });
    expect(await writeRaw(LEDGER, ann(LEDGER, entry('j2', { src_type: 'rent', src_id: 'X' })))).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(await writeRaw(LEDGER, ann(LEDGER, entry('j3', { src_type: 'rent', src_id: 'X', status: 'مرحّل' })))).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(await writeRaw(LEDGER, ann(LEDGER, entry('j4', { status: 'مرحّل' })))).toMatchObject({ ok: true });
  });

  test('٥ مجموعا القيد مع sv: غير المتوازن والمفقود والكسر تُرفض · والمتوازن والمسودة وما بلا sv تُقبل', async () => {
    const { SCHEMA_VERSION } = await import('@/db/schema');
    // يعبث بالحقول قبل الإرسال كجهازٍ معدَّل (المجموعان يحسبهما العميل من السطور فلا يختلفان عنها)
    const svRemote = (tamper?: (f: Record<string, unknown>) => void) => new FirestoreRemote({
      projectId: PROJECT, uid: ORG, org: ORG, idToken: async () => token(ORG), baseUrl: 'http://' + HOST,
      memberTokens: () => null, fullReadTables: () => new Set(), access: () => OWNER_ACCESS, sv: () => SCHEMA_VERSION,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (tamper && init?.body && String(url).endsWith(':commit')) {
          const b = JSON.parse(String(init.body)) as { writes?: Array<{ update?: { fields: Record<string, unknown> } }> };
          for (const w of b.writes ?? []) if (w.update) tamper(w.update.fields);
          init = { ...init, body: JSON.stringify(b) };
        }
        return fetch(url, init);
      }) as typeof fetch,
    });
    const entry = (k: string, debit: number, credit: number, status = 'مرحّل'): RemoteDoc => ({ id: 'journal_entries__' + k, t: 'journal_entries', k, u: 's5', dev: 'dev-owner', del: false,
      d: { id: k, no: 'JE-' + k, date: '2026-05-02', memo: 'قيد تجريبي', status, auto: 0, created_at: '2026-05-02', src_type: null, src_id: null },
      lines: [{ id: k + 'a', entry_id: k, account_code: '1100', descr: '', debit_halalas: debit, credit_halalas: 0 },
        { id: k + 'b', entry_id: k, account_code: '3100', descr: '', debit_halalas: 0, credit_halalas: credit }] });
    const w = async (doc: RemoteDoc, tamper?: (f: Record<string, unknown>) => void) => (await svRemote(tamper).write([ann(null, doc)]))[0];
    const DENIED = { ok: false, code: 'PERMISSION_DENIED' };
    // سلبي: غير متوازن · وsv بلا مجموعين · ومجموعان بكسر · ومجموعان نصّان
    expect(await w(entry('S5A', 100, 90))).toMatchObject(DENIED);
    expect(await w(entry('S5B', 100, 100), (f) => { delete f.dr; delete f.cr; })).toMatchObject(DENIED);
    expect(await w(entry('S5C', 100, 100), (f) => { f.dr = { doubleValue: 100.5 }; f.cr = { doubleValue: 100.5 }; })).toMatchObject(DENIED);
    expect(await w(entry('S5D', 100, 100), (f) => { f.dr = { stringValue: '100' }; f.cr = { stringValue: '100' }; })).toMatchObject(DENIED);
    // إيجابي: المتوازن · ومسودة «قيد الإنشاء» قبل توازنها · وإصدارٌ أقدم بلا sv كما كان
    expect(await w(entry('S5E', 100, 100))).toMatchObject({ ok: true });
    expect(await w(entry('S5F', 100, 90, 'قيد الإنشاء'))).toMatchObject({ ok: true });
    expect(await writeRaw(null, ann(null, entry('S5G', 100, 100)))).toMatchObject({ ok: true });
    // والقيد المرحّل القديم بلا مجموعين: يُكتبان معه مع إعادة كتابة الرؤية (الطريق المشروع على المرحّل)
    expect(await w({ ...entry('S5G', 100, 100), u: 's5-2' })).toMatchObject({ ok: true });
  });

  test('٦ سجل العمليات بنسخته ذات اللاحقة: لا يُنشأ باسم المالك ولا يُعدَّل', async () => {
    const row = (u: string, t: string, name: string): RemoteDoc => ({ id: t + '__SAA1', t, k: 'SAA1', u, dev: 'dev-col', del: false,
      d: { id: 'SAA1', ts: '2026-05-01T00:00:00', user_name: name, module: 'التحصيل', action_type: 'update', entity_type: 'سطر تجريبي', entity_name: 'تجريبي' } });
    const forged = ann(COLLECTOR, row('a1', 'audit_log', 'المالك'));
    expect(await writeRaw(COLLECTOR, { ...forged, id: 'audit_log~pub__SAA1', t: 'audit_log~pub' })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    const mine = ann(COLLECTOR, row('a2', 'audit_log', 'محصّل تجريبي'));
    expect(await writeRaw(COLLECTOR, mine)).toMatchObject({ ok: true });
  });
});
