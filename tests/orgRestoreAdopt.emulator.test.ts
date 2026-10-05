/**
 * ما جرى على هاتف المالك (٢٠٢٦-١٠-٠٥) على محاكي Firestore بالمحرّك والخدمة نفسيهما:
 * مسحٌ يترك عهداً في السحابة ← استعادة نسخة أقدم منه ← اعتمادها للسحابة ← مزامنة: لا يُفرَّغ الجهاز، والطابور يُرفع
 * كاملاً · واستعمالٌ وإغلاق وفتح وإعادة تثبيت لا يُفقد معها شيء · والخصومات لا تظهر متبقياً.
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/orgRestoreAdopt.emulator.test.ts"
 * البيانات مصطنعة كلها.
 */
import * as path from 'node:path';
import * as nfs from 'node:fs';
import { FirestoreRemote } from '@/cloud/firestore';
import type { DB } from '@/db/adapter';
import { readAccess } from '@/services/access';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const OWNER = 'OWNER-RESTORE';
const d = HOST ? describe : describe.skip;
const T = '2026-06-15';

function token(uid: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email: uid.toLowerCase() + '@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const remote = (env: { db: DB }) => new FirestoreRemote({
  projectId: PROJECT, uid: OWNER, org: OWNER, idToken: async () => token(OWNER), baseUrl: 'http://' + HOST, access: () => readAccess(env.db),
});
const dirs: string[] = [];
afterAll(() => { for (const x of dirs) rmrf(x); });
const newEnv = (): TestBackupEnv => {
  const dir = tempDir('aqari-restore-').replace(/\\/g, '/');
  dirs.push(dir);
  nfs.mkdirSync(dir, { recursive: true });
  return makeBackupEnv(dir);
};
const count = (db: DB, t: string) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'contract_payments' || t === 'journal_lines' ? '1' : 'deleted_at IS NULL'}`)!.n);
const snapshot = (db: DB) => ['properties', 'units', 'contracts', 'contract_payments', 'purchases'].map((t) => t + '=' + count(db, t)).join(' ');

d('مسحٌ يترك عهداً ثم استعادة واعتماد ومزامنة', () => {
  test('لا يُفرَّغ الجهاز · والطابور يُرفع كاملاً · ولا خصم متبقياً · ولا فقد بعد الإغلاق وإعادة التثبيت', async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract, recordRentPayment } = await import('@/domain/contracts/service');
    const { DISCOUNT_AFTER_DUE } = await import('@/domain/contracts/installments');
    const { savePurchase } = await import('@/domain/purchases');
    const { enableSync, syncOnce, outboxCount, setSyncState, getSyncState, seedOutbox, planCloudReplace, adoptAsCloudTruth } = await import('@/sync/engine');
    const { moveOwnerToOrg, wipeOrgCloud, checkEpoch, readEpoch } = await import('@/services/org');
    const { wipeAllData } = await import('@/domain/wipe');
    const { createBackup } = await import('@/domain/backup/create');
    const { restoreBackup } = await import('@/domain/backup/restore');
    const { allInstallments } = await import('@/domain/stats');
    const legacy = new FirestoreRemote({ projectId: PROJECT, uid: OWNER, idToken: async () => token(OWNER), baseUrl: 'http://' + HOST });
    const lateDiscount = (db: DB) => allInstallments(db, T).filter((i) => i.remaining > 0 && i.paid > 0 && i.daysLate > 0).length;

    // ١) جهاز المالك ببيانات مصطنعة فيها خصومات · ونسخةٌ احتياطية منها قبل أي عهد
    const A = newEnv();
    const p = addProperty(A.db, { name: 'عقار الاستعادة' });
    for (let i = 0; i < 6; i++) {
      const c = confirmContract(A.db, contractInput(addUnit(A.db, p, { unit_no: 'R-' + i }), { tenant: 'مستأجر استعادة ' + i, idNumber: '10000003' + String(i).padStart(2, '0'), phone: '05000003' + String(i).padStart(2, '0'), start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
      const ins = A.db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 4`, [c]);
      for (const it of ins) recordRentPayment(A.db, c, { installmentId: it.id, period: 'ش', date: '2026-02-01', lines: [{ method: 'cash', amountHalalas: 90000 }], discountHalalas: 10000, discountKind: DISCOUNT_AFTER_DUE, notes: '' });
    }
    savePurchase(A.db, { supplier: 'مورد استعادة', date: '2026-03-01', due: '2026-03-31', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false, subtotalHalalas: 5000, taxHalalas: 0, totalHalalas: 5000, propertyId: p });
    const before = snapshot(A.db);
    expect(lateDiscount(A.db)).toBe(0);
    const archive = path.join(dirs[dirs.length - 1], 'old.aqbk').replace(/\\/g, '/');
    await createBackup(A, archive);

    // ٢) يرتبط بالمنشأة ويرفع، ثم «امسح كل البيانات» يترك عهداً ١ في السحابة
    enableSync(A.db, OWNER);
    await moveOwnerToOrg(A.db, legacy, remote(A), OWNER);
    await syncOnce(A.db, remote(A), 'dev-A');
    const epoch = await wipeOrgCloud(remote(A), OWNER);
    expect(epoch).toBe(1);
    await wipeAllData(A);
    setSyncState(A.db, 'wipe_epoch', String(epoch));
    seedOutbox(A.db);
    await syncOnce(A.db, remote(A), 'dev-A');

    // ٣) استعادة النسخة الأقدم من العهد ثم اعتمادها للسحابة · كما يفعل التطبيق
    await restoreBackup(A, archive);
    expect(getSyncState(A.db, 'wipe_epoch')).toBeNull(); // النسخة لا تعرف العهد
    setSyncState(A.db, 'uid', OWNER);
    setSyncState(A.db, 'org', OWNER);
    // بلا اعتماد: لا تفريغ أبداً · يُسأل المستخدم
    expect(await checkEpoch(A.db, remote(A), OWNER)).toBe('ask');
    expect(snapshot(A.db)).toBe(before);
    setSyncState(A.db, 'epoch_pending', null);
    const plan = await planCloudReplace(A.db, remote(A));
    adoptAsCloudTruth(A.db, OWNER, plan, await readEpoch(remote(A), OWNER));
    expect(getSyncState(A.db, 'wipe_epoch')).toBe('1');

    // ٤) المزامنة: لا تفريغ، والطابور يُرفع كاملاً
    expect(await checkEpoch(A.db, remote(A), OWNER)).toBe('same');
    const queued = outboxCount(A.db);
    expect(queued).toBeGreaterThan(100);
    const rep = await syncOnce(A.db, remote(A), 'dev-A');
    expect(rep.pending).toBe(0);
    expect(snapshot(A.db)).toBe(before);
    expect(lateDiscount(A.db)).toBe(0);

    // ٥) إغلاق وفتح ودورات مزامنة: لا يُفقد شيء
    for (let k = 0; k < 3; k++) {
      A.closeLive();
      A.reopenLive();
      expect(await checkEpoch(A.db, remote(A), OWNER)).toBe('same');
      await syncOnce(A.db, remote(A), 'dev-A');
      expect(snapshot(A.db)).toBe(before);
    }

    // ٦) إعادة التثبيت: جهاز جديد يسحب كل شيء، والخصم لا يظهر متبقياً
    const B = newEnv();
    enableSync(B.db, OWNER);
    await moveOwnerToOrg(B.db, legacy, remote(B), OWNER);
    expect(await checkEpoch(B.db, remote(B), OWNER)).toBe('adopt');
    await syncOnce(B.db, remote(B), 'dev-B');
    expect(snapshot(B.db)).toBe(before);
    expect(lateDiscount(B.db)).toBe(0);
    expect(Number(B.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects`)!.n)).toBe(0);
  });
});
