/**
 * المعالجة الضريبية والإقرار وميزان المراجعة · بيانات مصطنعة:
 * المعيار الوحيد اسم الفاتورة — ثلاثة مصاريف مختلفة بفواتير ليست باسمنا تُسجَّل كاملة
 * ولا يدخل شيء منها البند ٧؛ والقابلة للخصم تفتح 1270 وتُقفل بالاسترداد؛
 * والميزان مدينه يساوي دائنه ويطابق كشوف الحسابات.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { savePurchase, markVatFiled, markVatRefunded, markVatRejected, taxPeriodOf } from '@/domain/purchases';
import { saveInvoice } from '@/domain/invoices';
import { vatReturnData, quarterRange } from '@/domain/vatReturn';
import { trialBalance, accountBalance, walletCashBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';

const base = {
  date: '2026-02-10', due: '2026-03-10', incorpItem: '', amortize: false, amortizeMonths: null as number | null,
  exempt: false, excludeFromVat: false, unitId: null as string | null, propertyId: null as string | null,
  meterId: null as string | null, meterReading: null as number | null,
};

function seed() {
  const db = memDb();
  db.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['S1', 'مورد عام', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  db.run(`INSERT INTO suppliers (id, name, category, default_category, created_at) VALUES (?,?,?,?,?)`,
    ['S2', 'مورد بلا رقم', 'صيانة', 'صيانة', new Date().toISOString()]);
  return db;
}

describe('المعيار الوحيد: هل الفاتورة باسم المنشأة؟', () => {
  test('ثلاثة مصاريف مختلفة (كهرباء · سباكة · أجور نظافة) ليست باسمنا: كاملة المبلغ ولا 1270 ولا 2200', () => {
    const db = seed();
    const cases: Array<[string, string]> = [
      ['كهرباء', 'الفاتورة باسم المالك'],
      ['مصروفات أخرى', 'المورد غير مسجَّل في الضريبة'],
      ['رواتب', 'إيصال لا فاتورة ضريبية'],
    ];
    for (const [category, reason] of cases) {
      const id = savePurchase(db, {
        ...base, supplier: 'مورد عام', category,
        taxStatus: 'غير قابلة للخصم', excludeReason: reason,
        subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000,
      });
      const lines = db.all<{ account_code: string; debit_halalas: number }>(
        `SELECT jl.account_code, jl.debit_halalas FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE je.src_id = ? AND je.deleted_at IS NULL AND jl.debit_halalas > 0`, [id]);
      // مدين واحد: مصروف الفئة بالمبلغ الكامل ١١٥٠٫٠٠
      expect(lines).toHaveLength(1);
      expect(['1270', '2200']).not.toContain(lines[0].account_code);
      expect(Number(lines[0].debit_halalas)).toBe(115000);
      const row = db.get<{ exclude_reason: string; tax_status: string }>(
        `SELECT exclude_reason, tax_status FROM purchases WHERE id = ?`, [id])!;
      expect(row.tax_status).toBe('غير قابلة للخصم');
      expect(row.exclude_reason).toBe(reason);
    }
    expect(accountBalance(db, '1270')).toBe(0);
    db.close();
  });

  test('الافتراض مستبعدة ما لم يُحدَّد · و«قابلة للخصم» بلا رقم ضريبي تُرفض بجملة', () => {
    const db = seed();
    const id = savePurchase(db, {
      ...base, supplier: 'مورد عام', category: 'صيانة',
      subtotalHalalas: 10000, taxHalalas: 1500, totalHalalas: 11500,
    });
    expect(db.get<{ tax_status: string }>(`SELECT tax_status FROM purchases WHERE id = ?`, [id])!.tax_status)
      .toBe('غير قابلة للخصم');
    expect(() => savePurchase(db, {
      ...base, supplier: 'مورد بلا رقم', category: 'صيانة', taxStatus: 'فاتورة ضريبية · قابلة للخصم',
      subtotalHalalas: 10000, taxHalalas: 1500, totalHalalas: 11500,
    })).toThrow(/بلا رقم ضريبي في بطاقته/);
    db.close();
  });

  test('القابلة للخصم: المصروف بالأساس والضريبة في 1270، ثم تقديم واسترداد يُقفلها', () => {
    const db = seed();
    const id = savePurchase(db, {
      ...base, supplier: 'مورد عام', category: 'صيانة',
      taxStatus: 'فاتورة ضريبية · قابلة للخصم',
      subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000,
    });
    expect(accountBalance(db, '1270')).toBe(15000); // مدين مفتوح
    const wallet0 = walletCashBalance(db);
    markVatFiled(db, id);
    expect(db.get<{ refund_status: string }>(`SELECT refund_status FROM purchases WHERE id = ?`, [id])!.refund_status)
      .toBe('مُقدَّم في إقرار ' + taxPeriodOf('2026-02-10'));
    markVatRefunded(db, id, '2026-05-01');
    expect(accountBalance(db, '1270')).toBe(0); // أُقفل
    expect(walletCashBalance(db)).toBe(wallet0 + 15000);
    expect(() => markVatRefunded(db, id, '2026-05-02')).toThrow(/مسترَدة من قبل/);
    for (const c of integrityChecks(db)) expect(`${c.name}: ${c.ok}`).toBe(`${c.name}: true`);
    db.close();
  });

  test('رفض الاسترداد: الضريبة تصير جزءاً من التكلفة و1270 يُقفل', () => {
    const db = seed();
    const id = savePurchase(db, {
      ...base, supplier: 'مورد عام', category: 'مصروفات أخرى',
      taxStatus: 'فاتورة ضريبية · قابلة للخصم',
      subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000,
    });
    const exp0 = accountBalance(db, '5400');
    markVatRejected(db, id, '2026-05-01');
    expect(accountBalance(db, '1270')).toBe(0);
    expect(accountBalance(db, '5400')).toBe(exp0 + 15000);
    db.close();
  });
});

describe('الإقرار الضريبي · البند ٧ لا يشمل المستبعدة إطلاقاً', () => {
  test('ربع 2026-Q1 مبني من المصادر الصحيحة والمستبعدة في سطر رقابة بعددها ومبلغها', () => {
    const db = seed();
    const pid = addProperty(db);
    const u = addUnit(db, pid, { unit_no: 'A-1' });
    const cid = confirmContract(db, contractInput(u, {
      tenant: 'مستأجر سكني', valueHalalas: 1200000, depositHalalas: 0,
      start: '2026-01-01', end: '2026-12-31',
    }));
    const inst = db.get<{ id: string }>(
      `SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
    recordRentPayment(db, cid, {
      installmentId: inst.id, date: '2026-02-05', period: 'فبراير',
      lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '',
    });
    saveInvoice(db, {
      customer: 'عميل تجاري', customerVat: '311111111100003', issue: '2026-02-01', due: '2026-03-01', notes: '',
      lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 200000, taxPct: 15 }],
    }, 'مستحقة');
    // قابلة للخصم + ثلاث مستبعدات
    savePurchase(db, {
      ...base, supplier: 'مورد عام', category: 'صيانة',
      taxStatus: 'فاتورة ضريبية · قابلة للخصم',
      subtotalHalalas: 50000, taxHalalas: 7500, totalHalalas: 57500,
    });
    for (const r of ['الفاتورة باسم المالك', 'المورد غير مسجَّل في الضريبة', 'إيصال لا فاتورة ضريبية']) {
      savePurchase(db, {
        ...base, supplier: 'مورد عام', category: 'كهرباء',
        taxStatus: 'غير قابلة للخصم', excludeReason: r,
        subtotalHalalas: 20000, taxHalalas: 3000, totalHalalas: 23000,
      });
    }
    const d = vatReturnData(db, 2026, 1);
    expect(quarterRange(2026, 1)).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    const item = (no: string) => d.items.find((i) => i.no === no)!;
    expect(item('1').amountHalalas).toBe(200000);
    expect(item('1').taxHalalas).toBe(30000);
    expect(item('5').amountHalalas).toBe(100000); // الإيجار السكني المعفى
    expect(item('7').amountHalalas).toBe(50000); // القابلة للخصم وحدها
    expect(item('7').taxHalalas).toBe(7500);
    expect(item('13').taxHalalas).toBe(30000 - 7500);
    expect(item('16').taxHalalas).toBe(22500);
    // سطر الرقابة: ثلاث مستبعدات بمبلغها الكامل
    expect(d.excluded.count).toBe(3);
    expect(d.excluded.amountHalalas).toBe(3 * 23000);
    expect(d.schedules.deductiblePurchases).toHaveLength(1);
    expect(d.schedules.deductiblePurchases[0].supplierVatno).toBe('310999999900003');
    expect(d.schedules.excludedPurchases).toHaveLength(3);
    expect(d.schedules.exemptSales).toHaveLength(1);
    db.close();
  });
});

describe('ميزان المراجعة', () => {
  test('المدين = الدائن، وأول المدة + الحركة = آخر المدة، ويطابق رصيد الحساب', () => {
    const db = seed();
    const pid = addProperty(db);
    const u = addUnit(db, pid, { unit_no: 'B-1' });
    const cid = confirmContract(db, contractInput(u, {
      tenant: 'مستأجر الميزان', valueHalalas: 600000, depositHalalas: 50000,
      start: '2026-01-01', end: '2026-12-31',
    }));
    const inst = db.get<{ id: string }>(
      `SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
    recordRentPayment(db, cid, {
      installmentId: inst.id, date: '2026-02-05', period: 'فبراير',
      lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '',
    });
    const rows = trialBalance(db, '2026-02-01', '2026-02-28');
    const totD = rows.reduce((s, r) => s + r.debitHalalas, 0);
    const totC = rows.reduce((s, r) => s + r.creditHalalas, 0);
    expect(totD).toBe(totC);
    expect(totD).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.openingHalalas + r.debitHalalas - r.creditHalalas).toBe(r.closingHalalas);
    }
    // مطابقة كشف الحساب: رصيد النقدية آخر المدة (بلا حركة بعدها) = الرصيد المشتق
    const cashRow = rows.find((r) => r.code === '1100')!;
    expect(cashRow.closingHalalas).toBe(accountBalance(db, '1100'));
    db.close();
  });
});

describe('عينات الإقرار للحكم على الحاسوب · ثلاث صيغ لنفس التقرير', () => {
  test('تُكتب xlsx وdocx وHTML (يُحوَّل PDF) لربع مبذور', async () => {
    const outDir = process.env.PRINT_SAMPLES_DIR;
    if (!outDir) { expect(true).toBe(true); return; }
    const fsN = await import('node:fs');
    const pathN = await import('node:path');
    const { buildXlsx, buildDocx, PRINT_CSS_SHIM } = { ...(await import('@/domain/officeBuild')), PRINT_CSS_SHIM: (await import('@/domain/printDocs')).PRINT_CSS };
    type RB = import('@/domain/officeBuild').ReportBlock;
    const M = (h: number) => ({ money: h });
    const db = seed();
    const pid = addProperty(db);
    const u = addUnit(db, pid, { unit_no: 'A-1' });
    const cid = confirmContract(db, contractInput(u, {
      tenant: 'سلمى كمال بن حامد الفلاني', valueHalalas: 2520000, depositHalalas: 0,
      start: '2026-01-01', end: '2026-12-31',
    }));
    const inst = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
    recordRentPayment(db, cid, { installmentId: inst.id, date: '2026-02-05', period: 'فبراير', lines: [{ method: 'cash', amountHalalas: 210000 }], discountHalalas: 0, notes: '' });
    saveInvoice(db, { customer: 'شركة الأمل للتجارة', customerVat: '311111111100003', issue: '2026-02-01', due: '2026-03-01', notes: '', lines: [{ descr: 'إيجار مكتب تجاري', qty: 1, priceHalalas: 500000, taxPct: 15 }] }, 'مستحقة');
    savePurchase(db, { ...base, supplier: 'مورد عام', category: 'صيانة', taxStatus: 'فاتورة ضريبية · قابلة للخصم', subtotalHalalas: 80000, taxHalalas: 12000, totalHalalas: 92000 });
    savePurchase(db, { ...base, supplier: 'مورد عام', category: 'كهرباء', taxStatus: 'غير قابلة للخصم', excludeReason: 'الفاتورة باسم المالك', subtotalHalalas: 30000, taxHalalas: 4500, totalHalalas: 34500 });
    savePurchase(db, { ...base, supplier: 'مورد عام', category: 'مصروفات أخرى', taxStatus: 'غير قابلة للخصم', excludeReason: 'إيصال لا فاتورة ضريبية', subtotalHalalas: 11500, taxHalalas: 0, totalHalalas: 11500 });
    const d = vatReturnData(db, 2026, 1);
    db.close();
    const main: RB = {
      heading: 'نموذج الإقرار · ' + d.period,
      meta: [['الفترة', d.from + ' إلى ' + d.to], ['أعمدة الإفصاح الذاتي والتعديل', 'تُملأ يدوياً']],
      sections: [{ title: 'بنود الإقرار', sum: false,
        header: ['#', 'البند', 'المبلغ', 'مبلغ الضريبة', 'الإفصاح الذاتي', 'مبلغ التعديل', 'سبب التعديل'],
        rows: d.items.map((i) => [i.no, i.label + (i.manual ? ' (يدوي)' : ''), M(i.amountHalalas), M(i.taxHalalas), '', '', '']) }],
      totals: [
        ['فواتير مستبعدة من الإقرار خلال الفترة (لا تدخل البند ٧)', String(d.excluded.count) + ' فاتورة'],
        ['مبلغ المستبعدة شاملاً ضريبتها غير المخصومة', M(d.excluded.amountHalalas), true],
      ],
    };
    const sched: RB = {
      heading: 'الكشوف المساندة', meta: [],
      sections: [
        { title: 'المشتريات الخاضعة باسم المنشأة', sum: true, header: ['الرقم', 'التاريخ', 'المورد', 'رقمه الضريبي', 'قبل الضريبة', 'الضريبة', 'الإجمالي'],
          rows: d.schedules.deductiblePurchases.map((r) => [r.no, r.date, r.supplier, r.supplierVatno, M(r.subtotal), M(r.tax), M(r.total)]) },
        { title: 'المستبعدة من الإقرار', sum: true, header: ['الرقم', 'التاريخ', 'المورد', 'قبل الضريبة', 'الضريبة (ضمن التكلفة)', 'الإجمالي', 'سبب الاستبعاد'],
          rows: d.schedules.excludedPurchases.map((r) => [r.no, r.date, r.supplier, M(r.subtotal), M(r.tax), M(r.total), r.reason]) },
        { title: 'المبيعات المعفاة · الإيجار السكني', sum: true, header: ['التاريخ', 'المستأجر', 'العقد', 'الوحدة', 'المحصَّل'],
          rows: d.schedules.exemptSales.map((r) => [r.date, r.tenant, r.contractNo, r.unitLabel, M(r.net)]) },
      ], totals: [],
    };
    fsN.mkdirSync(outDir, { recursive: true });
    fsN.writeFileSync(pathN.join(outDir, 'الإقرار-الضريبي-2026-Q1.xlsx'), buildXlsx([
      { name: 'الملخص', blocks: [main] }, { name: 'الكشوف المساندة', blocks: [sched] },
    ]));
    fsN.writeFileSync(pathN.join(outDir, 'الإقرار-الضريبي-2026-Q1.docx'),
      buildDocx('الإقرار الضريبي · 2026-Q1', d.from + ' إلى ' + d.to, [main, sched], 'صدر عبر تطبيق عقاري · أحد حلول منصة رِكز', ['المحاسب', 'المدير']));
    const esc2 = (x: unknown) => String(x ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    const cellS = (c: unknown) => (typeof c === 'object' && c ? ((c as { money: number }).money / 100).toFixed(2) : String(c ?? ''));
    const tbl = (h: string[], rows: unknown[][]) => `<table><thead><tr>${h.map((x) => `<th>${esc2(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${(r as unknown[]).map((c) => `<td class="num">${esc2(cellS(c))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    const html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><style>${PRINT_CSS_SHIM}</style></head><body>
      <div style="position:fixed;top:38%;left:0;right:0;text-align:center;transform:rotate(-28deg);font-size:96px;color:rgba(176,141,61,.14);font-weight:800">مسودة</div>
      <h2>الإقرار الضريبي · ${d.period} (مسودة)</h2>
      ${tbl(['#', 'البند', 'المبلغ', 'مبلغ الضريبة'], d.items.map((i) => [i.no, i.label, { money: i.amountHalalas }, { money: i.taxHalalas }]))}
      <h3>فواتير مستبعدة من الإقرار: ${d.excluded.count} فاتورة بمبلغ ${(d.excluded.amountHalalas / 100).toFixed(2)} — لا تدخل البند ٧</h3>
      <h3>المشتريات الخاضعة باسم المنشأة (${d.schedules.deductiblePurchases.length})</h3>
      ${tbl(['الرقم', 'التاريخ', 'المورد', 'الرقم الضريبي', 'قبل الضريبة', 'الضريبة', 'الإجمالي'], d.schedules.deductiblePurchases.map((r) => [r.no, r.date, r.supplier, r.supplierVatno, { money: r.subtotal }, { money: r.tax }, { money: r.total }]))}
      <h3>المستبعدة (${d.schedules.excludedPurchases.length})</h3>
      ${tbl(['الرقم', 'التاريخ', 'المورد', 'الإجمالي', 'السبب'], d.schedules.excludedPurchases.map((r) => [r.no, r.date, r.supplier, { money: r.total }, r.reason]))}
    </body></html>`;
    fsN.writeFileSync(pathN.join(outDir, 'الإقرار-الضريبي-2026-Q1.html'), html, 'utf8');
    expect(fsN.existsSync(pathN.join(outDir, 'الإقرار-الضريبي-2026-Q1.xlsx'))).toBe(true);
  });
});
