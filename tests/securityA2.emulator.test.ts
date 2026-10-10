/**
 * نتائج المتحقق المستقل على «ثالثاً أ» (1fe4557 · القاعدتان ٣٥ و٩٨) على محاكي Firestore · كل صيغةٍ وجدها تُثبت هنا: سلبيٌّ يرفضها
 * بالمنطق (لا بنفاد حدّ الألف تعبير) وإيجابيٌّ يثبت أن الطريق المشروع يعمل · بيانات مصطنعة.
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/securityA2.emulator.test.ts"
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import { OWNER_ACCESS, type Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'SECA2-OWNER';
const d = HOST ? describe : describe.skip;

function token(uid: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email: uid.toLowerCase() + '@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const member = (uid: string, perms: Access['perms'], props: string[] | 'all'): Access =>
  ({ owner: false, uid, perms, allProps: props === 'all', props: props === 'all' ? [] : props });
function remoteFor(a: Access | null, sv: number | null = null): FirestoreRemote {
  const uid = a ? a.uid! : ORG;
  return new FirestoreRemote({
    projectId: PROJECT, uid, org: ORG, idToken: async () => token(uid), baseUrl: 'http://' + HOST,
    memberTokens: () => (a ? memberTokens(a) : null),
    fullReadTables: () => (a ? fullReadTables(a, SYNC_TABLES.map((t) => t.name)) : new Set()),
    access: () => a ?? OWNER_ACCESS,
    sv: () => sv,
  });
}
async function putDoc(path: string, data: Record<string, unknown>, uid: string): Promise<number> {
  const res = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) },
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  return res.status;
}
type W = { ok: boolean; code?: string; message?: string };
/**
 * رفضٌ بالمنطق: المحاكي يقيّم القاعدة أكثر من مرة في الطلب، فيُشترط أن يكون في الرفض تقييمٌ اكتمل إلى «false»، لا نفادُ حدّ
 * الألف تعبير وحده (فلا ينقلب قبولاً إن خفّت القواعد)
 */
const deniedByLogic = (r: W) => { expect(r).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' }); expect(String(r.message)).toMatch(/false for '(create|update)'/); };
const accepted = (r: W) => { if (!r.ok) throw new Error('rejected: ' + String(r.message).slice(0, 700)); };

d('نتائج المتحقق على «ثالثاً أ»', () => {
  const COL = member('S2-COL', { collect: 2, contracts: 1, props: 1 }, ['P1']);
  const COLALL = member('S2-COLALL', { collect: 2, contracts: 1, props: 1 }, 'all');
  const LED = member('S2-LED', { ledger: 3, props: 1 }, 'all');
  const PRO = member('S2-PRO', { props: 3 }, ['P1']);
  const INV = member('S2-INV', { invoices: 2, props: 1 }, ['P1']);
  const TEN = member('S2-TEN', { tenants: 2, contracts: 1, props: 1 }, 'all');
  const TEN1 = member('S2-TEN1', { tenants: 2, contracts: 1, props: 1 }, ['P1']);
  const HAND = member('S2-HAND', { handover: 2, contracts: 1, props: 1 }, ['P1']);
  const LIBM = member('S2-LIB', { library: 2 }, ['P1']);
  const TEN3 = member('S2-TEN3', { tenants: 3, props: 1 }, ['P1']);
  let db: import('@/db/adapter').DB;
  let C1 = '';
  const pays: string[] = [];

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract, recordRentPayment } = await import('@/domain/contracts/service');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    db = memDb();
    const p1 = addProperty(db, { id: 'P1', name: 'عقار أول مصطنع' });
    addProperty(db, { id: 'P2', name: 'عقار ثانٍ مصطنع' });
    C1 = confirmContract(db, contractInput(addUnit(db, p1, { id: 'UN1' }), { tenant: 'مستأجر مصطنع', idNumber: '1000000033', phone: '0500000011' }));
    confirmContract(db, contractInput(addUnit(db, 'P2', { id: 'UN2' }), { tenant: 'مستأجر مصطنع', idNumber: '1000000033', phone: '0500000011' }));
    const inst = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 3`, [C1]);
    for (const [i, it] of inst.entries()) {
      recordRentPayment(db, C1, { installmentId: it.id, period: 'الدفعة ' + (i + 1), date: '2026-01-0' + (i + 5), lines: [{ method: 'cash', amountHalalas: 1000 }], discountHalalas: 0, notes: '' });
    }
    pays.push(...db.all<{ id: string }>(`SELECT id FROM journal_entries WHERE status = 'مرحّل' AND src_type = 'rent' ORDER BY date`).map((x) => x.id));
    enableSync(db, ORG);
    expect((await syncOnce(db, remoteFor(null), 'dev-owner')).pending).toBe(0);
    for (const a of [COL, COLALL, LED, PRO, INV, TEN, TEN1, HAND, LIBM, TEN3]) {
      expect(await putDoc(`orgs/${ORG}/members/${a.uid}`, {
        email: a.uid!.toLowerCase() + '@example.test', perm: a.perms, all: a.allProps, props: a.props, tokens: memberTokens(a),
      }, ORG)).toBe(200);
    }
  });

  const write = async (a: Access | null, doc: RemoteDoc, sv: number | null = null) => (await remoteFor(a, sv).write([doc]))[0] as W;
  const ann = (a: Access | null, doc: RemoteDoc) => annotate(db, doc, a ?? OWNER_ACCESS).doc;
  const built = async (t: string, k: string) => (await import('@/sync/engine')).buildDoc(db, t, k, 'upsert', new Date().toISOString(), 'dev-x');

  test('٢ رموز الصف الجديد: عقاراتٌ مكررة أو معها «*» لا تتخطى الفحص · والصف المعتاد يُقبل', async () => {
    // نسخةٌ من قيد إيجارٍ مرحّل بمفتاحٍ جديد (معرّفه وسطوره له)
    const src = await built('journal_entries', pays[0]);
    const base = ann(COL, { ...src, k: 'S2E1', id: 'journal_entries__S2E1', u: 'a', d: { ...src.d!, id: 'S2E1' },
      lines: (src.lines ?? []).map((l, i) => ({ ...l, id: 'S2E1' + i, entry_id: 'S2E1' })) });
    const forged = [...base.g!, 'ledger|P2', 'collect|P2'];
    deniedByLogic(await write(COL, { ...base, pids: ['P1', '*'], g: forged }));
    deniedByLogic(await write(COL, { ...base, pids: ['P1', 'P1'], g: forged }));
    accepted(await write(COL, base));
  });

  test('٢ إحياء شاهد الحذف برموز عقارٍ آخر يُرفض · وبرموزه يُقبل', async () => {
    const unit: RemoteDoc = ann(PRO, { id: 'units__UZ', t: 'units', k: 'UZ', u: '1', dev: 'dev-p', del: false,
      d: { id: 'UZ', property_id: 'P1', name: 'وحدة مصطنعة', type: 'شقة', created_at: '2026-01-01' } });
    accepted(await write(PRO, unit));
    accepted(await write(PRO, { ...unit, u: '2', del: true, d: null }));
    deniedByLogic(await write(PRO, { ...unit, u: '3', g: [...unit.g!, 'ledger|P2', 'collect|P2'] }));
    accepted(await write(PRO, { ...unit, u: '4' }));
  });

  test('٣ عكسٌ مسودةٌ بلا سطور لا يُلغي القيد المرحّل · والعكس المرحّل الحقيقي يُقبل', async () => {
    const orig = await built('journal_entries', pays[1]);
    const fake: RemoteDoc = ann(LED, { id: 'journal_entries__S2FAKE', t: 'journal_entries', k: 'S2FAKE', u: 'f', dev: 'dev-l', del: false,
      d: { id: 'S2FAKE', no: 'JE-S2F', date: '2026-02-01', memo: 'عكس مصطنع', status: 'قيد الإنشاء', auto: 0, created_at: '2026-02-01',
        src_type: 'rent_rev', src_id: orig.d!.src_id }, lines: [] });
    accepted(await write(LED, fake));
    deniedByLogic(await write(LED, ann(LED, { ...orig, u: 'l1', d: { ...orig.d!, reversed_by: 'S2FAKE' } })));
  });

  test('٣ القيد اليدوي (مصدره فارغ) يُربط بعكسه · من المالك', async () => {
    const { postEntry, reverseEntryById } = await import('@/domain/accounting/post');
    const e = postEntry(db, { date: '2026-02-02', memo: 'قيد يدوي مصطنع', lines: [{ account: '1100', debit: 700, credit: 0 }, { account: '3100', debit: 0, credit: 700 }] })!;
    accepted(await write(null, ann(null, await built('journal_entries', e.id))));
    const rev = reverseEntryById(db, e.id, 'عكس يدوي مصطنع')!;
    accepted(await write(null, ann(null, await built('journal_entries', rev.id))));
    accepted(await write(null, ann(null, await built('journal_entries', e.id))));
  });

  test('٣ و٥ المحصّل يربط القيد بعكسٍ رفعه المالك · بلا sv ومعه (القيد القديم بلا مجموعين)', async () => {
    const { reverseEntryById } = await import('@/domain/accounting/post');
    const { SCHEMA_VERSION } = await import('@/db/schema');
    for (const [a, i, sv] of [[COL, 2, null], [COLALL, 0, SCHEMA_VERSION]] as const) {
      const rev = reverseEntryById(db, pays[i], 'عكس مصطنع ' + i)!;
      accepted(await write(null, ann(null, await built('journal_entries', rev.id))));
      const linkDoc = ann(a, await built('journal_entries', pays[i]));
      const r = await write(a, linkDoc, sv);
      if (!r.ok) throw new Error(a.uid + ' op=' + linkDoc.op + ' g=' + JSON.stringify(linkDoc.g) + ' pids=' + JSON.stringify(linkDoc.pids) + ' by=' + linkDoc.by + ' ' + String(r.message).slice(0, 400));
    }
  });

  test('٤ عضو الدفتر لا يغيّر مصدر مسودته إلى «إيجار» ولا يرحّلها به · وتعديلها المعتاد يُقبل', async () => {
    const draft: RemoteDoc = ann(LED, { id: 'journal_entries__S2D', t: 'journal_entries', k: 'S2D', u: 'd1', dev: 'dev-l', del: false, by: LED.uid!,
      d: { id: 'S2D', no: 'JE-S2D', date: '2026-02-03', memo: 'مسودة مصطنعة', status: 'قيد الإنشاء', auto: 0, created_at: '2026-02-03', src_type: null, src_id: null },
      lines: [{ id: 'S2Da', entry_id: 'S2D', account_code: '1100', descr: '', debit_halalas: 100, credit_halalas: 0 },
        { id: 'S2Db', entry_id: 'S2D', account_code: '3100', descr: '', debit_halalas: 0, credit_halalas: 100 }] });
    accepted(await write(LED, draft));
    deniedByLogic(await write(LED, { ...draft, u: 'd2', d: { ...draft.d!, src_type: 'rent', src_id: 'X' } }));
    deniedByLogic(await write(LED, { ...draft, u: 'd3', d: { ...draft.d!, src_type: 'rent', src_id: 'X', status: 'مرحّل' } }));
    accepted(await write(LED, { ...draft, u: 'd4', d: { ...draft.d!, memo: 'مسودة معدلة' } }));
  });

  test('٦ الفاتورة بإسقاطها (~pub) كأصلها: عضو الإدخال يحفظ المسودة وحدها', async () => {
    const inv = (status: string, k: string): RemoteDoc => ({ id: 'invoices~pub__' + k, t: 'invoices~pub', k, u: 'i', dev: 'dev-i', del: false,
      pids: ['P1'], g: ['invoices|P1', 'invoices|@'], op: 'invoices', by: INV.uid!,
      d: { id: k, no: 'INV-' + k, issue: '2026-02-04', status, property_id: 'P1', created_at: '2026-02-04' } });
    deniedByLogic(await write(INV, inv('مستحقة', 'S2I1')));
    accepted(await write(INV, inv('مسودة', 'S2I2')));
  });

  // الجولة الثانية للمتحقق (61cfcd4)
  const att = (k: string, d: Record<string, unknown>, pids: string[], g: string[], op: string, by: string): RemoteDoc => ({
    id: 'attachments__' + k, t: 'attachments', k, u: 'a', dev: 'dev-a', del: false, pids, g, op, by,
    d: { id: k, sha256: 'a'.repeat(64), kind: 'صورة', original_name: 'x.jpg', mime: 'image/jpeg', created_at: '2026-02-05', ...d } });

  // ورموز ملف المرفق تُحصر في قواعد التخزين (storageTokens.emulator: الجولة ٢) لا في صفّه هنا: كلفته على كل كتابة عضو

  test('٢ (الجولة ٢) مرفق المستأجر بعقاريه يُقبل · وصفّ المستأجر برموز عقارٍ آخر يُرفض', async () => {
    const tenantId = db.get<{ id: string }>(`SELECT id FROM tenants LIMIT 1`)!.id;
    const ta = ann(TEN, att('S2T1', { entity_type: 'tenant', entity_id: tenantId }, ['P1'], [], 'tenants', TEN.uid!));
    expect(ta.pids).toEqual(['P1', 'P2']);
    accepted(await write(TEN, ta));
    const tdoc = annotate(db, await built('tenants', tenantId), TEN1);
    const pubDoc = tdoc.pub!;
    deniedByLogic(await write(TEN1, { ...tdoc.doc, k: 'S2TN', id: 'tenants__S2TN', u: 't1', pids: ['P1'], g: [...tdoc.doc.g!, 'contracts|P2', 'collect|P2'], d: { ...tdoc.doc.d!, id: 'S2TN' } }));
    deniedByLogic(await write(TEN1, { ...pubDoc, k: 'S2TN', id: 'tenants~pub__S2TN', u: 't2', pids: ['P1'], g: ['tenants|P1', 'contracts|P2', 'collect|P2'], d: { ...pubDoc.d!, id: 'S2TN' } }));
    accepted(await write(TEN1, { ...pubDoc, k: 'S2TN', id: 'tenants~pub__S2TN', u: 't3', pids: ['P1'], g: ['tenants|@', 'tenants|P1'], d: { ...pubDoc.d!, id: 'S2TN' } }));
  });

  test('الجولة ٣ للمتحقق: صفّ blobs من أعضاء الأقسام غير المالية يُقبل (كان يبلغ حدّ الألف تعبير)', async () => {
    for (const [a, i] of [[PRO, 1], [TEN3, 2], [HAND, 3], [LIBM, 4]] as const) {
      const sha = String(i).repeat(64);
      const blob = ann(a, { id: 'blobs__' + sha, t: 'blobs', k: sha, u: 'b', dev: 'dev-b', del: false,
        d: { sha256: sha, ext: 'pdf', size_bytes: 1, created_at: '2026-02-06T00:00:00.000Z' } });
      const r = await write(a, blob);
      if (!r.ok) throw new Error(a.uid + ' ' + String(r.message).slice(0, 300));
    }
  });
});
