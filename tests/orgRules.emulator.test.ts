/**
 * قواعد المنشأة وصلاحيات الأقسام على محاكي Firestore (docs/PERMISSIONS.md) · بالعميل والمحرّك نفسيهما.
 * يعمل حين يكون المحاكي قائماً ويُتخطّى غير ذلك:
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/orgRules.emulator.test.ts" (‏-i: ملفات المحاكي تُمسح بياناته في أولها فلا تتوازى)
 * البيانات مصطنعة كلها.
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import type { Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'OWNER1';
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

/** الجداول التي يقرأ العضو مستندها الكامل · فيُهمل إسقاطها (كما يبنيها services/cloud.ts) */
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

d('قواعد المنشأة · صلاحيات الأقسام', () => {
  const COLLECTOR = member('U-COL', { collect: 2, contracts: 1, props: 1 }, ['P1']);
  const AGENT = member('U-AGT', { handover: 2, props: 1, tenants: 1 }, 'all');
  const DRAFTER = member('U-DRF', { contracts: 2, props: 1 }, 'all');
  let db: import('@/db/adapter').DB;
  let C1 = '', C2 = '', I1 = '';

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    db = memDb();
    const p1 = addProperty(db, { id: 'P1', name: 'عقار أول تجريبي' });
    const p2 = addProperty(db, { id: 'P2', name: 'عقار ثانٍ تجريبي' });
    const u1 = addUnit(db, p1, { id: 'UN1' });
    const u2 = addUnit(db, p2, { id: 'UN2' });
    C1 = confirmContract(db, contractInput(u1, { tenant: 'مستأجر أول تجريبي', idNumber: '1000000033', phone: '0500000011' }));
    C2 = confirmContract(db, contractInput(u2, { tenant: 'مستأجر ثانٍ تجريبي', idNumber: '1000000041', phone: '0500000012' }));
    I1 = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [C1])!.id;
    // المالك يرفع كل شيء إلى المنشأة
    enableSync(db, ORG);
    const r = await syncOnce(db, remoteFor(ORG, null), 'dev-owner');
    expect(r.pending).toBe(0);
    for (const a of [COLLECTOR, AGENT, DRAFTER]) {
      expect(await putDoc(`orgs/${ORG}/members/${a.uid}`, {
        email: a.uid!.toLowerCase() + '@example.test', perm: a.perms, all: a.allProps, props: a.props, tokens: memberTokens(a),
      }, ORG)).toBe(200);
    }
  });

  const pullAll = async (a: Access) => {
    const out: RemoteDoc[] = [];
    let cur = null;
    for (let i = 0; i < 20; i++) {
      const { docs, next } = await remoteFor(a.uid!, a).pull(cur, 300);
      out.push(...docs);
      cur = next;
      if (docs.length < 300) break;
    }
    return out;
  };

  test('المحصِّل يرى عقاره وحده وأقسامه وحدها', async () => {
    const docs = await pullAll(COLLECTOR);
    const ids = new Set(docs.map((x) => x.id));
    expect(ids.has('contracts__' + C1)).toBe(true);
    expect(ids.has('contracts__' + C2)).toBe(false); // عقار آخر
    expect(ids.has('properties__P2')).toBe(false);
    expect(docs.some((x) => x.t === 'audit_log')).toBe(false); // ليس له سجل العمليات
    expect(docs.some((x) => x.t === 'purchases')).toBe(false);
    // قيود التحصيل والتأمين ليست له: الدفتر والتقارير ليست من أقسامه، والتأمين ليس له
    expect(docs.filter((x) => x.t === 'journal_entries').every((x) => x.g!.includes('collect|P1'))).toBe(true);
  });

  test('المحصِّل بلا عضوية لا يقرأ شيئاً · والاستعلام الأوسع من رموزه يُرفض', async () => {
    const stranger = member('U-NONE', { collect: 3 }, 'all');
    await expect(remoteFor('U-NONE', stranger).pull(null, 50)).rejects.toThrow(/403|PERMISSION_DENIED/);
    // رموز ليست له (عقار آخر) · القواعد ترفض الاستعلام كله
    const forged = { ...COLLECTOR, props: ['P1', 'P2'] };
    await expect(remoteFor(COLLECTOR.uid!, forged).pull(null, 50)).rejects.toThrow(/403|PERMISSION_DENIED/);
  });

  test('مندوب الاستلام يرى العقد إسقاطاً بلا مبالغ', async () => {
    const docs = await pullAll(AGENT);
    const c = docs.find((x) => x.id === 'contracts__' + C1);
    expect(c).toBeTruthy();
    expect(c!.d!.tenant_name).toBe('مستأجر أول تجريبي');
    expect(Object.keys(c!.d!).some((k) => k.endsWith('_halalas'))).toBe(false);
    expect(docs.some((x) => x.t === 'contract_installments')).toBe(false);
    expect(docs.some((x) => x.t === 'contract_payments')).toBe(false);
  });

  const write = async (a: Access, doc: RemoteDoc) => (await remoteFor(a.uid!, a).write([annotate(db, doc, a).doc]))[0];

  test('إدخال ينشئ في قسمه ولا يعدّل · ولا يكتب في عقار ليس له', async () => {
    const pay: RemoteDoc = {
      id: 'contract_payments__PX1', t: 'contract_payments', k: 'PX1', u: 'x', dev: 'dev-col', del: false,
      d: { id: 'PX1', contract_id: C1, installment_id: I1, date: '2026-05-01', gross_halalas: 1000, discount_halalas: 0, net_halalas: 1000 },
    };
    expect(await write(COLLECTOR, pay)).toMatchObject({ ok: true });
    // التعديل بعد الحفظ يحتاج كاملاً
    expect(await write(COLLECTOR, { ...pay, u: 'y', d: { ...pay.d!, net_halalas: 900 } })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // عقار ليس له
    const other: RemoteDoc = { ...pay, id: 'contract_payments__PX2', k: 'PX2', d: { ...pay.d!, id: 'PX2', contract_id: C2 } };
    expect(await write(COLLECTOR, other)).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // قسم «عرض» فقط
    const unit: RemoteDoc = { id: 'units__UNX', t: 'units', k: 'UNX', u: 'x', dev: 'dev-col', del: false,
      d: { id: 'UNX', property_id: 'P1', unit_no: 'X-1' } };
    expect(await write(COLLECTOR, unit)).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('الحقول الجانبية بإدخال: مسدَّد القسط وحالته وحدهما', async () => {
    const inst = db.get<Record<string, unknown>>(`SELECT * FROM contract_installments WHERE id = ?`, [I1])!;
    const doc: RemoteDoc = { id: 'contract_installments__' + I1, t: 'contract_installments', k: I1, u: 'z', dev: 'dev-col', del: false, d: { ...inst, status: 'مدفوعة جزئياً' } as never };
    expect(await write(COLLECTOR, doc)).toMatchObject({ ok: true });
    expect(await write(COLLECTOR, { ...doc, u: 'z2', d: { ...doc.d!, amount_halalas: 1 } })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('مسودة كاتبها يعدّلها بإدخال · ومسودة غيره لا', async () => {
    db.run(`INSERT OR REPLACE INTO row_by (tbl, pk, uid) VALUES ('contracts','CD1','U-DRF')`);
    const draft: RemoteDoc = { id: 'contracts__CD1', t: 'contracts', k: 'CD1', u: 'a', dev: 'dev-drf', del: false,
      d: { id: 'CD1', tenant_name: 'مسودة تجريبية', unit_id: 'UN1', status: 'مسودة', value_halalas: 100 } };
    expect(await write(DRAFTER, draft)).toMatchObject({ ok: true });
    expect(await write(DRAFTER, { ...draft, u: 'b', d: { ...draft.d!, value_halalas: 200 } })).toMatchObject({ ok: true });
    // كاتب آخر بإدخال لا يمسّها
    const other = member('U-DRF2', { contracts: 2, props: 1 }, 'all');
    expect(await putDoc(`orgs/${ORG}/members/U-DRF2`, { email: 'u-drf2@example.test', perm: other.perms, all: true, props: [], tokens: memberTokens(other) }, ORG)).toBe(200);
    const doc = annotate(db, { ...draft, u: 'c', d: { ...draft.d!, value_halalas: 300 } }, other).doc;
    expect((await remoteFor('U-DRF2', other).write([doc]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // بعد خروجها من المسودة لا يعدّلها كاتبها بإدخال
    expect(await write(DRAFTER, { ...draft, u: 'd', d: { ...draft.d!, status: 'سارٍ' } })).toMatchObject({ ok: true });
    expect(await write(DRAFTER, { ...draft, u: 'e', d: { ...draft.d!, status: 'سارٍ', value_halalas: 1 } })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('الدعوة: العضو يقبلها بنصّها حرفياً وحده', async () => {
    const inv = { email: 'new-member@example.test', perm: { collect: 1 }, all: true, props: [], tokens: ['collect|@'] };
    expect(await putDoc(`orgs/${ORG}/invites/new-member@example.test`, inv, ORG)).toBe(200);
    const res = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/members/U-NEW`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token('U-NEW', 'new-member@example.test') },
      body: JSON.stringify({ fields: encodeFields({ ...inv, perm: { collect: 3 } }) }),
    });
    expect(res.status).toBe(403); // رفع صلاحيته بنفسه
    const ok = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/members/U-NEW`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token('U-NEW', 'new-member@example.test') },
      body: JSON.stringify({ fields: encodeFields(inv) }),
    });
    expect(ok.status).toBe(200);
    // غريبٌ بإيميل آخر لا يقبلها
    const bad = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/members/U-BAD`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token('U-BAD', 'bad@example.test') },
      body: JSON.stringify({ fields: encodeFields(inv) }),
    });
    expect(bad.status).toBe(403);
  });

  test('المستأجر المشترك بين عقارين: المحصور بعقار يراه بلا رصيده وملاحظاته · ويمسّ رصيده من عقاره', async () => {
    const { addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const { syncOnce } = await import('@/sync/engine');
    // المستأجر الأول نفسه بعقد ثانٍ في العقار الآخر
    confirmContract(db, contractInput(addUnit(db, 'P2', { id: 'UN3' }), { tenant: 'مستأجر أول تجريبي', idNumber: '1000000033', phone: '0500000011' }));
    const tid = db.get<{ tenant_id: string }>(`SELECT tenant_id FROM contracts WHERE id = ?`, [C1])!.tenant_id;
    db.run(`UPDATE tenants SET credit_halalas = 7000, notes = 'ملاحظة تخص العقار الآخر' WHERE id = ?`, [tid]);
    await syncOnce(db, remoteFor(ORG, null), 'dev-owner');
    const docs = await pullAll(COLLECTOR);
    const t = docs.find((x) => x.id === 'tenants__' + tid)!;
    expect(t).toBeTruthy();
    expect(t.d!.name).toBe('مستأجر أول تجريبي');
    expect('credit_halalas' in t.d!).toBe(false);
    expect('notes' in t.d!).toBe(false);
    // ذو كل العقارات وقسم مالي يرى الكامل
    const allCol = member('U-ALL', { collect: 1 }, 'all');
    expect(await putDoc(`orgs/${ORG}/members/U-ALL`, { email: 'u-all@example.test', perm: allCol.perms, all: true, props: [], tokens: memberTokens(allCol) }, ORG)).toBe(200);
    const full = (await pullAll(allCol)).find((x) => x.id === 'tenants__' + tid)!;
    expect(full.d!.credit_halalas).toBe(7000);
    // المحصِّل المحصور يزيد الرصيد (فائض دفعة) من عقاره
    const row = db.get<Record<string, unknown>>(`SELECT * FROM tenants WHERE id = ?`, [tid])!;
    expect(await write(COLLECTOR, { id: 'tenants__' + tid, t: 'tenants', k: tid, u: 'w1', dev: 'dev-col', del: false, d: { ...row, credit_halalas: 7500 } as never }))
      .toMatchObject({ ok: true });
    // ولا يغيّر اسمه (ليس له قسم المستأجرين)
    expect(await write(COLLECTOR, { id: 'tenants__' + tid, t: 'tenants', k: tid, u: 'w2', dev: 'dev-col', del: false, d: { ...row, credit_halalas: 7500, name: 'اسم آخر' } as never }))
      .toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('لا دعوة لإيميل المالك نفسه · في القواعد وفي الخدمة', async () => {
    const own = ORG.toLowerCase() + '@example.test'; // إيميل رمز المالك في token()
    expect(await putDoc(`orgs/${ORG}/invites/${own}`, { email: own, perm: { collect: 1 }, all: true, props: [], tokens: ['collect|@'], orgName: 'x' }, ORG)).toBe(403);
    const { sendInvite } = await import('@/services/org');
    await expect(sendInvite(remoteFor(ORG, null), ORG, { email: own, perms: { collect: 1 }, allProps: true, props: [] }, 'x', own))
      .rejects.toThrow(/إيميلك أنت/);
    // ولا لعضو قائم
    await expect(sendInvite(remoteFor(ORG, null), ORG, { email: 'u-col@example.test', perms: { collect: 1 }, allProps: true, props: [] }, 'x', own))
      .rejects.toThrow(/عضو في المنشأة/);
  });

  test('العضو لا يرى قائمة الأعضاء ولا الدعوات ولا يدعو أحداً', async () => {
    const r = remoteFor(COLLECTOR.uid!, COLLECTOR);
    await expect(r.listDocs(`orgs/${ORG}/members`)).rejects.toThrow(/403/);
    await expect(r.listDocs(`orgs/${ORG}/invites`)).rejects.toThrow(/403/);
    expect(await putDoc(`orgs/${ORG}/invites/someone@example.test`, { email: 'someone@example.test', perm: { collect: 1 }, all: true, props: [], tokens: ['collect|@'], orgName: 'x' }, COLLECTOR.uid!)).toBe(403);
  });

  test('العضو لا يعدّل مستند عضويته', async () => {
    expect(await putDoc(`orgs/${ORG}/members/${COLLECTOR.uid}`, { email: 'u-col@example.test', perm: { collect: 3 }, all: true, props: [], tokens: ['collect|@'] }, COLLECTOR.uid!)).toBe(403);
  });

  test('حروف الأجهزة: العضو يضيف حرفه ولا يغيّر حرفاً قائماً', async () => {
    const letter = await remoteFor(COLLECTOR.uid!, COLLECTOR).registerDevice('dev-col');
    expect(letter).toBeTruthy();
    expect(await putDoc(`orgs/${ORG}/meta/devices`, { letters: { 'dev-owner': 'Z', 'dev-col': letter } }, COLLECTOR.uid!)).toBe(403);
  });
});

d('بيانات العضو في القواعد (توجيه المالك ٢٠٢٦-١٠-٠٥)', () => {
  const VIEWER = member('U-VIEW', { props: 1 }, 'all');
  const OTHER = member('U-OTH', { props: 1 }, 'all');
  const base = (a: Access) => ({
    email: a.uid!.toLowerCase() + '@example.test', perm: a.perms, all: a.allProps, props: a.props, tokens: memberTokens(a),
    orgName: 'منشأة تجريبية', name: '', phone: '', nid: '', title: '',
  });
  beforeAll(async () => {
    for (const a of [VIEWER, OTHER]) expect(await putDoc(`orgs/${ORG}/members/${a.uid}`, base(a), ORG)).toBe(200);
  });

  test('العضو يكمل بياناته بنفسه', async () => {
    expect(await putDoc(`orgs/${ORG}/members/U-VIEW`, { ...base(VIEWER), name: 'عضو تجريبي', phone: '0500000101', nid: '1000000017', title: 'محاسب' }, 'U-VIEW')).toBe(200);
  });

  test('ولا يغيّر صلاحيته ولا يكتب صيغة خاطئة ولا يترك الإلزامي', async () => {
    const ok = { ...base(VIEWER), name: 'عضو تجريبي', phone: '0500000101', nid: '', title: '' };
    expect(await putDoc(`orgs/${ORG}/members/U-VIEW`, { ...ok, perm: { props: 3, ledger: 3 } }, 'U-VIEW')).toBe(403);
    expect(await putDoc(`orgs/${ORG}/members/U-VIEW`, { ...ok, phone: '0400000000' }, 'U-VIEW')).toBe(403);
    expect(await putDoc(`orgs/${ORG}/members/U-VIEW`, { ...ok, nid: '3000000000' }, 'U-VIEW')).toBe(403);
    expect(await putDoc(`orgs/${ORG}/members/U-VIEW`, { ...ok, name: '' }, 'U-VIEW')).toBe(403);
  });

  test('ولا يكتب مستند عضو غيره ولا يقرؤه', async () => {
    expect(await putDoc(`orgs/${ORG}/members/U-OTH`, { ...base(OTHER), name: 'متطفل', phone: '0500000102' }, 'U-VIEW')).toBe(403);
    const res = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/members/U-OTH`, { headers: { Authorization: 'Bearer ' + token('U-VIEW') } });
    expect(res.status).toBe(403);
  });

  test('المالك يملأ البيانات عند الدعوة بصيغة صحيحة وحدها', async () => {
    const inv = { ...base(OTHER), email: 'new@example.test' };
    expect(await putDoc(`orgs/${ORG}/invites/new@example.test`, { ...inv, name: 'مدعو تجريبي', phone: '0500000103' }, ORG)).toBe(200);
    expect(await putDoc(`orgs/${ORG}/invites/new@example.test`, { ...inv, nid: '12345' }, ORG)).toBe(403);
  });

  test('صفّ سجل العمليات لتعديل بياناته يُرفع بلا قسم إدخال · وغيره لا', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { logAudit } = await import('@/domain/audit');
    const { buildDoc } = await import('@/sync/engine');
    const mdb = memDb();
    const push = async (entity: string) => {
      logAudit(mdb, 'الأعضاء', 'update', entity, 'عضو تجريبي');
      const k = mdb.get<{ id: string }>(`SELECT id FROM audit_log ORDER BY rowid DESC LIMIT 1`)!.id;
      const doc = annotate(mdb, buildDoc(mdb, 'audit_log', k, 'upsert', new Date().toISOString(), 'dev-view'), VIEWER).doc;
      return (await remoteFor('U-VIEW', VIEWER).write([doc]))[0];
    };
    expect((await push('بيانات عضو')).ok).toBe(true);
    expect((await push('عقد')).ok).toBe(false);
  });
});

d('«هذا جهازي الأول» على الخادم', () => {
  test('الجهاز الثاني يرث الفراغ والأول القديم يأخذ حرفاً جديداً', async () => {
    const r = remoteFor(ORG, null);
    const first = await r.registerDevice('dev-first-x');
    const second = await r.registerDevice('dev-second-x');
    expect(second).not.toBe('');
    const prev = await r.claimFirstDevice('dev-second-x');
    expect(await r.registerDevice('dev-second-x')).toBe('');
    if (first === '') {
      expect(prev).toBe('dev-first-x');
      expect(await r.registerDevice('dev-first-x')).not.toBe('');
    }
    // العضو لا يغيّر حرفاً قائماً
    const a = member('U-VIEW', { props: 1 }, 'all');
    await expect(remoteFor('U-VIEW', a).claimFirstDevice('dev-x')).rejects.toBeTruthy();
  });
});
