/**
 * المراجعة الشاملة 2026-11-13 · B-1 وB-3 · ما بقي من قواعد القفل خارج tests/review9.B.rules.emulator.test.ts، على محاكي Firestore (يُتخطّى بلا
 * FIRESTORE_EMULATOR_HOST) · بيانات مصطنعة:
 *  - الفاتورة الصادرة لا يعيدها «كامل» مسودة ولا يحذفها حذفاً ناعماً (lockedUpdateOk)، ويحصّلها (تعديلٌ يكتبه التطبيق).
 *  - سطر المسودة من «إدخال» يُقبل (lockedCreateOk يقرأ رأسها بعد الالتزام).
 *  - صفّ المنشأة: لا يحذفه «كامل» المنشأة ولا ينشئه عضو، ويعدّل اسمه (ownerColsKept).
 *  - المدقق المستقل R11: رابط قيد إصدار الصادرة لا يُمحى (issuedInvoiceKept)، ومبالغ فاتورة الشراء المرحّلة لا تتغيّر بلا قيدها الجديد
 *    (postedPurchaseKept).
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import { OWNER_ACCESS, type Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';
import { buildDoc } from '@/sync/engine';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'OWNER-R9BL';
const d = HOST ? describe : describe.skip;

function token(uid: string, email = uid.toLowerCase() + '@example.test'): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const remoteFor = (uid: string, a: Access | null, org = ORG) => new FirestoreRemote({
  projectId: PROJECT, uid, org, idToken: async () => token(uid), baseUrl: 'http://' + HOST,
  memberTokens: () => (a ? memberTokens(a) : null),
  fullReadTables: () => (a ? fullReadTables(a, SYNC_TABLES.map((t) => t.name)) : new Set()),
  access: () => a ?? OWNER_ACCESS,
});
async function addMember(uid: string, a: Access, org = ORG): Promise<void> {
  const res = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${org}/members/${uid}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(org) },
    body: JSON.stringify({ fields: encodeFields({
      email: uid.toLowerCase() + '@example.test', perm: a.perms, all: a.allProps, props: a.props, tokens: memberTokens(a),
      orgName: 'منشأة مصطنعة', name: '', phone: '', nid: '', title: '',
    }) }),
  });
  expect(res.status).toBe(200);
}
const now = () => new Date().toISOString();

d('B-1 وB-3 · قواعد القفل الأخرى', () => {
  const FULL: Access = { owner: false, uid: 'R9BL-FULL', perms: { invoices: 3 }, allProps: true, props: [] };
  const ENTRY: Access = { owner: false, uid: 'R9BL-ENTRY', perms: { invoices: 2 }, allProps: true, props: [] };
  const CO: Access = { owner: false, uid: 'R9BL-CO', perms: { company: 3 }, allProps: true, props: [] };
  let db: import('@/db/adapter').DB;
  let inv = '';

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { saveInvoice } = await import('@/domain/invoices');
    db = memDb();
    db.run(`UPDATE company SET vat_enabled = 1, name = 'منشأة مصطنعة' WHERE id = 1`);
    inv = saveInvoice(db, {
      customer: 'عميل مصطنع', customerVat: '', issue: '2026-04-10', due: '2026-04-30', notes: '',
      lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100_000, taxPct: 15 }],
    }, 'مستحقة');
    db.run(`INSERT OR REPLACE INTO row_by (tbl, pk, uid) VALUES ('invoices', ?, ?)`, [inv, ORG]);
    const line = db.get<{ id: string }>(`SELECT id FROM invoice_lines WHERE invoice_id = ?`, [inv])!.id;
    const docs = [buildDoc(db, 'invoices', inv, 'upsert', now(), 'DEV-OWNER'), buildDoc(db, 'invoice_lines', line, 'upsert', now(), 'DEV-OWNER'),
      buildDoc(db, 'company', '1', 'upsert', now(), 'DEV-OWNER')].map((x) => {
      const { doc, pub } = annotate(db, x, OWNER_ACCESS);
      return pub ? { ...doc, companions: [pub] } : doc;
    });
    expect((await remoteFor(ORG, null).write(docs)).every((r) => r.ok)).toBe(true);
    for (const a of [FULL, ENTRY, CO]) await addMember(a.uid!, a);
  });
  afterAll(() => db?.close());

  const writeAs = async (a: Access, doc: RemoteDoc) => (await remoteFor(a.uid!, a).write([annotate(db, doc, a).doc]))[0];
  const invoiceWith = (over: Record<string, string | number | null>): RemoteDoc => {
    const cur = buildDoc(db, 'invoices', inv, 'upsert', now(), 'DEV-M');
    return { ...cur, d: { ...cur.d!, ...over } };
  };

  test('«كامل» لا يعيد الصادرة مسودة ولا يحذفها حذفاً ناعماً، ويحصّلها', async () => {
    expect((await writeAs(FULL, invoiceWith({ status: 'مسودة' }))).ok).toBe(false);
    expect((await writeAs(FULL, invoiceWith({ deleted_at: now() }))).ok).toBe(false);
    expect((await writeAs(FULL, invoiceWith({ status: 'مدفوعة', paid_date: '2026-04-20', payment_method: 'cash' }))).ok).toBe(true);
  });

  test('«إدخال» ينشئ مسودته بسطرها، ولا يضيف سطراً للصادرة', async () => {
    const { saveInvoice } = await import('@/domain/invoices');
    const draft = saveInvoice(db, {
      customer: 'عميل مصطنع ٢', customerVat: '', issue: '2026-04-11', due: '2026-04-30', notes: '',
      lines: [{ descr: 'مسودة مصطنعة', qty: 1, priceHalalas: 5_000, taxPct: 15 }],
    }, 'مسودة');
    db.run(`INSERT OR REPLACE INTO row_by (tbl, pk, uid) VALUES ('invoices', ?, ?)`, [draft, ENTRY.uid!]);
    const line = db.get<{ id: string }>(`SELECT id FROM invoice_lines WHERE invoice_id = ?`, [draft])!.id;
    const res = await remoteFor(ENTRY.uid!, ENTRY).write([buildDoc(db, 'invoices', draft, 'upsert', now(), 'DEV-E'),
      buildDoc(db, 'invoice_lines', line, 'upsert', now(), 'DEV-E')].map((x) => annotate(db, x, ENTRY).doc));
    expect(res.map((r) => r.ok)).toEqual([true, true]);
    const k = 'R9BL-LINE';
    const forged = { id: 'invoice_lines__' + k, t: 'invoice_lines', k, u: now(), dev: 'DEV-E', del: false,
      d: { id: k, invoice_id: inv, descr: 'سطر مضاف', qty: 1, price_halalas: 1, tax_pct: 0, sort: 9, tax_code: 'E' } } as RemoteDoc;
    expect((await writeAs(ENTRY, forged)).ok).toBe(false);
  });

  // المدقق المستقل R11-B1-2: رابط قيد الإصدار في قائمة القاعدة بشرطه (issuedInvoiceKept)
  test('«كامل» لا يمحو رابط قيد إصدار الصادرة ولا يبدّله (R11-B1-2)', async () => {
    expect((await writeAs(FULL, invoiceWith({ journal_entry_id: null }))).ok).toBe(false);
    expect((await writeAs(FULL, invoiceWith({ journal_entry_id: 'R9BL-OTHER-ENTRY' }))).ok).toBe(false);
  });

  // المدقق المستقل R11-B1-3: صافي فاتورة الشراء المرحّلة وضريبتها لا تتغيّر في القاعدة إلا بقيدٍ جديد لها في السحابة (postedPurchaseKept)
  test('«كامل» المشتريات لا يغيّر مبالغ فاتورة شراءٍ مرحّلة بلا قيدها الجديد، ويحصّلها (R11-B1-3)', async () => {
    const { savePurchase } = await import('@/domain/purchases');
    const PUR: Access = { owner: false, uid: 'R9BL-PUR', perms: { purchases: 3 }, allProps: true, props: [] };
    await addMember(PUR.uid!, PUR);
    const pid = savePurchase(db, {
      date: '2026-04-10', due: '2026-05-10', incorpItem: '', amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false,
      unitId: null, propertyId: null, meterId: null, meterReading: null, supplier: 'مورد مصطنع', category: 'صيانة',
      subtotalHalalas: 100_000, taxHalalas: 15_000, totalHalalas: 115_000,
    } as never);
    const je = db.get<{ j: string }>(`SELECT journal_entry_id AS j FROM purchases WHERE id = ?`, [pid])!.j;
    const own = [buildDoc(db, 'journal_entries', je, 'upsert', now(), 'DEV-OWNER'), buildDoc(db, 'purchases', pid, 'upsert', now(), 'DEV-OWNER')]
      .map((x) => { const { doc, pub } = annotate(db, x, OWNER_ACCESS); return pub ? { ...doc, companions: [pub] } : doc; });
    expect((await remoteFor(ORG, null).write(own)).every((r) => r.ok)).toBe(true);
    const cur = buildDoc(db, 'purchases', pid, 'upsert', now(), 'DEV-P');
    const forged = { ...cur, d: { ...cur.d!, subtotal_halalas: 10_000_000, tax_halalas: 1_500_000, total_halalas: 11_500_000 } };
    expect((await writeAs(PUR, forged)).ok).toBe(false);
    // ولا بقيدٍ ليس في السحابة
    expect((await writeAs(PUR, { ...forged, d: { ...forged.d, journal_entry_id: 'R9BL-NO-ENTRY' } })).ok).toBe(false);
    // والسداد لا يمسّها فيُقبل
    expect((await writeAs(PUR, { ...cur, d: { ...cur.d!, paid: 1, paid_date: '2026-04-20', payment_method: 'نقداً' } })).ok).toBe(true);
  });

  test('صفّ المنشأة: «كامل» المنشأة يعدّل اسمه، ولا يحذفه، ولا ينشئه عضوٌ في منشأةٍ لم يرفعه مالكها', async () => {
    const base = buildDoc(db, 'company', '1', 'upsert', now(), 'DEV-CO');
    expect((await writeAs(CO, { ...base, d: { ...base.d!, name: 'منشأة مصطنعة معدّلة' } })).ok).toBe(true);
    const tomb: RemoteDoc = { id: 'company__1', t: 'company', k: '1', u: now(), dev: 'DEV-CO', del: true, d: null, dby: CO.uid! };
    expect((await writeAs(CO, tomb)).ok).toBe(false);
    // منشأةٌ ثانية بلا صفّ منشأةٍ في السحابة: العضو لا ينشئه بتسجيله هو
    const ORG2 = 'OWNER-R9BL2';
    await addMember(CO.uid!, CO, ORG2);
    const [res] = await remoteFor(CO.uid!, CO, ORG2).write([annotate(db, { ...base, d: { ...base.d!, vat_enabled: 0 } }, CO).doc]);
    expect(res.ok).toBe(false);
    // والعضو نفسه ينشئ في المنشأة الثانية ما يملكه قسمه غير صفّها (ضابط: الرفض للصفّ لا للعضوية)
    const script = { id: 'message_scripts__R9BL', t: 'message_scripts', k: 'R9BL', u: now(), dev: 'DEV-CO', del: false,
      d: { id: 'R9BL', audience: 'مستأجر', category: 'عام', title: 'نص مصطنع', body: 'نص رسالة مصطنعة', created_at: now() } } as RemoteDoc;
    const [ok] = await remoteFor(CO.uid!, CO, ORG2).write([annotate(db, script, CO).doc]);
    expect(ok.ok).toBe(true);
  });
});
