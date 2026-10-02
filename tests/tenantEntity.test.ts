/**
 * المستأجر كيانٌ لا نصّ · بيانات مصطنعة:
 * عقدان لنفس رقم الهوية = مستأجر واحد بعقدين، تعديل الاسم لا يفصل العقود،
 * والمتشابهات تُعرض وتُدمج بقرار — والدمج يعيد العقود للوجهة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import {
  findOrCreateTenant, backfillTenantLinks, tenantProfile,
  similarTenantGroups, mergeTenants, renameTenant,
} from '@/domain/tenants';

function seed() {
  const db = memDb();
  const pid = addProperty(db);
  const u1 = addUnit(db, pid, { unit_no: 'A-1' });
  const u2 = addUnit(db, pid, { unit_no: 'A-2' });
  return { db, u1, u2 };
}

describe('المستأجر كيان بمعرّف · الهوية مفتاح الربط', () => {
  test('عقدان لنفس رقم الهوية (باسمين متفاوتي المسافات): مستأجر واحد بعقدين', () => {
    const { db, u1, u2 } = seed();
    const c1 = confirmContract(db, contractInput(u1, {
      tenant: 'فهد السالم', idNumber: '1099887766', valueHalalas: 600000, depositHalalas: 0,
      start: '2026-01-01', end: '2026-12-31',
    }));
    const c2 = confirmContract(db, contractInput(u2, {
      tenant: 'فهد  السالم ', idNumber: '1099887766', valueHalalas: 480000, depositHalalas: 0,
      start: '2026-02-01', end: '2027-01-31',
    }));
    const t1 = db.get<{ tenant_id: string }>(`SELECT tenant_id FROM contracts WHERE id = ?`, [c1])!;
    const t2 = db.get<{ tenant_id: string }>(`SELECT tenant_id FROM contracts WHERE id = ?`, [c2])!;
    expect(t1.tenant_id).toBeTruthy();
    expect(t1.tenant_id).toBe(t2.tenant_id); // شخص واحد لا اثنان
    const profile = tenantProfile(db, t1.tenant_id, '2026-06-01')!;
    expect(profile.contracts).toHaveLength(2);
    expect(profile.tenant.national_id).toBe('1099887766');
    db.close();
  });

  test('تعديل الاسم في مصدره: العقود تبقى مرتبطة وتتبعه بالاسم الجديد', () => {
    const { db, u1 } = seed();
    const cid = confirmContract(db, contractInput(u1, {
      tenant: 'سلمى الفلاني', idNumber: '1000000074', valueHalalas: 600000, depositHalalas: 0,
      start: '2026-01-01', end: '2026-12-31',
    }));
    const tid = db.get<{ tenant_id: string }>(`SELECT tenant_id FROM contracts WHERE id = ?`, [cid])!.tenant_id;
    renameTenant(db, tid, 'سلمى كمال بن حامد الفلاني');
    const c = db.get<{ tenant_id: string; tenant_name: string }>(
      `SELECT tenant_id, tenant_name FROM contracts WHERE id = ?`, [cid])!;
    expect(c.tenant_id).toBe(tid); // لم ينفصل
    expect(c.tenant_name).toBe('سلمى كمال بن حامد الفلاني'); // وتبعه الاسم
    db.close();
  });

  test('العقود القديمة بلا ربط: الإقلاع يربطها كلها (بالهوية أولاً ثم الاسم)', () => {
    const { db, u1, u2 } = seed();
    const c1 = confirmContract(db, contractInput(u1, {
      tenant: 'سعد العمري', idNumber: '1055555555', valueHalalas: 600000, depositHalalas: 0,
      start: '2026-01-01', end: '2026-12-31',
    }));
    const c2 = confirmContract(db, contractInput(u2, {
      tenant: 'سعد العمري', idNumber: '', valueHalalas: 480000, depositHalalas: 0,
      start: '2026-02-01', end: '2027-01-31',
    }));
    // نمحو الربط لنحاكي بيانات قديمة ثم نعيد الكنس
    db.run(`UPDATE contracts SET tenant_id = NULL`);
    const n = backfillTenantLinks(db);
    expect(n).toBe(2);
    const t1 = db.get<{ tenant_id: string }>(`SELECT tenant_id FROM contracts WHERE id = ?`, [c1])!.tenant_id;
    const t2 = db.get<{ tenant_id: string }>(`SELECT tenant_id FROM contracts WHERE id = ?`, [c2])!.tenant_id;
    expect(t1).toBe(t2); // نفس الاسم = نفس الكيان
    db.close();
  });

  test('المتشابهات تُعرض («فهد السالم» و«فهدالسالم») والدمج بقرارٍ يعيد العقود للوجهة', () => {
    const { db, u1, u2 } = seed();
    const c1 = confirmContract(db, contractInput(u1, {
      tenant: 'فهد السالم', idNumber: '', valueHalalas: 600000, depositHalalas: 0,
      start: '2026-01-01', end: '2026-12-31',
    }));
    const c2 = confirmContract(db, contractInput(u2, {
      tenant: 'فهدالسالم', idNumber: '', valueHalalas: 480000, depositHalalas: 0,
      start: '2026-02-01', end: '2027-01-31',
    }));
    const groups = similarTenantGroups(db);
    expect(groups).toHaveLength(1);
    expect(groups[0].tenants).toHaveLength(2);
    mergeTenants(db, groups[0].tenants[0].id, [groups[0].tenants[1].id]);
    const t1 = db.get<{ tenant_id: string; tenant_name: string }>(`SELECT tenant_id, tenant_name FROM contracts WHERE id = ?`, [c1])!;
    const t2 = db.get<{ tenant_id: string; tenant_name: string }>(`SELECT tenant_id, tenant_name FROM contracts WHERE id = ?`, [c2])!;
    expect(t1.tenant_id).toBe(t2.tenant_id);
    expect(t2.tenant_name).toBe(t1.tenant_name); // الاسم توحّد على الوجهة
    const alive = db.all(`SELECT id FROM tenants WHERE deleted_at IS NULL AND name LIKE '%السالم%'`);
    expect(alive).toHaveLength(1);
    db.close();
  });

  test('رقم الهوية فريد بنيوياً: إدراج مباشر مكرَّر يُرفض من القاعدة نفسها', () => {
    const { db } = seed();
    findOrCreateTenant(db, { name: 'أول', nationalId: '1111111111' });
    expect(() => db.run(
      `INSERT INTO tenants (id, name, national_id, created_at) VALUES ('X2','ثانٍ','1111111111',datetime('now'))`
    )).toThrow();
    db.close();
  });
});
