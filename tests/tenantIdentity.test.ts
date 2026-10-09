/**
 * دراسة القائم (2026-10-09، فجوة عالية) · قرار المالك 2026-08-20: «رقم الهوية مفتاح فريد … عند إنشاء عقد: ابحث بالهوية
 * أولاً · وُجد فاربط، لم يوجد فأنشئ … واعرض المتشابهات لأقرّرها أنا» · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, saveDraft, renewContract } from '@/domain/contracts/service';
import { mergeTenants } from '@/domain/tenants';
import { applyExtras } from '@/domain/pdf/ejarExtras';

test('مستأجران باسمٍ واحد وهويتين مختلفتين يبقيان اثنين · والمتشابه يُعرض لا يُدمج', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار هوية مصطنع' });
  const a = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'H-1' }), { tenant: 'سالم مصطنع', idNumber: '1000000601', phone: '0500000601', depositHalalas: 0 }));
  const b = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'H-2' }), { tenant: 'سالم مصطنع', idNumber: '1000000619', phone: '0500000602', depositHalalas: 0 }));
  const tid = (c: string) => db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [c])!.t;
  expect(tid(a)).not.toBe(tid(b));
  expect(db.get<{ n: string }>(`SELECT national_id AS n FROM tenants WHERE id = ?`, [tid(a)])!.n).toBe('1000000601');
  expect(db.get<{ n: string }>(`SELECT national_id AS n FROM tenants WHERE id = ?`, [tid(b)])!.n).toBe('1000000619');
  db.close();
});

test('تغيير مستأجر المسودة يغيّر ربطها', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مسودة مصطنع' }), { unit_no: 'D-1' });
  const id = saveDraft(db, contractInput(u, { tenant: 'مستأجر أول مصطنع', idNumber: '1000000627', phone: '0500000603', depositHalalas: 0 }) as never);
  saveDraft(db, contractInput(u, { tenant: 'مستأجر ثانٍ مصطنع', idNumber: '1000000635', phone: '0500000604', depositHalalas: 0 }) as never, id);
  const t = db.get<{ n: string; name: string }>(
    `SELECT t.national_id AS n, t.name FROM contracts c JOIN tenants t ON t.id = c.tenant_id WHERE c.id = ?`, [id])!;
  expect(t).toEqual({ n: '1000000635', name: 'مستأجر ثانٍ مصطنع' });
  db.close();
});

test('(التحقق المستقل) تجديد عقدٍ بعد دمج مستأجره يبقى على المستأجر المدموج', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار دمج مصطنع' });
  const a = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'M-1' }), { tenant: 'مستأجر دمج مصطنع', idNumber: '1000000601', phone: '0500000611', depositHalalas: 0, start: '2025-01-01', end: '2025-12-31' }));
  const b = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'M-2' }), { tenant: 'مستأجر دمج مصطنع', idNumber: '1000000619', phone: '0500000612', depositHalalas: 0, start: '2025-01-01', end: '2025-12-31' }));
  const tid = (c: string) => db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [c])!.t;
  mergeTenants(db, tid(a), [tid(b)], { allowDifferentIds: true });
  const r = renewContract(db, b, { start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, cycle: 'شهرية', carryDeposit: false,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' } as never);
  expect(tid(r)).toBe(tid(a));
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tenants WHERE deleted_at IS NULL`)!.n)).toBe(1);
  db.close();
});

test('(التحقق المستقل) تغيير مستأجر المسودة لا يترك مستأجراً يتيماً أنشأته', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار يتيم مصطنع' }), { unit_no: 'Y-1' });
  const id = saveDraft(db, contractInput(u, { tenant: 'مستأجر أول مصطنع', idNumber: '1000000643', phone: '0500000621', depositHalalas: 0 }) as never);
  saveDraft(db, contractInput(u, { tenant: 'مستأجر ثانٍ مصطنع', idNumber: '1000000650', phone: '0500000622', depositHalalas: 0 }) as never, id);
  saveDraft(db, contractInput(u, { tenant: 'مستأجر ثالث مصطنع', idNumber: '', phone: '0500000623', depositHalalas: 0 }) as never, id);
  const orphans = Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tenants t WHERE t.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.tenant_id = t.id AND c.deleted_at IS NULL)`)!.n);
  expect(orphans).toBe(0);
  db.close();
});

test('(التحقق المستقل) بريد المستأجر من ملف العقد يُكتب لمستأجر العقد وحده لا لكل من يحمل اسمه', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار بريد مصطنع' });
  const u1 = addUnit(db, p, { unit_no: 'E-1' });
  const a = confirmContract(db, contractInput(u1, { tenant: 'مستأجر بريد مصطنع', idNumber: '1000000668', phone: '0500000631', depositHalalas: 0 }));
  confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'E-2' }), { tenant: 'مستأجر بريد مصطنع', idNumber: '1000000676', phone: '0500000632', depositHalalas: 0 }));
  const tA = db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [a])!.t;
  applyExtras(db, [{ key: 'tenant.email', read: 'a@example.test', current: '' } as never], new Set(['tenant.email'] as never),
    { unitId: u1, tenantName: 'مستأجر بريد مصطنع', tenantId: tA, start: '2026-01-01', handoverRef: 'مصطنع' });
  expect(db.all(`SELECT email FROM tenants ORDER BY national_id`)).toEqual([{ email: 'a@example.test' }, { email: '' }]);
  db.close();
});

