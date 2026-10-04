import { memDb } from './helpers/testDb';
import {
  postEntry,
  postContractDeposit,
  postDepositDeduct,
  postDepositRefund,
  postDepositCarry,
  postReservationDeposit,
  postReservationForfeit,
  postReservationConvert,
  postClaim,
  postClaimCollection,
  postRentCollection,
  postKeyMoneyCommission,
  UnbalancedEntryError,
} from '@/domain/accounting/post';
import { accountBalance, ledgerNet } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';

describe('المحرّك المحاسبي — الأساس', () => {
  test('القاعدة تُزرع بالحسابات التسعة عشر', () => {
    const db = memDb();
    const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM accounts`)!;
    expect(Number(n.n)).toBe(25); // 19 + محتجزات الغير 1260 + فروق التقريب 5900 + ضريبة مدخلات 1270 + أرصدة مستأجرين 2410 + محفظة إيجار 1265 + خصومات ممنوحة 4900
    for (const code of ['2400', '2450', '1250', '4300', '5900', '1270', '2410', '4900']) {
      expect(db.get(`SELECT code FROM accounts WHERE code = ?`, [code])).toBeTruthy();
    }
    db.close();
  });

  test('المحفّز يرفض القيد غير المتوازن داخل القاعدة نفسها', () => {
    const db = memDb();
    // نلتف على postEntry ونحاول الترقية يدوياً — القاعدة هي التي ترفض
    db.transaction(() => {
      db.run(
        `INSERT INTO journal_entries (id,no,date,memo,status,created_at) VALUES ('e1','JE-9999','2026-01-01','','قيد الإنشاء','x')`
      );
      db.run(
        `INSERT INTO journal_lines (id,entry_id,account_code,debit_halalas,credit_halalas) VALUES ('l1','e1','1100',5000,0)`
      );
    });
    expect(() => db.run(`UPDATE journal_entries SET status='مرحّل' WHERE id='e1'`)).toThrow(/غير متوازن/);
    db.close();
  });

  test('سطور القيد المرحّل مجمّدة بمحفّز', () => {
    const db = memDb();
    const e = postEntry(db, {
      date: '2026-01-01',
      memo: 'اختبار',
      lines: [
        { account: '1100', debit: 10000, credit: 0 },
        { account: '4200', debit: 0, credit: 10000 },
      ],
    })!;
    const line = db.get<{ id: string }>(`SELECT id FROM journal_lines WHERE entry_id = ?`, [e.id])!;
    expect(() => db.run(`UPDATE journal_lines SET debit_halalas = 1 WHERE id = ?`, [line.id])).toThrow(/لا يُعدَّل/);
    expect(() => db.run(`DELETE FROM journal_lines WHERE id = ?`, [line.id])).toThrow(/لا يُعدَّل/);
    db.close();
  });

  test('postEntry يرفض غير المتوازن قبل الوصول للقاعدة', () => {
    const db = memDb();
    expect(() =>
      postEntry(db, {
        date: '2026-01-01',
        memo: 'خطأ',
        lines: [
          { account: '1100', debit: 100, credit: 0 },
          { account: '4200', debit: 0, credit: 99 },
        ],
      })
    ).toThrow(UnbalancedEntryError);
    db.close();
  });

  test('الأحداث الأحد عشر تنتج قيودها الصحيحة ومجموع المدين = الدائن دائماً', () => {
    const db = memDb();
    const c = { id: 'C1', contract_no: 'EJ-2026-001', tenant: 'محمد', start: '2026-01-01', deposit: 500000 };

    postContractDeposit(db, c);                                        // 1100/2400
    expect(accountBalance(db, '2400')).toBe(500000);

    postDepositDeduct(db, c, 120000, '2026-06-01');                    // 2400/4300
    expect(accountBalance(db, '2400')).toBe(380000);
    expect(accountBalance(db, '4300')).toBe(120000);

    postDepositRefund(db, c, 380000, '2026-06-02');                    // 2400/1100
    expect(accountBalance(db, '2400')).toBe(0);

    // ترحيل تأمين عند التجديد — لا يغيّر الرصيد
    postContractDeposit(db, { ...c, id: 'C2', contract_no: 'EJ-2026-002' });
    const before2400 = accountBalance(db, '2400');
    postDepositCarry(db, { fromNo: 'EJ-2026-002', toNo: 'EJ-2026-003', toId: 'C3', deposit: 500000, date: '2027-01-01' });
    expect(accountBalance(db, '2400')).toBe(before2400);

    const rv = { id: 'R1', name: 'سالم', deposit: 100000 };
    postReservationDeposit(db, rv);                                    // 1100/2450
    expect(accountBalance(db, '2450')).toBe(100000);
    postReservationForfeit(db, rv);                                    // 2450/4300
    expect(accountBalance(db, '2450')).toBe(0);

    const rv2 = { id: 'R2', name: 'خالد', deposit: 80000 };
    postReservationDeposit(db, rv2);
    postReservationConvert(db, rv2, 'EJ-2026-004');                    // 2450/1200
    expect(accountBalance(db, '2450')).toBe(0);

    const cl = { id: 'CL1', amount: 30000, reason: 'أضرار' };
    postClaim(db, cl);                                                 // 1250/4300
    expect(accountBalance(db, '1250')).toBe(30000);
    postClaimCollection(db, cl);                                       // 1100/1250
    expect(accountBalance(db, '1250')).toBe(0);

    postRentCollection(db, {
      contractId: 'C1', contractNo: 'EJ-2026-001', tenant: 'محمد',
      net: 250000, date: '2026-02-01', period: 'فبر 2026', srcId: 'I1',
    });                                                                // 1100/4200
    expect(accountBalance(db, '4200')).toBe(250000);

    postKeyMoneyCommission(db, {
      id: 'K1', unitLabel: 'B-12', outgoing: 'أ', incoming: 'ب', commission: 50000,
    });                                                                // 1100/4300

    // Σمدين = Σدائن لأي مجموعة عمليات
    const tot = db.get<{ d: number; c: number }>(
      `SELECT SUM(l.debit_halalas) AS d, SUM(l.credit_halalas) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE e.status='مرحّل'`
    )!;
    expect(Number(tot.d)).toBe(Number(tot.c));
    db.close();
  });

  test('إعادة احتساب الأرصدة من الصفر = المعروض (الرصيد مشتق لا مخزَّن)', () => {
    const db = memDb();
    postEntry(db, {
      date: '2026-01-05', memo: 'م1',
      lines: [
        { account: '1100', debit: 77700, credit: 0 },
        { account: '4200', debit: 0, credit: 77700 },
      ],
    });
    postEntry(db, {
      date: '2026-01-06', memo: 'م2',
      lines: [
        { account: '5300', debit: 12300, credit: 0 },
        { account: '1100', debit: 0, credit: 12300 },
      ],
    });
    // احتساب يدوي مستقل
    const manual = db.get<{ net: number }>(
      `SELECT SUM(debit_halalas - credit_halalas) AS net FROM journal_lines WHERE account_code='1100'`
    )!;
    expect(accountBalance(db, '1100')).toBe(Number(manual.net));
    expect(ledgerNet(db, '1100')).toBe(77700 - 12300);
    db.close();
  });

  test('فحوص المطابقة الثمانية تمر على قاعدة سليمة', () => {
    const db = memDb();
    const c = { id: 'C1', contract_no: 'EJ-2026-001', tenant: 'محمد', start: '2026-01-01', deposit: 400000 };
    // عقد سارٍ في القاعدة + قيد تأمينه
    db.transaction(() => {
      db.run(`INSERT INTO properties (id,name,created_at) VALUES ('P1','برج','x')`);
      db.run(`INSERT INTO units (id,property_id,unit_no,created_at) VALUES ('U1','P1','1','x')`);
      db.run(
        `INSERT INTO contracts (id,contract_no,tenant_name,unit_id,value_halalas,start,end,deposit_halalas,status,created_at)
         VALUES ('C1','EJ-2026-001','محمد','U1',1200000,'2026-01-01','2026-12-31',400000,'سارٍ','x')`
      );
    });
    postContractDeposit(db, c);
    const checks = integrityChecks(db);
    expect(checks).toHaveLength(9);
    for (const ch of checks) expect(ch.ok).toBe(true);
    db.close();
  });
});
