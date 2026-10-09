/**
 * رحلة المنشأة كاملة على محاكي Firestore (docs/PERMISSIONS.md) بالمحرّك والخدمة نفسيهما:
 * انتقال المالك بلا فقد وبحروفه · الدعوة والقبول · سحب العضو ما يجيزه · دفعته تصل المالك ·
 * ما خرج عن صلاحيته يبقى عنده ولا يحبس الطابور · تعديل صلاحيته وإزالته.
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/orgFlow.emulator.test.ts"
 */
import { FirestoreRemote } from '@/cloud/firestore';
import type { DB } from '@/db/adapter';
import { memberTokens, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';
import { readAccess, readMembership } from '@/services/access';
import { moveOwnerToOrg, sendInvite, findInvites, acceptInvite, refreshMembership, updateMember, removeMember, updateMemberProfile } from '@/services/org';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const OWNER = 'OWNER-FLOW';
const MEMBER = 'MEMBER-FLOW';
const MEMBER_EMAIL = 'member-flow@example.test';
const d = HOST ? describe : describe.skip;

function token(uid: string, email: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const base = (uid: string, email: string) => ({ projectId: PROJECT, uid, idToken: async () => token(uid, email), baseUrl: 'http://' + HOST });
const tables = SYNC_TABLES.map((t) => t.name);
/** عميل الجهاز كما يبنيه services/cloud.ts (remoteOf) */
function deviceRemote(db: DB, uid: string, email: string): FirestoreRemote {
  const m = readMembership(db);
  if (m) {
    return new FirestoreRemote({ ...base(uid, email), org: m.org,
      memberTokens: () => memberTokens(readAccess(db)), fullReadTables: () => fullReadTables(readAccess(db), tables), access: () => readAccess(db) });
  }
  return new FirestoreRemote({ ...base(uid, email), org: uid, access: () => readAccess(db) });
}

d('رحلة المنشأة', () => {
  let owner: DB;
  let mem: DB;
  let C1 = '', C2 = '', I1 = '';

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  });

  test('المالك على المسار القديم ثم ينتقل إلى منشأته بلا فقد وبحروف أجهزته', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, addBank, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const { enableSync, syncOnce, getSyncState } = await import('@/sync/engine');
    owner = memDb();
    const p1 = addProperty(owner, { id: 'FP1', name: 'عقار الرحلة الأول' });
    const p2 = addProperty(owner, { id: 'FP2', name: 'عقار الرحلة الثاني' });
    addBank(owner, 'بنك الرحلة');
    C1 = confirmContract(owner, contractInput(addUnit(owner, p1, { id: 'FU1' }), { tenant: 'مستأجر رحلة أول', idNumber: '1000000058', phone: '0500000021' }));
    C2 = confirmContract(owner, contractInput(addUnit(owner, p2, { id: 'FU2' }), { tenant: 'مستأجر رحلة ثانٍ', idNumber: '1000000066', phone: '0500000022' }));
    I1 = owner.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [C1])!.id;
    // المسار القديم أولاً كما هو اليوم
    enableSync(owner, OWNER);
    const legacy = new FirestoreRemote(base(OWNER, 'owner@example.test'));
    await syncOnce(owner, legacy, 'dev-owner-1');
    void getSyncState;
    // الانتقال
    const orgR = new FirestoreRemote({ ...base(OWNER, 'owner@example.test'), org: OWNER });
    expect(await moveOwnerToOrg(owner, legacy, orgR, OWNER)).toBe(true);
    expect(await moveOwnerToOrg(owner, legacy, orgR, OWNER)).toBe(false); // مرة واحدة
    const r = await syncOnce(owner, deviceRemote(owner, OWNER, 'owner@example.test'), 'dev-owner-1');
    expect(r.pending).toBe(0);
    expect(r.pushed).toBeGreaterThan(10);
    // عدّاد الترقيم انتقل كما هو · فكتلة المنشأة الجديدة بعد كتلة المسار القديم لا فوقها
    const legacyCounters = await legacy.getDoc(`users/${OWNER}/meta/counters`);
    const orgCounters = await orgR.getDoc(`orgs/${OWNER}/meta/counters`);
    expect(Number(orgCounters!.JE)).toBeGreaterThanOrEqual(Number(legacyCounters!.JE));
  });

  test('الدعوة والقبول: العضو يرى عقاره وأقسامه وحدها', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { syncOnce } = await import('@/sync/engine');
    const orgR = new FirestoreRemote({ ...base(OWNER, 'owner@example.test'), org: OWNER });
    await sendInvite(orgR, OWNER, { email: MEMBER_EMAIL, perms: { collect: 2, contracts: 1, props: 1 }, allProps: false, props: ['FP1'] }, 'منشأة الرحلة', 'owner@example.test');
    mem = memDb();
    const plain = new FirestoreRemote(base(MEMBER, MEMBER_EMAIL));
    const inv = await findInvites(plain, MEMBER_EMAIL);
    expect(inv.map((x) => x.org)).toEqual([OWNER]);
    expect(inv[0].doc.orgName).toBe('منشأة الرحلة');
    await acceptInvite(mem, plain, OWNER, MEMBER, inv[0].doc);
    // ربط الجهاز كما يفعل bindMember
    const { setSyncState, setCapture } = await import('@/sync/engine');
    setSyncState(mem, 'uid', MEMBER);
    mem.run(`DELETE FROM sync_outbox`);
    setCapture(mem, true);
    expect(await findInvites(plain, MEMBER_EMAIL)).toEqual([]); // الدعوة استُهلكت
    const r = await syncOnce(mem, deviceRemote(mem, MEMBER, MEMBER_EMAIL), 'dev-member-1');
    expect(r.pulled).toBeGreaterThan(0);
    expect(mem.get(`SELECT id FROM contracts WHERE id = ?`, [C1])).toBeTruthy();
    expect(mem.get(`SELECT id FROM contracts WHERE id = ?`, [C2])).toBeUndefined();
    expect(mem.get(`SELECT id FROM properties WHERE id = 'FP2'`)).toBeUndefined();
    expect(Number(mem.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_installments WHERE contract_id = ?`, [C1])!.n)).toBeGreaterThan(0);
  });

  test('دفعة العضو تصل المالك · وما خرج عن صلاحيته يبقى عنده ولا يحبس الطابور', async () => {
    const { recordRentPayment } = await import('@/domain/contracts/service');
    const { syncOnce } = await import('@/sync/engine');
    recordRentPayment(mem, C1, { installmentId: I1, period: 'الأول', date: '2026-05-01', lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
    // كتابة لا يجيزها قسمٌ له (تعديل وحدة · «عرض» فقط)
    mem.run(`UPDATE units SET unit_no = 'معدّل محلياً' WHERE id = 'FU1'`);
    const r = await syncOnce(mem, deviceRemote(mem, MEMBER, MEMBER_EMAIL), 'dev-member-1');
    expect(r.pending).toBe(0);
    expect(Number(mem.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'units'`)!.n)).toBe(1);
    const back = await syncOnce(owner, deviceRemote(owner, OWNER, 'owner@example.test'), 'dev-owner-1');
    expect(back.applied).toBeGreaterThan(0);
    const pay = owner.get<{ net_halalas: number }>(`SELECT net_halalas FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL`, [C1]);
    expect(Number(pay!.net_halalas)).toBe(50000);
    expect(owner.get<{ unit_no: string }>(`SELECT unit_no FROM units WHERE id = 'FU1'`)!.unit_no).not.toBe('معدّل محلياً');
  });

  // دراسة القائم (قرار المالك 2026-10-09 أولاً ٥): تعديل الصلاحية لا يمسح ما عدّله العضو من بياناته، ويعيد ما قبله وما بعده للسجل
  test('تعديل الصلاحية لا يمسح بيانات العضو · ويعيد الصلاحية قبله وبعده', async () => {
    const orgR = new FirestoreRemote({ ...base(OWNER, 'owner@example.test'), org: OWNER });
    const mr = deviceRemote(mem, MEMBER, MEMBER_EMAIL);
    await updateMemberProfile(mr, OWNER, MEMBER, { name: 'عضو معدّل مصطنع', phone: '0500000901', nid: '', title: '' });
    const r = await updateMember(orgR, OWNER, MEMBER, { email: MEMBER_EMAIL, perms: { collect: 2 }, allProps: true, props: [],
      profile: { name: 'اسم قديم مصطنع', phone: '', nid: '', title: '' } }, 'منشأة الرحلة');
    const d = await orgR.getDoc(`orgs/${OWNER}/members/${MEMBER}`);
    expect([d!.name, d!.phone]).toEqual(['عضو معدّل مصطنع', '0500000901']);
    expect(r.after.perm).toEqual({ collect: 2 });
    expect(r.before.perm).not.toEqual(r.after.perm);
    await refreshMembership(mem, mr);
  });

  test('تعديل الصلاحية يُلتقط · والإزالة تُلتقط', async () => {
    const orgR = new FirestoreRemote({ ...base(OWNER, 'owner@example.test'), org: OWNER });
    const mr = deviceRemote(mem, MEMBER, MEMBER_EMAIL);
    expect(await refreshMembership(mem, mr)).toBe('same');
    await updateMember(orgR, OWNER, MEMBER, { email: MEMBER_EMAIL, perms: { collect: 1 }, allProps: true, props: [] }, 'منشأة الرحلة');
    expect(await refreshMembership(mem, mr)).toBe('changed');
    expect(readAccess(mem).perms).toEqual({ collect: 1 });
    await removeMember(orgR, OWNER, MEMBER);
    expect(await refreshMembership(mem, deviceRemote(mem, MEMBER, MEMBER_EMAIL))).toBe('removed');
  });
});
