/**
 * المراجعة الخارجية ٧ «ثالثاً» (قرار المالك 2026-10-10): ما أغلقه العمل بعد 1fe4557 يُثبت باختبارٍ سلبي يعيد هجوم المراجعة،
 * والرقم في اسم الاختبار رقم النتيجة في docs/مراجعة/مراجعة-خارجية-٧.md · كلٌّ يفشل على 1fe4557 وينجح الآن · بيانات مصطنعة.
 * وما بقي مفتوحاً من النتيجة نفسها مذكورٌ في تعليقه (لا يُختبر هنا قبولاً).
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/review7.emulator.test.ts"
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import { OWNER_ACCESS, type Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'R7-OWNER';
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
/** رفضٌ بالمنطق لا بنفاد حدّ الألف تعبير (securityA2.emulator) */
// بعمليته نفسها: المحاكي يذكر قاعدتي الإنشاء والتعديل لكل كتابة، وقاعدة الإنشاء «false» على كل مستندٍ قائم، فـ«false» لأيهما لا
// يثبت رفض التعديل بالمنطق (المتحقق المستقل على «ثالثاً» المراجعة ٧)
const deniedByLogic = (r: W, op: 'create' | 'update') => {
  expect(r).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  expect(String(r.message)).toMatch(new RegExp("false for '" + op + "'"));
};
const accepted = (r: W) => { if (!r.ok) throw new Error('rejected: ' + String(r.message).slice(0, 700)); };

d('المراجعة ٧ «ثالثاً»: ما أُغلق بعد 1fe4557 بهجوم المراجعة نفسه', () => {
  const LED = member('R7-LED', { ledger: 3, props: 1 }, 'all');
  const COLALL = member('R7-COLALL', { collect: 2, contracts: 1, props: 1 }, 'all');
  const CONALL = member('R7-CONALL', { contracts: 3, props: 1 }, 'all');
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
    C1 = confirmContract(db, contractInput(addUnit(db, p1, { id: 'UN1' }), { tenant: 'مستأجر مصطنع', idNumber: '1000000044', phone: '0500000044' }));
    addUnit(db, 'P2', { id: 'UN2' });
    const inst = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 3`, [C1]);
    for (const [i, it] of inst.entries()) {
      recordRentPayment(db, C1, { installmentId: it.id, period: 'الدفعة ' + (i + 1), date: '2026-01-0' + (i + 5), lines: [{ method: 'cash', amountHalalas: 1000 }], discountHalalas: 0, notes: '' });
    }
    pays.push(...db.all<{ id: string }>(`SELECT id FROM journal_entries WHERE status = 'مرحّل' AND src_type = 'rent' ORDER BY date`).map((x) => x.id));
    enableSync(db, ORG);
    expect((await syncOnce(db, remoteFor(null), 'dev-owner')).pending).toBe(0);
    // جهاز العضو يعلّم ما وصله من السحابة «بلا كاتب» (sync/engine.ts: stageInbox · الهجرة ٤٢)، والوثائق هنا تُبنى من قاعدة المالك
    db.exec((await import('@/db/schema')).MIGRATION_42);
    for (const a of [LED, COLALL, CONALL]) {
      expect(await putDoc(`orgs/${ORG}/members/${a.uid}`, {
        email: a.uid!.toLowerCase() + '@example.test', perm: a.perms, all: a.allProps, props: a.props, tokens: memberTokens(a),
      }, ORG)).toBe(200);
    }
  });

  const write = async (a: Access | null, doc: RemoteDoc, sv: number | null = null) => (await remoteFor(a, sv).write([doc]))[0] as W;
  const ann = (a: Access | null, doc: RemoteDoc) => annotate(db, doc, a ?? OWNER_ACCESS).doc;
  const built = async (t: string, k: string) => (await import('@/sync/engine')).buildDoc(db, t, k, 'upsert', new Date().toISOString(), 'dev-x');
  /** عكسٌ مرحّل مزوّر لقيدٍ أصلي: مصدره «_rev» نفسه وسطوره بعددٍ ومبلغٍ يختارهما المهاجم */
  const fakeReversal = (k: string, orig: RemoteDoc, n: number, halalas: number): RemoteDoc => ann(LED, {
    id: 'journal_entries__' + k, t: 'journal_entries', k, u: 'f', dev: 'dev-l', del: false, by: LED.uid!,
    d: { id: k, no: 'JE-' + k, date: '2026-02-01', memo: 'عكس مزوّر مصطنع', status: 'مرحّل', auto: 0, created_at: '2026-02-01',
      src_type: 'rent_rev', src_id: orig.d!.src_id },
    lines: Array.from({ length: n }, (_, i) => ({ id: k + i, entry_id: k, account_code: i % 2 ? '4100' : '1100', descr: '',
      debit_halalas: i % 2 ? halalas : 0, credit_halalas: i % 2 ? 0 : halalas })) });

  /*
   * النتيجة ١ (جزؤها في القواعد · 61cfcd4 و356a528): العكس الوهمي لا يُلغي القيد المرحّل إلا بمرآةٍ مرحّلة بعدد سطوره ومجموعه ·
   * وعلى 1fe4557 كان يكفي مصدر «_rev» ومعرّف المصدر · والباقي من النتيجة مفتوح: «by» اختياري وقيد العضو المرحّل وإعادة اشتقاق
   * السطور على جهاز المالك (قرار «رابعاً ١» الآن) · ومطابقة السطور سطراً بسطر في القواعد مؤجلة إلى «ج١» بقرار المالك 2026-10-10
   */
  /** المحصّل يربط القيد بعكسه (طريق الربط المعتاد · securityA2 «٣ و٥») · والرفض لهذا وحده لا لغيره: الربط بالعكس الحقيقي يُقبل بعده */
  const linkTo = async (i: number, revId: string, u: string, sv: number | null) =>
    write(COLALL, ann(COLALL, { ...(await built('journal_entries', pays[i])), u, d: { ...(await built('journal_entries', pays[i])).d!, reversed_by: revId } }), sv);
  const realReversal = async (i: number) => {
    const { reverseEntryById } = await import('@/domain/accounting/post');
    const rev = reverseEntryById(db, pays[i], 'عكس مصطنع ' + i)!;
    accepted(await write(null, ann(null, await built('journal_entries', rev.id))));
    return rev.id;
  };

  test('١ (ب) عكسٌ مرحّل بعدد سطورٍ غير عدد الأصل لا يُربط به القيد · والعكس الحقيقي يُربط', async () => {
    const orig = await built('journal_entries', pays[0]);
    const n = (orig.lines ?? []).length;
    accepted(await write(LED, fakeReversal('R7FR1', orig, n + 1 + (n % 2), 1)));
    deniedByLogic(await linkTo(0, 'R7FR1', 'l1', null), 'update');
    accepted(await linkTo(0, await realReversal(0), 'l1b', null));
  });

  test('١ (ب) عكسٌ مرحّل بعدد سطور الأصل ومجموعٍ غير مجموعه (مع sv) لا يُربط به القيد · والعكس الحقيقي يُربط', async () => {
    const { SCHEMA_VERSION } = await import('@/db/schema');
    const orig = await built('journal_entries', pays[2]);
    const n = (orig.lines ?? []).length;
    accepted(await write(LED, fakeReversal('R7FR2', orig, n, 1), SCHEMA_VERSION));
    deniedByLogic(await linkTo(2, 'R7FR2', 'l2', SCHEMA_VERSION), 'update');
    accepted(await linkTo(2, await realReversal(2), 'l2b', SCHEMA_VERSION));
  });

  /*
   * النتيجة ٢٠ (جزؤها المغلق · 61cfcd4 و356a528): تغيير عقار الصف يشترط رموزاً لعقاره الجديد · وربط العكس لا يغيّر عقارات القيد
   * ولا رموزه · والباقي مفتوح: ربط الرموز بأقسام قراءة الجدول عند الإنشاء (g ['maintenance|P1'] على عقدٍ يُقبل) وg فارغة،
   * وعقارات صفّ المرفق لعضوٍ بكل العقارات
   */
  /*
   * النتيجة ١ (أ) و(ج) · قرار المالك «رابعاً ١ (أ)»: «by إلزامي على كل كتابة عضو» و«القيد اليدوي من العضو مسودة حتى يرحّله
   * المالك» · وفي قائمة القبول (ج): «عضو contracts: إدخال ينشئ journal_entries مرحّلاً بلا by فيُرفض، وبـby ومسودة فيُقبل»
   */
  test('١ (ج) قيدٌ من عضو بلا كاتب أو بكاتبٍ غيره يُرفض · وبكاتبه يُقبل', async () => {
    const src = await built('journal_entries', pays[2]);
    const copy = (k: string): RemoteDoc => ann(COLALL, { ...src, k, id: 'journal_entries__' + k, u: 'b', d: { ...src.d!, id: k, no: 'JE-' + k },
      lines: (src.lines ?? []).map((l, i) => ({ ...l, id: k + i, entry_id: k })) });
    const own = copy('R7BY1');
    expect(own.by).toBe(COLALL.uid);
    const { by: _drop, ...noBy } = own;
    deniedByLogic(await write(COLALL, noBy as RemoteDoc), 'create');
    deniedByLogic(await write(COLALL, { ...own, by: LED.uid! }), 'create');
    accepted(await write(COLALL, own));
  });

  test('١ (أ) القيد اليدوي من عضو الدفتر مرحّلاً يُرفض · ومسودةً بكاتبه تُقبل · ولا يرحّلها هو بعدها', async () => {
    const manual = (k: string, status: string): RemoteDoc => ann(LED, { id: 'journal_entries__' + k, t: 'journal_entries', k, u: 'm', dev: 'dev-l', del: false,
      d: { id: k, no: 'JE-' + k, date: '2026-02-05', memo: 'قيد يدوي مصطنع', status, auto: 0, created_at: '2026-02-05', src_type: null, src_id: null },
      lines: [{ id: k + 'a', entry_id: k, account_code: '1100', descr: '', debit_halalas: 500, credit_halalas: 0 },
        { id: k + 'b', entry_id: k, account_code: '3100', descr: '', debit_halalas: 0, credit_halalas: 500 }] });
    deniedByLogic(await write(LED, manual('R7MN1', 'مرحّل')), 'create');
    const draft = manual('R7MN2', 'قيد الإنشاء');
    expect(draft.by).toBe(LED.uid);
    accepted(await write(LED, draft));
    deniedByLogic(await write(LED, { ...draft, u: 'm2', d: { ...draft.d!, status: 'مرحّل' } }), 'update');
    // والمالك يرحّلها
    accepted(await write(null, { ...draft, u: 'm3', d: { ...draft.d!, status: 'مرحّل' } }));
  });

  /*
   * المتحقق المستقل (الجولة العاشرة): «by» الإلزامي لا يكسر تعديل العضو صفّه بعد أن عدّله المالك، ولا تعديلاً أرسله قبل الهجرة ٤٢
   * لصفٍّ رُفع بلا كاتب · ولا يدّعي العضو مسودةَ غيره
   */
  test('١ تعديل المالك يُبقي كاتب صفّ العضو · والعضو يضيف كاتبه لصفٍّ بلا كاتب · ولا يدّعي مسودة غيره', async () => {
    const unit: RemoteDoc = ann(CONALL, { id: 'units__R7U', t: 'units', k: 'R7U', u: 'u1', dev: 'dev-c', del: false,
      d: { id: 'R7U', property_id: 'P2', name: 'وحدة مصطنعة', type: 'شقة', created_at: '2026-02-01' } });
    // وحدةٌ أنشأها العضو (بكاتبه) ثم عدّلها المالك، فكاتبها عنده من الوارد
    const PRO1 = member('R7-PRO1', { props: 3, contracts: 1 }, 'all');
    expect(await putDoc(`orgs/${ORG}/members/${PRO1.uid}`, { email: 'r7-pro1@example.test', perm: PRO1.perms, all: true, props: [], tokens: memberTokens(PRO1) }, ORG)).toBe(200);
    const mine = ann(PRO1, { ...unit, u: 'u1' });
    expect(mine.by).toBe(PRO1.uid);
    accepted(await write(PRO1, mine));
    db.run(`INSERT OR IGNORE INTO row_by (tbl, pk, uid) VALUES ('units', 'R7U', ?)`, [PRO1.uid!]);
    db.run(`INSERT INTO units (id, property_id, unit_no, created_at) VALUES ('R7U', 'P2', 'R7U', '2026-02-01')`);
    const ownerEdit = ann(null, await built('units', 'R7U'));
    expect(ownerEdit.by).toBe(PRO1.uid);
    accepted(await write(null, { ...ownerEdit, u: 'u2' }));
    accepted(await write(PRO1, ann(PRO1, { ...(await built('units', 'R7U')), u: 'u3' })));
    // صفٌّ رُفع بلا كاتب (من المالك): العضو يضيف كاتبه، ولا يضيف كاتب غيره
    const ownerUnit = ann(PRO1, await built('units', 'UN2'));
    expect(ownerUnit.by).toBeUndefined();
    accepted(await write(PRO1, { ...ownerUnit, u: 'u4', by: PRO1.uid! }));
    deniedByLogic(await write(PRO1, { ...ownerUnit, u: 'u5', by: LED.uid! }), 'update');
    // ومسودة غيره (بلا كاتب) لا يدّعيها: مسودة عقدٍ أنشأها المالك
    db.run(`UPDATE contracts SET status = status WHERE id = ?`, [C1]);
    const draft = ann(CONALL, await built('contracts', C1));
    deniedByLogic(await write(CONALL, { ...draft, u: 'u6', by: CONALL.uid! }), 'update');
  });

  test('٢٠ نقل العقد إلى عقارٍ آخر برموز العقار القديم يُرفض · وبرموز عقاره الجديد يُقبل', async () => {
    const doc = ann(CONALL, await built('contracts', C1));
    const honest = doc.g!.map((x) => x.replace('|P1', '|P2'));
    const moved = { ...doc, d: { ...doc.d!, unit_id: 'UN2' }, pids: ['P2'] };
    deniedByLogic(await write(CONALL, { ...moved, u: 'mv1', g: [...honest, 'contracts|P1', 'maintenance|P1'] }), 'update');
    accepted(await write(CONALL, { ...moved, u: 'mv2', g: honest }));
    accepted(await write(CONALL, { ...doc, u: 'mv3' }));
  });

  test('٢٠ ربط القيد بعكسه لا ينقله إلى عقارٍ آخر ولا يغيّر رموزه · والربط المعتاد يُقبل', async () => {
    const { reverseEntryById } = await import('@/domain/accounting/post');
    const rev = reverseEntryById(db, pays[1], 'عكس مصطنع')!;
    accepted(await write(null, ann(null, await built('journal_entries', rev.id))));
    const link = ann(COLALL, await built('journal_entries', pays[1]));
    deniedByLogic(await write(COLALL, { ...link, u: 'lk1', pids: ['P2'], g: link.g!.map((x) => x.replace('|P1', '|P2')) }), 'update');
    accepted(await write(COLALL, link));
  });
});
