/**
 * «مسح كل البيانات» كأنه تثبيت جديد (توجيه المالك ٢٠٢٦-١٠-٠٤) · على محاكي Firestore ببيانات مصطنعة كاملة:
 * جهازان للمالك وعضو، ثم المسح من الأول، ثم كل شاشة وتقرير: على الجهاز نفسه، والجهاز الثاني،
 * وجهاز العضو، وتثبيت جديد · لا حركات ولا أرقام ولا دفعات ولا أسماء، ولا سجل يتيم، ولا يرجع شيء.
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/orgWipe.emulator.test.ts"
 */
import * as path from 'node:path';
import { FirestoreRemote } from '@/cloud/firestore';
import type { DB } from '@/db/adapter';
import { readAccess, saveMembership } from '@/services/access';
import { memberTokens, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';
import { tempDir, rmrf } from './helpers/testDb';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const OWNER = 'OWNER-WIPE';
const MEMBER = 'MEMBER-WIPE';
const d = HOST ? describe : describe.skip;
const T = '2026-05-15';

function token(uid: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email: uid.toLowerCase() + '@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const tables = SYNC_TABLES.map((t) => t.name);
const remote = (uid: string, dbOrEnv: DB | { db: DB }) => {
  // القاعدة الحية بعد المسح غير التي قبله في الاختبار (تُفتح من جديد) · فتُقرأ كل مرة
  const cur = (): DB => ('run' in dbOrEnv ? dbOrEnv : dbOrEnv.db);
  const member = uid !== OWNER;
  return new FirestoreRemote({
    projectId: PROJECT, uid, idToken: async () => token(uid), baseUrl: 'http://' + HOST, org: OWNER,
    access: () => readAccess(cur()),
    ...(member ? { memberTokens: () => memberTokens(readAccess(cur())), fullReadTables: () => fullReadTables(readAccess(cur()), tables) } : {}),
  });
};

let dirs: string[] = [];
afterAll(() => { for (const x of dirs) rmrf(x); });

/** ما تعرضه الشاشات والتقارير · كلها يجب أن تكون فارغة أو صفراً */
async function visible(db: DB) {
  const { allInstallments, portfolioStats } = await import('@/domain/stats');
  const { periodRevenueExpense, trialBalance } = await import('@/domain/accounting/ledger');
  const { periodRevenueExpenseAccrual } = await import('@/domain/accrual');
  const { orphanCounts } = await import('@/domain/accounting/integrity');
  const n = (sql: string) => Number(db.get<{ n: number }>(sql)!.n);
  const cash = periodRevenueExpense(db, '2000-01-01', '2100-12-31');
  const accr = periodRevenueExpenseAccrual(db, '2000-01-01', '2100-12-31');
  return {
    business: Object.fromEntries(['properties', 'units', 'tenants', 'contracts', 'contract_installments', 'contract_payments',
      'purchases', 'bank_tx', 'banks', 'claims', 'journal_entries', 'suppliers', 'handovers']
      .map((t) => [t, n(`SELECT COUNT(*) AS n FROM ${t}`)])),
    installments: allInstallments(db, T).length,
    recentPayments: n(`SELECT COUNT(*) AS n FROM contract_payments p JOIN contracts c ON c.id = p.contract_id AND c.deleted_at IS NULL`),
    revenue: [cash.revenue, cash.expense, accr.revenue, accr.expense],
    trial: trialBalance(db, null, null).filter((r) => r.debitHalalas || r.creditHalalas || r.closingHalalas).length,
    units: portfolioStats(db, T).total,
    orphans: orphanCounts(db),
  };
}
const EMPTY = {
  business: { properties: 0, units: 0, tenants: 0, contracts: 0, contract_installments: 0, contract_payments: 0, purchases: 0, bank_tx: 0, banks: 0, claims: 0, journal_entries: 0, suppliers: 0, handovers: 0 },
  installments: 0, recentPayments: 0, revenue: [0, 0, 0, 0], trial: 0, units: 0, orphans: { payments: 0, installments: 0, contracts: 0 },
};

d('مسح كل البيانات عبر المنشأة', () => {
  test('بعد المسح لا شيء ظاهر في أي جهاز ولا يرجع بعد إعادة التثبيت', async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { makeBackupEnv } = await import('./helpers/backupEnv');
    const { addProperty, addUnit, addBank, contractInput } = await import('./helpers/fixtures');
    const { confirmContract, recordRentPayment } = await import('@/domain/contracts/service');
    const { savePurchase, payPurchase } = await import('@/domain/purchases');
    const { saveClaim } = await import('@/domain/claims');
    const { enableSync, syncOnce, seedOutbox, setSyncState, setCapture } = await import('@/sync/engine');
    const { moveOwnerToOrg, wipeOrgCloud, checkEpoch, sendInvite, acceptInvite } = await import('@/services/org');
    const { wipeAllData } = await import('@/domain/wipe');
    const newEnv = () => { const dir = tempDir('aqari-wipe-').replace(/\\/g, '/'); dirs.push(dir); return makeBackupEnv(dir); };
    const legacy = new FirestoreRemote({ projectId: PROJECT, uid: OWNER, idToken: async () => token(OWNER), baseUrl: 'http://' + HOST });

    // الجهاز الأول: بيانات كاملة مصطنعة
    const A = newEnv();
    enableSync(A.db, OWNER);
    const p = addProperty(A.db, { id: 'WP1', name: 'عقار المسح التجريبي' });
    const bank = addBank(A.db, 'بنك المسح التجريبي');
    for (let i = 0; i < 4; i++) {
      const u = addUnit(A.db, p, { unit_no: 'W-' + i });
      const c = confirmContract(A.db, contractInput(u, { tenant: 'مستأجر مسح ' + i, idNumber: '10000002' + String(i).padStart(2, '0'), phone: '05000002' + String(i).padStart(2, '0') }));
      const inst = A.db.get<{ id: string; amount_halalas: number }>(`SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!;
      recordRentPayment(A.db, c, { installmentId: inst.id, period: 'الأول', date: '2026-02-01', lines: [{ method: 'bank', bankId: bank, amountHalalas: Number(inst.amount_halalas) }], discountHalalas: 0, notes: '' });
      saveClaim(A.db, { contractId: c, amountHalalas: 1000, reason: 'تجربة', date: '2026-03-01' });
      const pur = savePurchase(A.db, { supplier: 'مورد مسح تجريبي', date: '2026-03-01', due: '2026-03-10', category: 'صيانة', incorpItem: '', amortize: false,
        amortizeMonths: null, exempt: false, excludeFromVat: false, unitId: u, propertyId: p, subtotalHalalas: 10000, taxHalalas: 1500, totalHalalas: 11500 } as never);
      payPurchase(A.db, pur, 'bank', bank, '2026-03-05');
    }
    await moveOwnerToOrg(A.db, legacy, remote(OWNER, A), OWNER);
    await syncOnce(A.db, remote(OWNER, A), 'dev-A');

    // الجهاز الثاني للمالك يسحب كل شيء
    const B = newEnv();
    enableSync(B.db, OWNER);
    await moveOwnerToOrg(B.db, legacy, remote(OWNER, B), OWNER);
    await checkEpoch(B.db, remote(OWNER, B), OWNER, async () => { await wipeAllData(B); return B.db; });
    await syncOnce(B.db, remote(OWNER, B), 'dev-B');
    expect(Number(B.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contracts`)!.n)).toBe(4);

    // عضو بكل العقارات والتحصيل
    const ownerR = remote(OWNER, A);
    await sendInvite(ownerR, OWNER, { email: MEMBER.toLowerCase() + '@example.test', perms: { collect: 1, contracts: 1, props: 1 }, allProps: true, props: [] }, 'منشأة المسح', OWNER.toLowerCase() + '@example.test');
    const M = newEnv();
    const plain = new FirestoreRemote({ projectId: PROJECT, uid: MEMBER, idToken: async () => token(MEMBER), baseUrl: 'http://' + HOST });
    const inv = (await import('@/services/org')).findInvites;
    const invites = await inv(plain, MEMBER.toLowerCase() + '@example.test');
    const mship = await acceptInvite(M.db, plain, OWNER, MEMBER, invites[0].doc);
    saveMembership(M.db, mship);
    setSyncState(M.db, 'uid', MEMBER);
    M.db.run(`DELETE FROM sync_outbox`);
    setCapture(M.db, true);
    await checkEpoch(M.db, remote(MEMBER, M), OWNER, async () => { await wipeAllData(M); return M.db; });
    await syncOnce(M.db, remote(MEMBER, M), 'dev-M');
    expect(Number(M.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments`)!.n)).toBe(4);

    // المسح من الجهاز الأول: نسخة أمان ثم السحابة ثم الجهاز (كما يفعل wipeEverything)
    const { makeSafetyBackup } = await import('@/domain/backup/create');
    const safety = await makeSafetyBackup(A, 'pre-wipe');
    const epoch = await wipeOrgCloud(remote(OWNER, A), OWNER);
    await wipeAllData(A, undefined, safety);
    setSyncState(A.db, 'wipe_epoch', String(epoch));
    seedOutbox(A.db);
    await syncOnce(A.db, remote(OWNER, A), 'dev-A');
    expect(await visible(A.db)).toEqual(EMPTY);
    expect(A.fs.exists(safety)).toBe(true);

    // الجهاز الثاني: أول مزامنة بعد المسح تفرّغه
    expect(await checkEpoch(B.db, remote(OWNER, B), OWNER, async () => { await wipeAllData(B); return B.db; })).toBe('wipe');
    await syncOnce(B.db, remote(OWNER, B), 'dev-B');
    expect(await visible(B.db)).toEqual(EMPTY);

    // جهاز العضو كذلك
    expect(await checkEpoch(M.db, remote(MEMBER, M), OWNER, async () => { await wipeAllData(M); return M.db; })).toBe('wipe');
    await syncOnce(M.db, remote(MEMBER, M), 'dev-M');
    expect(await visible(M.db)).toEqual(EMPTY);

    // تثبيت جديد: لا يرجع شيء، ولا يُفرَّغ (لا بيانات عليه)
    const C = newEnv();
    enableSync(C.db, OWNER);
    await moveOwnerToOrg(C.db, legacy, remote(OWNER, C), OWNER);
    expect(await checkEpoch(C.db, remote(OWNER, C), OWNER, async () => { throw new Error('لا يُفرَّغ تثبيت جديد'); })).toBe('adopt');
    await syncOnce(C.db, remote(OWNER, C), 'dev-C');
    expect(await visible(C.db)).toEqual(EMPTY);
    expect(Number(C.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects`)!.n)).toBe(0);
    void path;
  });
});
