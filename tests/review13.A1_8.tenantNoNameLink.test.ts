/**
 * A1-8 · قرار المالك س٨ (تطبيقاً لقراره 2026-08-20): عقدٌ بلا هوية باسمٍ يطابق مستأجراً قائماً يُنشأ له مستأجرٌ جديد ويُعرض في
 * «مستأجرون متشابهون» ليدمج المالك بنفسه · والربط بالهوية وحدها · ومسودةٌ بلا هوية تبقى على مستأجرها في كل حفظ. بيانات مصطنعة كلها.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, saveDraft, renewContract } from '@/domain/contracts/service';
import { similarTenantGroups, mergeTenants } from '@/domain/tenants';
import type { DB } from '@/db/adapter';

const tenantOf = (db: DB, cid: string) => db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [cid])!.t;
const liveTenants = (db: DB) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tenants WHERE deleted_at IS NULL`)!.n);

test('A1-8 عقدان بلا هوية باسمٍ واحد: مستأجران، ويظهران في المتشابهين، والدمج بقرار المالك يجمعهما', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار سميّين مصطنع' });
  const c1 = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'Y-1' }), { tenant: 'سعد مصطنع', idNumber: '', phone: '0500000101' }));
  const c2 = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'Y-2' }), { tenant: 'سعد  مصطنع ', idNumber: '', phone: '0500000102' }));
  expect(tenantOf(db, c2)).not.toBe(tenantOf(db, c1));
  const g = similarTenantGroups(db);
  expect(g).toHaveLength(1);
  expect(g[0].tenants.map((x) => x.id).sort()).toEqual([tenantOf(db, c1), tenantOf(db, c2)].sort());
  mergeTenants(db, tenantOf(db, c1), [tenantOf(db, c2)]);
  expect(tenantOf(db, c2)).toBe(tenantOf(db, c1));
  db.close();
});

test('A1-8 الهوية نفسها تربط بالمستأجر القائم، وإن اختلف الاسم', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار هوية مصطنع' });
  const c1 = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'Y-3' }), { tenant: 'فهد مصطنع', idNumber: '1000001017' }));
  const c2 = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'Y-4' }), { tenant: 'فهد بن مصطنع', idNumber: '1000001017' }));
  expect(tenantOf(db, c2)).toBe(tenantOf(db, c1));
  expect(liveTenants(db)).toBe(1);
  db.close();
});

test('A1-8 مسودة بلا هوية تُحفظ مراراً على مستأجرها نفسه، وتغيير اسمها ينشئ غيره ويحذف اليتيم', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مسودة مصطنع' }), { unit_no: 'Y-5' });
  const input = { ...contractInput(u, { tenant: 'نايف مصطنع', idNumber: '' }) };
  const d = saveDraft(db, input);
  const t0 = tenantOf(db, d);
  saveDraft(db, { ...input, phone: '0500000103' }, d);
  saveDraft(db, input, d);
  expect(tenantOf(db, d)).toBe(t0);
  expect(liveTenants(db)).toBe(1);
  saveDraft(db, { ...input, tenant: 'ماجد مصطنع' }, d);
  expect(tenantOf(db, d)).not.toBe(t0);
  expect(liveTenants(db)).toBe(1);
  // والتوثيق بعدها لا ينشئ ثالثاً
  confirmContract(db, { ...input, tenant: 'ماجد مصطنع' }, d);
  expect(liveTenants(db)).toBe(1);
  db.close();
});

test('A1-8 التجديد لمستأجرٍ بلا هوية يبقى على مستأجره', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار تجديد مصطنع' }), { unit_no: 'Y-6' });
  const a = confirmContract(db, contractInput(u, { tenant: 'بندر مصطنع', idNumber: '', depositHalalas: 0 }));
  const b = renewContract(db, a, { start: '2027-01-01', end: '2027-12-31', valueHalalas: 1200000, cycle: 'شهرية', carryDeposit: false,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  expect(tenantOf(db, b)).toBe(tenantOf(db, a));
  expect(liveTenants(db)).toBe(1);
  db.close();
});
