/**
 * عضوٌ بصلاحية عرضٍ على عقارٍ واحد (أعطال اختبار الإصدار ٢٠٢٦-١٠-٠٥: «حساب العضو فارغ») على محاكي Firestore:
 * يرى العقار ووحداته وعقوده وأقساطها كما يراها المالك، ولا يرى العقار الآخر، ولا يُرفض عنده شيء.
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/orgMemberView.emulator.test.ts"
 * البيانات مصطنعة كلها.
 */
import { FirestoreRemote } from '@/cloud/firestore';
import type { DB } from '@/db/adapter';
import { memberTokens, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';
import { readAccess, readMembership, saveMembership, type Membership } from '@/services/access';
import { sendInvite, findInvites, acceptInvite } from '@/services/org';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const OWNER = 'OWNER-VIEW';
const OWNER_EMAIL = 'owner-view@example.test';
const d = HOST ? describe : describe.skip;
const T = '2026-06-15';

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
async function bind(db: DB, m: Membership, uid: string) {
  const { setSyncState, setCapture } = await import('@/sync/engine');
  saveMembership(db, m);
  setSyncState(db, 'org', m.org);
  setSyncState(db, 'uid', uid);
  setSyncState(db, 'cursor', null);
  db.run(`DELETE FROM sync_outbox`);
  setCapture(db, true);
}

d('عضو بعرض عقار واحد', () => {
  test('يرى العقار ووحداته وعقوده وأقساطها كما يراها المالك · ولا يرى غيره', async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract, recordRentPayment } = await import('@/domain/contracts/service');
    const { DISCOUNT_AFTER_DUE } = await import('@/domain/contracts/installments');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    const { allInstallments, propertyStats } = await import('@/domain/stats');

    // المالك: عقاران، في كلٍّ وحدات وعقود ودفعات بعضها بخصم
    const owner = memDb();
    for (const prop of ['VP1', 'VP2']) {
      addProperty(owner, { id: prop, name: 'عقار العرض ' + prop });
      for (let u = 0; u < 4; u++) {
        const n = (prop === 'VP1' ? 0 : 10) + u;
        const c = confirmContract(owner, contractInput(addUnit(owner, prop, { unit_no: prop + '-' + u }), { tenant: 'مستأجر عرض ' + n, idNumber: '10000040' + String(n).padStart(2, '0'), phone: '05000040' + String(n).padStart(2, '0'), start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
        const ins = owner.all<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 3`, [c]);
        for (const [k, it] of ins.entries()) recordRentPayment(owner, c, { installmentId: it.id, period: it.due_date, date: it.due_date, lines: [{ method: 'cash', amountHalalas: k ? 100000 : 90000 }], discountHalalas: k ? 0 : 10000, discountKind: k ? undefined : DISCOUNT_AFTER_DUE, notes: '' });
      }
    }
    enableSync(owner, OWNER);
    owner.run(`INSERT INTO sync_state (k, v) VALUES ('org', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [OWNER]);
    expect((await syncOnce(owner, deviceRemote(owner, OWNER, OWNER_EMAIL), 'dev-owner-v')).pending).toBe(0);
    // جهاز مالكٍ رفع قيوده قبل اتساع قرّائها: يعيد رفعها مرة برموزها الجديدة، والقواعد تقبل تغيير حقول الرؤية وحدها
    // على القيد المرحّل (الإصدار ٢ من قواعد الرؤية)
    const { setSyncState, requeueForAcl, outboxCount } = await import('@/sync/engine');
    setSyncState(owner, 'acl_version', '1');
    expect(requeueForAcl(owner)).toBe(1);
    const entries = Number(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n);
    expect(outboxCount(owner)).toBe(entries);
    expect(requeueForAcl(owner)).toBe(0);
    const again = await syncOnce(owner, deviceRemote(owner, OWNER, OWNER_EMAIL), 'dev-owner-v');
    expect([again.pending, again.pushed]).toEqual([0, entries]);
    expect(Number(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects`)!.n)).toBe(0);

    // دعوة بعرضٍ على العقار الأول وحده
    const orgR = new FirestoreRemote({ ...base(OWNER, OWNER_EMAIL), org: OWNER });
    const M = { uid: 'MEM-VIEW', email: 'mem-view@example.test' };
    await sendInvite(orgR, OWNER, { email: M.email, perms: { props: 1, contracts: 1 }, allProps: false, props: ['VP1'] }, 'منشأة العرض', OWNER_EMAIL);
    const mem = memDb();
    const plain = new FirestoreRemote(base(M.uid, M.email));
    const inv = await findInvites(plain, M.email);
    const m = await acceptInvite(mem, plain, OWNER, M.uid, inv[0].doc);
    await bind(mem, m, M.uid);
    const rep = await syncOnce(mem, deviceRemote(mem, M.uid, M.email), 'dev-' + M.uid);
    expect(rep.pending).toBe(0);

    // ما تعرضه الشاشات: العقار ووحداته وعقوده وأقساطها كما عند المالك
    const q = (db: DB, sql: string) => db.all<Record<string, unknown>>(sql, ['VP1']).map((r) => JSON.stringify(r)).sort();
    expect(mem.all<{ id: string }>(`SELECT id FROM properties WHERE deleted_at IS NULL`).map((r) => r.id)).toEqual(['VP1']);
    expect(q(mem, `SELECT id, unit_no FROM units WHERE property_id = ? AND deleted_at IS NULL`)).toEqual(q(owner, `SELECT id, unit_no FROM units WHERE property_id = ? AND deleted_at IS NULL`));
    const contractsSql = `SELECT c.id, c.tenant_name, c.status FROM contracts c JOIN units u ON u.id = c.unit_id WHERE u.property_id = ? AND c.deleted_at IS NULL`;
    expect(q(mem, contractsSql)).toHaveLength(4);
    expect(q(mem, contractsSql)).toEqual(q(owner, contractsSql));
    const view = (db: DB) => allInstallments(db, T).filter((i) => i.unitNo.startsWith('VP1-')).map((i) => [i.installmentId, i.paid, i.discount, i.remaining].join(':')).sort();
    expect(view(mem)).toHaveLength(48);
    expect(view(mem)).toEqual(view(owner));
    const st = propertyStats(mem, 'VP1', T);
    expect([st.total, st.occupied]).toEqual([propertyStats(owner, 'VP1', T).total, propertyStats(owner, 'VP1', T).occupied]);
    // ولا يرى العقار الآخر ولا شيئاً منه · ولا رفض
    expect(mem.get(`SELECT 1 FROM units WHERE property_id = 'VP2'`)).toBeUndefined();
    expect(Number(mem.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects`)!.n)).toBe(0);
  });
});
