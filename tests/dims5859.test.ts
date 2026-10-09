/**
 * مراجعة التثبيت #58 و#59 · أبعاد القيد بعقده · بيانات مصطنعة:
 *  #٥٨ قيود تحويل العربون بعقدها (كانت تُرحَّل قبل ربط الحجز فتغيب عن التصفية بالعقد)
 *  #٥٩ ترحيل التأمين عند التجديد: سطر الإقفال بأبعاد العقد القديم، فيُقفل التزامه في تصفيته
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, renewContract } from '@/domain/contracts/service';
import { createReservation } from '@/domain/reservations';
import { today, addDays } from '@/domain/dates';

test('#٥٨ قيود تحويل العربون تحمل عقدها', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار عربون مصطنع' }), { unit_no: 'R-58' });
  const rid = createReservation(db, { unitId: u, name: 'حاجز مصطنع', phone: '', depositHalalas: 30000, expiryDate: '2099-01-01' });
  const cid = confirmContract(db, { ...contractInput(u, { tenant: 'مستأجر عربون مصطنع', idNumber: '1000000991', phone: '0500000991',
    valueHalalas: 1200000, start: '2026-01-01', depositHalalas: 0 }), reservationId: rid } as never);
  const lines = db.all<{ c: string | null }>(
    `SELECT l.contract_id AS c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.src_type = 'reservation_convert'`);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every((l) => l.c === cid)).toBe(true);
  db.close();
});

test('#٥٩ ترحيل التأمين يُقفل التزام العقد القديم بأبعاده', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار تأمين مصطنع' }), { unit_no: 'D-59' });
  const end = addDays(today(), 20);
  const old = confirmContract(db, contractInput(u, { tenant: 'مستأجر تأمين مصطنع', idNumber: '1000001007', phone: '0500001007',
    valueHalalas: 1200000, start: addDays(end, -364), end, depositHalalas: 50000 }));
  const nw = renewContract(db, old, { start: addDays(end, 1), end: addDays(end, 365), valueHalalas: 1200000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' } as never);
  const bal = (cid: string) => Number(db.get<{ b: number }>(
    `SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_code = '2400' AND l.contract_id = ? AND e.status = 'مرحّل' AND e.deleted_at IS NULL`, [cid])!.b);
  expect(bal(old)).toBe(0);
  expect(bal(nw)).toBe(50000);
  db.close();
});
