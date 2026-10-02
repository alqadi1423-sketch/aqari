/**
 * البند ٧ · الخصم يُطرح في كل موضع يحسب متبقّياً أو متأخراً أو يبني حالة قسط.
 * حالتان مصطنعتان: قسط ٢٬٤٨٠ مسدَّد ٢٬٢٦٠ وخصم ٢٢٠ · وقسط ١٬٢٠٠ مسدَّد ٤٧٠ وخصم ٧٣٠ · كلاهما مدفوع بالكامل.
 * وكانت الشاشة تقرأ المسدَّد وحده فتُظهرهما متأخرَين.
 */
import { memDb } from './helpers/testDb';
import { confirmContract, recordRentPayment, recordBulkRentPayment } from '@/domain/contracts/service';
import { allInstallments, collectKpis, tenantOutstanding } from '@/domain/stats';
import { installmentRemaining, installmentStoredStatus } from '@/domain/contracts/installments';
import { uid } from '@/domain/ids';
import type { DB } from '@/db/adapter';

const T = '2026-08-15';

function seedContract(db: DB, tenant: string, monthlyHalalas: number): string {
  const now = new Date().toISOString();
  const pid = uid();
  db.run(`INSERT INTO properties (id, name, created_at) VALUES (?,?,?)`, [pid, 'برج الاختبار', now]);
  const u = uid();
  db.run(`INSERT INTO units (id, property_id, unit_no, type, rent_monthly_halalas, created_at) VALUES (?,?,?,?,?,?)`,
    [u, pid, 'A-' + tenant, 'شقة', monthlyHalalas, now]);
  return confirmContract(db, {
    unitId: u, tenant, phone: '0500000000', idNumber: '10' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
    start: '2026-01-01', end: '2027-01-01',
    valueHalalas: monthlyHalalas * 12, depositHalalas: 0, cycle: 'شهرية', furnished: 'غير مؤثثة',
    ejarNo: '', services: '', typeSpecific: {},
  });
}

const firstInst = (db: DB, cid: string) => db.get<{ id: string; amount_halalas: number }>(
  `SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;

describe('البند ٧ · المتبقّي = القسط ناقص المسدَّد ناقص الخصم', () => {
  test('القاعدة الواحدة', () => {
    expect(installmentRemaining(248000, 226000, 22000)).toBe(0);
    expect(installmentRemaining(120000, 47000, 73000)).toBe(0);
    expect(installmentRemaining(120000, 47000, 0)).toBe(73000);
    expect(installmentStoredStatus(248000, 226000, 22000)).toBe('مدفوعة');
    expect(installmentStoredStatus(120000, 47000, 0)).toBe('مدفوعة جزئياً');
  });

  test('حالة مصطنعة: ٢٬٤٨٠ مسدَّد ٢٬٢٦٠ وخصم ٢٢٠ · مدفوعة لا متأخرة · والخصم بندٌ ظاهر', () => {
    const db = memDb();
    const cid = seedContract(db, 'سلوى التجريبية', 248000);
    const inst = firstInst(db, cid);
    recordRentPayment(db, cid, {
      // المقبوض ٢٬٢٦٠ وخصم ٢٢٠ بعد الاستحقاق · فالمسدَّد ٢٬٢٦٠ والخصم في الدفتر ٢٢٠
      installmentId: inst.id, date: '2026-06-09', period: 'يونيو', discountHalalas: 22000, notes: '',
      discountKind: 'بعد الاستحقاق', lines: [{ method: 'cash', amountHalalas: 226000 }],
    });
    const row = db.get<{ paid_halalas: number; status: string }>(
      `SELECT paid_halalas, status FROM contract_installments WHERE id = ?`, [inst.id])!;
    expect(Number(row.paid_halalas)).toBe(226000);   // المسدَّد نقدٌ صافٍ · الخصم لم يُطوَ فيه
    expect(row.status).toBe('مدفوعة');               // الحالة المخزَّنة تعرف الخصم
    const v = allInstallments(db, T).find((x) => x.installmentId === inst.id)!;
    expect(v.discount).toBe(22000);
    expect(v.remaining).toBe(0);
    expect(v.displayStatus).toBe('مدفوعة');
    expect(v.cls).toBe('paid');
    db.close();
  });

  test('حالة مصطنعة: ١٬٢٠٠ مسدَّد ٤٧٠ وخصم ٧٣٠ · لا يدخل في المتأخر ولا في رصيد المستأجر', () => {
    const db = memDb();
    const cid = seedContract(db, 'رهف التجريبية', 120000);
    const inst = firstInst(db, cid);
    recordRentPayment(db, cid, {
      installmentId: inst.id, date: '2026-07-08', period: 'يوليو', discountHalalas: 73000, notes: '',
      discountKind: 'بعد الاستحقاق', lines: [{ method: 'cash', amountHalalas: 47000 }],
    });
    const all = allInstallments(db, T);
    const k = collectKpis(all, T);
    const late = all.filter((x) => x.remaining > 0 && x.daysLate > 0);
    expect(late.some((x) => x.installmentId === inst.id)).toBe(false);
    // الأقساط الأخرى (فبراير ← أغسطس) متأخرة فعلاً · أما المخصوم فلا
    expect(k.lateCount).toBe(late.length);
    const outstanding = tenantOutstanding(db, 'رهف التجريبية');
    const others = all.filter((x) => x.contractId === cid && x.installmentId !== inst.id).reduce((s, x) => s + x.remaining, 0);
    expect(outstanding).toBe(others);
    db.close();
  });

  test('التحصيل الجماعي بعد خصمٍ سابق: لا يُعاد تحصيل ما خُصم', () => {
    const db = memDb();
    const cid = seedContract(db, 'بدر', 100000);
    const [i1, i2] = db.all<{ id: string; amount_halalas: number }>(
      `SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 2`, [cid]);
    // القسط الأول: ٣٠٠ نقداً وخصم ٧٠٠ · تمّ
    recordRentPayment(db, cid, {
      installmentId: i1.id, date: '2026-02-01', period: 'فبراير', discountHalalas: 70000, notes: '',
      discountKind: 'بعد الاستحقاق', lines: [{ method: 'cash', amountHalalas: 30000 }],
    });
    // دفعة جماعية ١٬٠٠٠ على القسطَين · يجب أن تذهب كلها للثاني لأن الأول لم يبقَ عليه شيء
    recordBulkRentPayment(db, cid, {
      installmentIds: [i1.id, i2.id], date: '2026-03-01', notes: '',
      lines: [{ method: 'cash', amountHalalas: 100000 }],
    });
    const a1 = db.get<{ paid_halalas: number; status: string }>(`SELECT paid_halalas, status FROM contract_installments WHERE id = ?`, [i1.id])!;
    const a2 = db.get<{ paid_halalas: number; status: string }>(`SELECT paid_halalas, status FROM contract_installments WHERE id = ?`, [i2.id])!;
    expect(Number(a1.paid_halalas)).toBe(30000);
    expect(a1.status).toBe('مدفوعة');
    expect(Number(a2.paid_halalas)).toBe(100000);
    expect(a2.status).toBe('مدفوعة');
    db.close();
  });
});
