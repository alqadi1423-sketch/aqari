/**
 * تثبيت جديد بحساب المالك يسحب منشأته كاملة بلا رفض (توجيه المالك) · على محاكي Firestore وببيانات مصطنعة:
 * جهاز أول يبني منشأة كاملة (عقود ودفعات ومشتريات وحركات بنك وعدادات) ويرفعها بإسقاطاتها،
 * وجهاز جديد فارغ يدخل بالحساب نفسه فيسحب: كل جدول مطابق وصفر مرفوض وصفر منتظر.
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/orgFreshInstall.emulator.test.ts"
 */
import { FirestoreRemote } from '@/cloud/firestore';
import type { DB } from '@/db/adapter';
import { SYNC_TABLES } from '@/db/syncTables';
import { readAccess } from '@/services/access';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const OWNER = 'OWNER-FRESH';
const d = HOST ? describe : describe.skip;

function token(uid: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email: 'owner-fresh@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const remote = (db: DB) => new FirestoreRemote({ projectId: PROJECT, uid: OWNER, idToken: async () => token(OWNER), baseUrl: 'http://' + HOST, org: OWNER, access: () => readAccess(db) });

const counts = (db: DB) => Object.fromEntries(SYNC_TABLES.map((t) => [t.name, Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t.name}`)!.n)]));

d('تثبيت جديد بحساب المالك', () => {
  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  });

  test('السحب كامل بلا رفض ولا انتظار', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, addBank, contractInput } = await import('./helpers/fixtures');
    const { confirmContract, recordRentPayment } = await import('@/domain/contracts/service');
    const { savePurchase, payPurchase } = await import('@/domain/purchases');
    const { saveClaim } = await import('@/domain/claims');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    const { moveOwnerToOrg } = await import('@/services/org');
    const a = memDb();
    enableSync(a, OWNER);
    const p = addProperty(a, { name: 'عقار التثبيت التجريبي' });
    const bank = addBank(a, 'بنك تجريبي');
    for (let i = 0; i < 40; i++) {
      const u = addUnit(a, p, { unit_no: 'T-' + i });
      const c = confirmContract(a, contractInput(u, { tenant: 'مستأجر تثبيت ' + i, idNumber: '10000001' + String(i).padStart(2, '0'), phone: '05000001' + String(i).padStart(2, '0') }));
      const inst = a.get<{ id: string; amount_halalas: number }>(`SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!;
      recordRentPayment(a, c, { installmentId: inst.id, period: 'الأول', date: '2026-02-01', lines: [{ method: 'bank', bankId: bank, amountHalalas: Number(inst.amount_halalas) }], discountHalalas: 0, notes: '' });
      if (i % 2) saveClaim(a, { contractId: c, amountHalalas: 1000, reason: 'تجربة', date: '2026-03-01' });
      const pur = savePurchase(a, {
        supplier: 'مورد تجريبي', date: '2026-03-01', due: '2026-03-10', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
        exempt: false, excludeFromVat: false, unitId: u, propertyId: p, subtotalHalalas: 10000, taxHalalas: 1500, totalHalalas: 11500,
      } as never);
      payPurchase(a, pur, 'bank', bank, '2026-03-05');
    }
    // الجهاز الأول ينتقل ويرفع
    const legacy = new FirestoreRemote({ projectId: PROJECT, uid: OWNER, idToken: async () => token(OWNER), baseUrl: 'http://' + HOST });
    await moveOwnerToOrg(a, legacy, remote(a), OWNER);
    const up = await syncOnce(a, remote(a), 'dev-first');
    expect(up.pending).toBe(0);

    // تثبيت جديد: قاعدة فارغة تدخل بالحساب نفسه
    const b = memDb();
    enableSync(b, OWNER);
    await moveOwnerToOrg(b, legacy, remote(b), OWNER);
    // دورة واحدة تكفي: السحب لا يقف عند صفحة قصّرها إهمال الإسقاطات
    await syncOnce(b, remote(b), 'dev-fresh');
    const rejects = b.all<{ tbl: string; reason: string }>(`SELECT tbl, reason FROM sync_rejects`);
    expect(rejects.slice(0, 5)).toEqual([]);
    expect(Number(b.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox`)!.n)).toBe(0);
    expect(counts(b)).toEqual(counts(a));
  });
});
