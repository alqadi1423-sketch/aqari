/**
 * التحصيل الجماعي والساكنون · بيانات مصطنعة:
 * دفعة واحدة تُوزَّع على الأقساط بترتيب استحقاقها والفائض رصيد دائن (2410 وسجل المستأجر)،
 * وسند القسط يُعثر عليه من التوزيع؛ والمستأجر أول ساكن تلقائياً، والمغادرة تؤرَّخ وتبقى،
 * والساكنون ينتقلون مع التجديد بلا تكرار.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import {
  confirmContract, renewContract, recordBulkRentPayment, paymentForInstallment,
} from '@/domain/contracts/service';
import { addOccupant, occupantsOf, occupantsOfUnit, markOccupantLeft } from '@/domain/occupants';
import { accountBalance, walletCashBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';

function seed() {
  const db = memDb();
  const pid = addProperty(db);
  const u = addUnit(db, pid, { unit_no: 'A-1' });
  const cid = confirmContract(db, contractInput(u, {
    tenant: 'ريم اختبار مصطنع', idNumber: '1000000025', valueHalalas: 2160000, depositHalalas: 0,
    start: '2026-01-01', end: '2026-12-31',
  }));
  const insts = db.all<{ id: string; due_date: string; amount_halalas: number }>(
    `SELECT id, due_date, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  return { db, u, cid, insts };
}

describe('التحصيل الجماعي · دفعة واحدة لا ثلاث', () => {
  test('٦٬٠٠٠ عن ثلاثة أقساط (١٨٠٠×٣ = ٥٤٠٠): تُوزَّع بترتيب الاستحقاق والفائض ٦٠٠ رصيداً دائناً', () => {
    const { db, cid, insts } = seed();
    const three = insts.slice(0, 3).map((i) => i.id);
    const payId = recordBulkRentPayment(db, cid, {
      installmentIds: three, date: '2026-03-15',
      lines: [{ method: 'cash', amountHalalas: 600000 }], notes: '',
    });
    // الأقساط الثلاثة سُدّدت كاملة (180000 لكلٍّ)
    for (const iid of three) {
      const r = db.get<{ paid_halalas: number; status: string }>(
        `SELECT paid_halalas, status FROM contract_installments WHERE id = ?`, [iid])!;
      expect(Number(r.paid_halalas)).toBe(180000);
      expect(r.status).toBe('مدفوعة');
    }
    // دفعة واحدة وقيد واحد
    const pays = db.all(`SELECT id FROM contract_payments WHERE contract_id = ?`, [cid]);
    expect(pays).toHaveLength(1);
    const allocs = db.all<{ amount_halalas: number }>(
      `SELECT amount_halalas FROM payment_allocations WHERE payment_id = ?`, [payId]);
    expect(allocs).toHaveLength(3);
    // الفائض 600.00: في 2410 وفي رصيد المستأجر
    expect(accountBalance(db, '2410')).toBe(60000);
    const credit = db.get<{ credit_halalas: number }>(
      `SELECT t.credit_halalas FROM tenants t JOIN contracts c ON c.tenant_id = t.id WHERE c.id = ?`, [cid])!;
    expect(Number(credit.credit_halalas)).toBe(60000);
    // النقدية دخلت كاملة والدفتر متوازن والفحوص تمر
    expect(walletCashBalance(db)).toBe(600000);
    for (const c of integrityChecks(db)) expect(`${c.name}: ${c.ok}`).toBe(`${c.name}: true`);
    // سند القسط يُعثر عليه من التوزيع
    expect(paymentForInstallment(db, three[1])).toBe(payId);
    db.close();
  });

  test('مبلغ أقل من الأول: يسدَّد جزئياً بترتيب الاستحقاق ولا يمسّ الثاني', () => {
    const { db, cid, insts } = seed();
    recordBulkRentPayment(db, cid, {
      installmentIds: insts.slice(0, 2).map((i) => i.id), date: '2026-03-15',
      lines: [{ method: 'cash', amountHalalas: 100000 }], notes: '',
    });
    const first = db.get<{ paid_halalas: number; status: string }>(
      `SELECT paid_halalas, status FROM contract_installments WHERE id = ?`, [insts[0].id])!;
    expect(Number(first.paid_halalas)).toBe(100000);
    expect(first.status).toBe('مدفوعة جزئياً');
    const second = db.get<{ paid_halalas: number }>(
      `SELECT paid_halalas FROM contract_installments WHERE id = ?`, [insts[1].id])!;
    expect(Number(second.paid_halalas)).toBe(0);
    db.close();
  });
});

describe('ساكنو الوحدة · سجل من سكن ومتى غادر', () => {
  test('المستأجر يُضاف تلقائياً أول ساكن عند التوثيق', () => {
    const { db, cid } = seed();
    const occ = occupantsOf(db, cid);
    expect(occ).toHaveLength(1);
    expect(occ[0].relation).toBe('نفسه');
    expect(occ[0].name).toBe('ريم اختبار مصطنع');
    expect(occ[0].national_id).toBe('1000000025');
    db.close();
  });

  test('إضافة ساكنين وظهورهم في الوحدة، والمغادرة تخرجه من العدد وتبقيه في السجل', () => {
    const { db, cid, u } = seed();
    addOccupant(db, cid, { name: 'ابن اختبار مصطنع', nationalId: '1000000033', relation: 'ابن' });
    addOccupant(db, cid, { name: 'ابنة اختبار مصطنع', nationalId: '1000000041', relation: 'ابنة' });
    expect(occupantsOf(db, cid)).toHaveLength(3);
    expect(occupantsOfUnit(db, u)).toHaveLength(3);
    const son = occupantsOf(db, cid).find((o) => o.relation === 'ابن')!;
    markOccupantLeft(db, son.id, '2026-06-30');
    // خرج من الحاليين وبقي في السجل بتاريخه
    expect(occupantsOfUnit(db, u)).toHaveLength(2);
    const all = occupantsOf(db, cid);
    expect(all).toHaveLength(3);
    expect(all.find((o) => o.id === son.id)!.moved_out).toBe('2026-06-30');
    // الهوية إلزامية
    expect(() => addOccupant(db, cid, { name: 'بلا هوية', nationalId: '' })).toThrow(/رقم هوية/);
    db.close();
  });

  test('التجديد ينقل الساكنين الحاليين دون المغادرين وبلا تكرار للمستأجر', () => {
    // عقد ينتهي قريباً ليتاح تجديده (نافذة التجديد)
    const db = memDb();
    const pid = addProperty(db);
    const u2 = addUnit(db, pid, { unit_no: 'R-1' });
    const cid = confirmContract(db, contractInput(u2, {
      tenant: 'ريم اختبار مصطنع', idNumber: '1000000025', valueHalalas: 2160000, depositHalalas: 0,
      start: '2025-09-01', end: '2026-08-31',
    }));
    addOccupant(db, cid, { name: 'ابن اختبار مصطنع', nationalId: '1000000033', relation: 'ابن' });
    const left = addOccupant(db, cid, { name: 'عامل مغادر', nationalId: '1000000058', relation: 'عامل' });
    markOccupantLeft(db, left, '2026-03-01');
    const newId = renewContract(db, cid, {
      start: '2026-09-01', end: '2027-08-31', valueHalalas: 2160000, cycle: 'شهرية',
      carryDeposit: false, ejarNo: '', services: '', furnished: 0, note: '', depositHalalas: 0,
    } as never);
    const occ = occupantsOf(db, newId);
    expect(occ).toHaveLength(2); // المستأجرة والابن · لا العامل المغادر ولا تكرار «نفسه»
    expect(occ.filter((o) => o.relation === 'نفسه')).toHaveLength(1);
    db.close();
  });
});
