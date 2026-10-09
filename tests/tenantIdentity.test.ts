/**
 * دراسة القائم (2026-10-09، فجوة عالية) · قرار المالك 2026-08-20: «رقم الهوية مفتاح فريد … عند إنشاء عقد: ابحث بالهوية
 * أولاً · وُجد فاربط، لم يوجد فأنشئ … واعرض المتشابهات لأقرّرها أنا» · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, saveDraft } from '@/domain/contracts/service';

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
