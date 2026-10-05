/**
 * نقل وحدة بين عقارين في المنشأة (ملاحظة المالك ٢٠٢٦-١٠-٠٥ على ٤.١٢) على محاكي Firestore:
 * العضو الذي صار له حقٌّ فيها تصله كاملة، والذي لم يعد له حقٌّ فيها يُفرَّغ جهازه ويُعاد سحبه فلا تبقى عنده.
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/orgUnitMove.emulator.test.ts"
 * البيانات مصطنعة كلها.
 */
import { FirestoreRemote } from '@/cloud/firestore';
import type { DB } from '@/db/adapter';
import { memberTokens, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';
import { readAccess, readMembership, saveMembership, type Membership } from '@/services/access';
import { sendInvite, findInvites, acceptInvite, checkUnitMoves, publishUnitMoves } from '@/services/org';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const OWNER = 'OWNER-MOVE';
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
function deviceRemote(db: DB, uid: string, email: string): FirestoreRemote {
  const m = readMembership(db);
  if (m) {
    return new FirestoreRemote({ ...base(uid, email), org: m.org,
      memberTokens: () => memberTokens(readAccess(db)), fullReadTables: () => fullReadTables(readAccess(db), tables), access: () => readAccess(db) });
  }
  return new FirestoreRemote({ ...base(uid, email), org: uid, access: () => readAccess(db) });
}
/** ربط جهاز عضو بعضويته كما يفعل bindMember بعد التفريغ */
async function bind(db: DB, m: Membership, uid: string) {
  const { setSyncState, setCapture } = await import('@/sync/engine');
  saveMembership(db, m);
  setSyncState(db, 'org', m.org);
  setSyncState(db, 'uid', uid);
  setSyncState(db, 'cursor', null);
  db.run(`DELETE FROM sync_outbox`);
  setCapture(db, true);
}

d('نقل وحدة بين عقارين', () => {
  let owner: DB;
  let a: DB;
  let b: DB;
  let C = '';
  const A = { uid: 'MEM-A', email: 'mem-a@example.test' };
  const B = { uid: 'MEM-B', email: 'mem-b@example.test' };

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const { saveUnit } = await import('@/domain/propertiesService');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    owner = memDb();
    addProperty(owner, { id: 'MP1', name: 'عقار النقل الأول' });
    addProperty(owner, { id: 'MP2', name: 'عقار النقل الثاني' });
    const unit = saveUnit(owner, { propertyId: 'MP1', unitNo: 'M-1', floor: '', type: 'سكني', subtype: '', rentMonthlyHalalas: 0, rooms: [], meters: [] });
    C = confirmContract(owner, contractInput(unit, { tenant: 'مستأجر نقل مصطنع', idNumber: '1000000074', phone: '0500000031' }));
    enableSync(owner, OWNER);
    owner.run(`INSERT INTO sync_state (k, v) VALUES ('org', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [OWNER]);
    expect((await syncOnce(owner, deviceRemote(owner, OWNER, 'owner-move@example.test'), 'dev-owner-m')).pending).toBe(0);
    const orgR = new FirestoreRemote({ ...base(OWNER, 'owner-move@example.test'), org: OWNER });
    for (const [x, prop] of [[A, 'MP1'], [B, 'MP2']] as const) {
      await sendInvite(orgR, OWNER, { email: x.email, perms: { contracts: 1, props: 1 }, allProps: false, props: [prop] }, 'منشأة النقل', 'owner-move@example.test');
    }
    a = memDb(); b = memDb();
    for (const [db, x] of [[a, A], [b, B]] as const) {
      const plain = new FirestoreRemote(base(x.uid, x.email));
      const inv = await findInvites(plain, x.email);
      const m = await acceptInvite(db, plain, OWNER, x.uid, inv[0].doc);
      await bind(db, m, x.uid);
      await syncOnce(db, deviceRemote(db, x.uid, x.email), 'dev-' + x.uid);
      expect(await checkUnitMoves(db, deviceRemote(db, x.uid, x.email))).toBe('none');
    }
    expect(a.get(`SELECT id FROM contracts WHERE id = ?`, [C])).toBeTruthy();
    expect(b.get(`SELECT id FROM contracts WHERE id = ?`, [C])).toBeUndefined();
  });

  test('المالك ينقل الوحدة: عضو العقار الجديد تصله كاملة · وعضو القديم يُفرَّغ ويُعاد سحبه بلا الوحدة', async () => {
    const { saveUnit } = await import('@/domain/propertiesService');
    const { syncOnce } = await import('@/sync/engine');
    const { memDb } = await import('./helpers/testDb');
    const unit = owner.get<{ id: string }>(`SELECT id FROM units WHERE unit_no = 'M-1'`)!.id;
    saveUnit(owner, { propertyId: 'MP2', unitNo: 'M-1', floor: '', type: 'سكني', subtype: '', rentMonthlyHalalas: 0, rooms: [], meters: [] }, unit);
    const ownerR = deviceRemote(owner, OWNER, 'owner-move@example.test');
    expect((await syncOnce(owner, ownerR, 'dev-owner-m')).pending).toBe(0);
    expect(await publishUnitMoves(owner, ownerR, OWNER)).toBe(1);

    // العضو الذي صار له حقٌّ فيها
    await syncOnce(b, deviceRemote(b, B.uid, B.email), 'dev-' + B.uid);
    expect(b.get(`SELECT id FROM contracts WHERE id = ?`, [C])).toBeTruthy();
    const ownerInst = Number(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_installments WHERE contract_id = ?`, [C])!.n);
    expect(Number(b.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_installments WHERE contract_id = ?`, [C])!.n)).toBe(ownerInst);
    expect(await checkUnitMoves(b, deviceRemote(b, B.uid, B.email))).toBe('none');

    // العضو الذي لم يعد له حقٌّ فيها: يُكتشف ثم يُفرَّغ ويُعاد سحبه كتغيّر الصلاحية
    expect(await checkUnitMoves(a, deviceRemote(a, A.uid, A.email))).toBe('lost');
    const m = readMembership(a)!;
    const fresh = memDb();
    await bind(fresh, m, A.uid);
    await syncOnce(fresh, deviceRemote(fresh, A.uid, A.email), 'dev-' + A.uid);
    expect(fresh.get(`SELECT id FROM contracts WHERE id = ?`, [C])).toBeUndefined();
    expect(fresh.get(`SELECT id FROM units WHERE id = ?`, [unit])).toBeUndefined();
    // ولا يتكرر التفريغ في الدورة التالية
    expect(await checkUnitMoves(fresh, deviceRemote(fresh, A.uid, A.email))).toBe('none');
    expect(await checkUnitMoves(fresh, deviceRemote(fresh, A.uid, A.email))).toBe('none');
  });
});
