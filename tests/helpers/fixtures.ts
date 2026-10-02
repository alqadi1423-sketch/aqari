import type { DB } from '@/db/adapter';
import { uid } from '@/domain/ids';

export function addProperty(
  db: DB,
  over: Partial<{
    id: string; name: string; activity_type: string; activity_subtype: string;
    ownership: string; lease_start: string; lease_end: string; floors: number;
  }> = {}
): string {
  const id = over.id ?? 'P_' + uid();
  db.run(
    `INSERT INTO properties (id, name, activity_type, activity_subtype, ownership, lease_start, lease_end, floors, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, over.name ?? 'عقار اختبار', over.activity_type ?? '', over.activity_subtype ?? '',
     over.ownership ?? 'ملك', over.lease_start ?? null, over.lease_end ?? null, over.floors ?? 2,
     new Date().toISOString()]
  );
  return id;
}

export function addUnit(
  db: DB,
  propertyId: string,
  over: Partial<{ id: string; unit_no: string; floor: string; type: string; subtype: string; rent: number }> = {}
): string {
  const id = over.id ?? 'U_' + uid();
  db.run(
    `INSERT INTO units (id, property_id, unit_no, floor, type, subtype, rent_monthly_halalas, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, propertyId, over.unit_no ?? 'A-' + id.slice(-6), over.floor ?? 'الأرضي',
     over.type ?? 'سكني', over.subtype ?? '', over.rent ?? 100000, new Date().toISOString()]
  );
  return id;
}

export function addBank(db: DB, name = 'بنك الاختبار', opening = 0): string {
  const id = 'B_' + uid();
  db.run(
    `INSERT INTO banks (id, name, opening_halalas, opening_date, created_at) VALUES (?,?,?,?,?)`,
    [id, name, opening, '2026-01-01', new Date().toISOString()]
  );
  return id;
}

export function contractInput(unitId: string, over: Partial<{
  tenant: string; phone: string; idNumber: string; valueHalalas: number; cycle: string;
  start: string; end: string; depositHalalas: number; ejarNo: string;
}> = {}) {
  return {
    tenant: over.tenant ?? 'مستأجر اختبار',
    phone: over.phone ?? '0555555555',
    idNumber: over.idNumber ?? '1000000001',
    unitId,
    valueHalalas: over.valueHalalas ?? 2400000,
    cycle: over.cycle ?? 'شهرية',
    start: over.start ?? '2026-01-01',
    end: over.end ?? '2026-12-31',
    depositHalalas: over.depositHalalas ?? 200000,
    ejarNo: over.ejarNo ?? '',
    services: '',
    furnished: 'غير مؤثثة',
    typeSpecific: {},
  };
}
