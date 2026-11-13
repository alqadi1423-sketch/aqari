/**
 * B-1 · حرج · firestore.rules:492-516 (memberCreates) و:627  (memberUpdates: «كامل» يعدّل جدول قسمه بلا شرط الحالة) · مولَّدٌ من
 * src/domain/access/rulesGen.ts · على محاكي Firestore (يُتخطّى بلا FIRESTORE_EMULATOR_HOST).
 *
 * السيناريو (بيانات مصطنعة): فاتورة بيعٍ صادرة (مستحقة) في السحابة بسطرها. (أ) عضوٌ له «إدخال» وحده في الفواتير ينشئ سطراً جديداً
 * لها بمستندٍ بناه جهازه (annotate) · (ب) عضوٌ له «كامل» الفواتير يغيّر صافي الفاتورة الصادرة وضريبتها مباشرةً بلا قيد.
 *
 * لماذا يهم: «الفاتورة الصادرة مقفلة» (قرار المالك 2026-10-07 على #30 · DESIGN §١٣.١٣) · والسحابة تقبل الكتابتين، وجهاز المالك
 * يطبّقهما بلا فحص (tests/review9.B.issuedInvoiceLines.test.ts)، فيتغيّر الإقرار ونسخة الفاتورة المطبوعة بعد إصدارها.
 *
 * السلوك الصحيح: القاعدة ترفض الاثنتين ما دامت الفاتورة غير مسودة (سطرٌ لفاتورةٍ صادرة، وتغيير مبالغ الصادرة أو بنودها) · وما لا
 * يتسعه حدّ الألف تعبير يُرفض على جهاز المالك (B-1 في التقرير).
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import { OWNER_ACCESS, type Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';
import { buildDoc } from '@/sync/engine';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'OWNER-R9B';
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
async function putDoc(path: string, data: Record<string, unknown>, uid: string): Promise<number> {
  const res = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) },
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  return res.status;
}
async function addMember(uid: string, a: Access): Promise<void> {
  expect(await putDoc(`orgs/${ORG}/members/${uid}`, {
    email: uid.toLowerCase() + '@example.test', perm: a.perms, all: a.allProps, props: a.props, tokens: memberTokens(a),
    orgName: 'منشأة مصطنعة', name: '', phone: '', nid: '', title: '',
  }, ORG)).toBe(200);
}

d('B-1 · الفاتورة الصادرة في قواعد السحابة', () => {
  const ENTRY: Access = { owner: false, uid: 'R9B-ENTRY', perms: { invoices: 2 }, allProps: false, props: ['P-R9B'] };
  const FULL: Access = { owner: false, uid: 'R9B-FULL', perms: { invoices: 3 }, allProps: true, props: [] };
  let db: import('@/db/adapter').DB;
  let inv = '';

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { saveInvoice } = await import('@/domain/invoices');
    db = memDb();
    inv = saveInvoice(db, {
      customer: 'عميل مصطنع', customerVat: '', issue: '2026-04-10', due: '2026-04-30', notes: '', propertyId: 'P-R9B',
      lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100_000, taxPct: 15 }],
    }, 'مستحقة');
    // كاتب الفاتورة المالك كما يسجّله محفّز row_by على جهازه (الهجرة ٢٢) ويصل كل جهاز مع مستندها
    db.run(`INSERT OR REPLACE INTO row_by (tbl, pk, uid) VALUES ('invoices', ?, ?)`, [inv, ORG]);
    const owner = remoteFor(ORG, null);
    const line = db.get<{ id: string }>(`SELECT id FROM invoice_lines WHERE invoice_id = ?`, [inv])!.id;
    const docs = [buildDoc(db, 'invoices', inv, 'upsert', new Date().toISOString(), 'DEV-OWNER'),
      buildDoc(db, 'invoice_lines', line, 'upsert', new Date().toISOString(), 'DEV-OWNER')].map((x) => {
      const { doc, pub } = annotate(db, x, OWNER_ACCESS);
      return pub ? { ...doc, companions: [pub] } : doc;
    });
    expect((await owner.write(docs)).every((r) => r.ok)).toBe(true);
    await addMember(ENTRY.uid!, ENTRY);
    await addMember(FULL.uid!, FULL);
  });
  afterAll(() => db?.close());

  test.failing('(أ) عضو «إدخال» لا ينشئ سطراً لفاتورةٍ صادرة', async () => {
    const k = 'R9B-FORGED-LINE';
    const forged: RemoteDoc = annotate(db, {
      id: 'invoice_lines__' + k, t: 'invoice_lines', k, u: new Date().toISOString(), dev: 'DEV-M', del: false,
      d: { id: k, invoice_id: inv, descr: 'سطر مضاف', qty: 1, price_halalas: 10_000_000, tax_pct: 15, sort: 9, tax_code: 'S' },
    }, ENTRY).doc;
    const [res] = await remoteFor(ENTRY.uid!, ENTRY).write([forged]);
    // eslint-disable-next-line no-console
    console.log('B-1 (أ) · كتابة سطرٍ لفاتورةٍ صادرة من عضو «إدخال»:', res);
    expect(res.ok).toBe(false);
  });

  test.failing('(ب) عضو «كامل» لا يغيّر مبالغ فاتورةٍ صادرة بلا قيد', async () => {
    const cur = buildDoc(db, 'invoices', inv, 'upsert', new Date().toISOString(), 'DEV-F');
    const changed: RemoteDoc = { ...cur, d: { ...cur.d!, subtotal_halalas: 1_000, tax_halalas: 150, total_halalas: 1_150 } };
    const doc = annotate(db, changed, FULL).doc;
    const [res] = await remoteFor(FULL.uid!, FULL).write([doc]);
    // eslint-disable-next-line no-console
    console.log('B-1 (ب) · تعديل مبالغ فاتورةٍ صادرة من عضو «كامل»:', res);
    expect(res.ok).toBe(false);
  });
});

d('B-2 · ما يراه جوال العضو المُزال من السحابة (يسند محاكاة tests/review9.B.revokedMember.test.ts)', () => {
  const GONE = 'R9B-GONE';
  const get = async (p: string) => (await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${p}`,
    { headers: { Authorization: 'Bearer ' + token(GONE) } })).status;
  test('عهد المسح يُرفض (403) ومستند عضويته المحذوف يُقرأ «غير موجود» (404)', async () => {
    const a: Access = { owner: false, uid: GONE, perms: { collect: 1 }, allProps: true, props: [] };
    await addMember(GONE, a);
    expect(await get(`orgs/${ORG}/meta/epoch`)).toBe(404);
    // المالك يزيله
    const del = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/members/${GONE}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer ' + token(ORG) } });
    expect(del.status).toBe(200);
    expect(await get(`orgs/${ORG}/meta/epoch`)).toBe(403);
    expect(await get(`orgs/${ORG}/members/${GONE}`)).toBe(404);
    await expect(remoteFor(GONE, a).pull(null, 50)).rejects.toThrow(/403|PERMISSION_DENIED/);
  });
});

d('B-3 · تسجيل الضريبة في صفّ المنشأة من عضو «كامل المنشأة»', () => {
  test.failing('القاعدة ترفض تغيير vat_enabled من عضو (إعدادٌ للمالك وحده في الشاشة)', async () => {
    const { memDb } = await import('./helpers/testDb');
    const db2 = memDb();
    db2.run(`UPDATE company SET vat_enabled = 1, name = 'منشأة مصطنعة' WHERE id = 1`);
    const owner = remoteFor(ORG, null);
    const base = buildDoc(db2, 'company', '1', 'upsert', new Date().toISOString(), 'DEV-OWNER');
    expect((await owner.write([annotate(db2, base, OWNER_ACCESS).doc]))[0].ok).toBe(true);
    const CO: Access = { owner: false, uid: 'R9B-CO', perms: { company: 3 }, allProps: true, props: [] };
    await addMember(CO.uid!, CO);
    const off = annotate(db2, { ...base, d: { ...base.d!, vat_enabled: 0 } }, CO).doc;
    const [res] = await remoteFor(CO.uid!, CO).write([off]);
    // eslint-disable-next-line no-console
    console.log('B-3 · عضو «كامل المنشأة» يطفئ تسجيل الضريبة:', res);
    expect(res.ok).toBe(false);
    db2.close();
  });
});
