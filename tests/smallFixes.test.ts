/**
 * دراسة القائم · الإصلاحات الصغيرة (قرار المالك 2026-10-09 أولاً ٨) · بيانات مصطنعة:
 *  الإشغال لا يعدّ الوحدة المؤرشفة شاغرة · تنبيه «عقد يقارب الانتهاء» لا يصل لعقدٍ جُدِّد ·
 *  contractEnded بالتاريخ: عقدٌ جُدِّد قبل نهايته لم ينتهِ بعد (قرار 2026-08-22: «والحساب في دالة واحدة») ·
 *  سند القبض لا يُصدر لدفعةٍ ملغاة · فحص المطابقة ٧ يشمل كل المصادر ·
 *  نقل الساكنين بسؤال (قرار 2026-08-20: «يُسأل «هل غادر الساكنون؟» · نعم فيُسجَّل تاريخ مغادرتهم، لا فينتقلون للعقد الجديد»)
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, renewContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment, receiptBlocked } from '@/domain/contracts/cancelPayment';
import { integrityChecks } from '@/domain/accounting/integrity';
import { postEntry } from '@/domain/accounting/post';
import { addOccupant } from '@/domain/occupants';
import { contractEnded, getContract } from '@/domain/contracts/rules';
import { propertyStats, occupancyByDays } from '@/domain/stats';
import { computeReminders } from '@/domain/reminders';
import { today, addDays } from '@/domain/dates';

test('الإشغال لا يعدّ الوحدة المؤرشفة شاغرة', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار إشغال مصطنع' });
  const u1 = addUnit(db, p, { unit_no: 'O-1' });
  const u2 = addUnit(db, p, { unit_no: 'O-2' });
  const T = today();
  confirmContract(db, contractInput(u1, { tenant: 'مستأجر إشغال مصطنع', idNumber: '1000000918', phone: '0500000918',
    start: addDays(T, -30), end: addDays(T, 300), depositHalalas: 0 }));
  db.run(`UPDATE units SET archived = 1 WHERE id = ?`, [u2]);
  const s = propertyStats(db, p, T);
  expect([s.total, s.occupied, s.vacant, s.occupancyPct]).toEqual([1, 1, 0, 100]);
  expect(occupancyByDays(db, addDays(T, -10), T, p).pct).toBe(100);
  db.close();
});

test('العقد المجدَّد قبل نهايته: لا تنبيه انتهاء له · ولم ينتهِ بعد', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار تجديد مصطنع' }), { unit_no: 'N-1' });
  const T = today();
  const end = addDays(T, 20);
  const old = confirmContract(db, contractInput(u, { tenant: 'مستأجر تجديد مصطنع', idNumber: '1000000926', phone: '0500000926',
    start: addDays(end, -364), end, depositHalalas: 0 }));
  expect(computeReminders(db, T).some((r) => r.kind === 'عقد يقارب الانتهاء' && r.entityId === old)).toBe(true);
  renewContract(db, old, { start: addDays(end, 1), end: addDays(end, 365), valueHalalas: 1200000, cycle: 'شهرية', carryDeposit: false,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' } as never);
  expect(computeReminders(db, T).some((r) => r.kind === 'عقد يقارب الانتهاء' && r.entityId === old)).toBe(false);
  expect(contractEnded(getContract(db, old)!, T)).toBe(false);
  expect(contractEnded(getContract(db, old)!, addDays(end, 1))).toBe(true);
  db.close();
});

test('سند القبض لا يُصدر لدفعةٍ ملغاة', () => {
  const db = memDb();
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار سند مصطنع' })),
    { tenant: 'مستأجر سند مصطنع', idNumber: '1000000934', phone: '0500000934', start: '2026-01-01', depositHalalas: 0 }));
  const i = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  recordRentPayment(db, cid, { installmentId: i.id, period: 'الأول', date: '2026-01-05', lines: [{ method: 'cash', amountHalalas: 40000 }], discountHalalas: 0, notes: '' });
  const pid = db.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [cid])!.id;
  expect(receiptBlocked(db, pid)).toBeNull();
  cancelPayment(db, pid, { date: '2026-01-06', reason: 'إلغاء مصطنع' });
  expect(receiptBlocked(db, pid)).toBeTruthy();
  db.close();
});

test('فحص المطابقة ٧ يشمل كل المصادر: الأصول وسداد الفاتورة لا الإيجار وحده', () => {
  const lines = [{ account: '1100', debit: 1000, credit: 0 }, { account: '3100', debit: 0, credit: 1000 }];
  for (const srcType of ['asset_cost', 'invoice_pay', 'asset_catchup']) {
    const db = memDb();
    const check7 = () => integrityChecks(db).find((c) => c.name === 'لا قيود يتيمة لمصادر محذوفة')!;
    expect(check7().ok).toBe(true);
    postEntry(db, { date: '2026-02-01', memo: 'قيد يتيم مصطنع', lines, srcType, srcId: 'MISSING-' + srcType });
    expect(check7().ok).toBe(false);
    db.close();
  }
});

test('التجديد يسأل «هل غادر الساكنون؟»: نعم فتُسجَّل مغادرتهم بنهاية العقد، ولا فينتقلون', () => {
  const run = (left: boolean | undefined) => {
    const db = memDb();
    const u = addUnit(db, addProperty(db, { name: 'عقار ساكنين مصطنع' }), { unit_no: 'S-1' });
    const T = today();
    const end = addDays(T, 20);
    const old = confirmContract(db, contractInput(u, { tenant: 'مستأجر ساكنين مصطنع', idNumber: '1000000942', phone: '0500000942',
      start: addDays(end, -364), end, depositHalalas: 0 }));
    addOccupant(db, old, { name: 'ساكن مصطنع', nationalId: '1000000959', phone: '', relation: 'ابن', movedIn: addDays(end, -364) } as never);
    const nw = renewContract(db, old, { start: addDays(end, 1), end: addDays(end, 365), valueHalalas: 1200000, cycle: 'شهرية', carryDeposit: false,
      extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '', occupantsLeft: left } as never);
    const r = {
      moved: db.all<{ relation: string }>(`SELECT relation FROM occupants WHERE contract_id = ? AND deleted_at IS NULL ORDER BY relation`, [nw]).map((o) => o.relation),
      leftOn: db.get<{ d: string | null }>(`SELECT moved_out AS d FROM occupants WHERE contract_id = ? AND relation = 'ابن'`, [old])?.d ?? null,
      end,
    };
    db.close();
    return r;
  };
  const yes = run(true);
  expect(yes.moved).toEqual(['نفسه']);
  expect(yes.leftOn).toBe(yes.end);
  const no = run(false);
  expect(no.moved.sort()).toEqual(['ابن', 'نفسه'].sort());
  expect(no.leftOn).toBeNull();
});
