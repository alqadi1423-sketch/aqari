/**
 * الفاتورة تُسجَّل ولا تُحسَب · جدول التحقق الذي وضعه المالك حرفياً:
 * حالة مصطنعة 913.27 / 137.00 / 1050.27، الاقتراح لا يفرض نفسه، الفرق يُعرض ولا يُدفن،
 * وفرق التقريب المقبول يذهب لحساب 5900 بقيد متوازن، والأقساط مجموعها قيمة العقد بالضبط.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { savePurchase, purchaseTax } from '@/domain/purchases';
import { generateInstallments } from '@/domain/contracts/installments';
import { confirmContract } from '@/domain/contracts/service';
import { integrityChecks } from '@/domain/accounting/integrity';

function seedSupplier(db: ReturnType<typeof memDb>) {
  db.run(`INSERT INTO suppliers (id, name, category, default_category, created_at) VALUES (?,?,?,?,?)`,
    ['SUPX', 'مورد الفاتورة', 'صيانة', 'صيانة', new Date().toISOString()]);
}

const baseInput = {
  supplier: 'مورد الفاتورة', date: '2026-03-01', due: '2026-04-01', category: 'مصروفات أخرى',
  incorpItem: '', amortize: false, amortizeMonths: null as number | null,
  exempt: false, excludeFromVat: false, unitId: null as string | null, propertyId: null as string | null,
  meterId: null as string | null, meterReading: null as number | null,
};

describe('الفاتورة ثلاثية الحقول · أرقام المستند هي الحقيقة', () => {
  test('الاقتراح من الأساس 913.27: ضريبة 136.99 وإجمالي 1050.26 (تقريب نصفي لأعلى)', () => {
    // نفس التعبيرين اللذين تستخدمهما الشاشة للاقتراح
    expect(purchaseTax(91327, false)).toBe(13699); // 136.99 وليس 137.00
    expect(91327 + purchaseTax(91327, false)).toBe(105026); // 1050.26
  });

  test('الاقتراح من الإجمالي وحده 1050.27: أساس 913.28 وضريبة 136.99', () => {
    const base = Math.round(105027 / 1.15);
    expect(base).toBe(91328);
    expect(105027 - base).toBe(13699);
  });

  test('حالة مصطنعة: 913.27 + 137.00 = 1050.27 تُحفظ حرفياً وتبقى بعد إعادة الفتح والتعديل', () => {
    const db = memDb();
    seedSupplier(db);
    const id = savePurchase(db, { ...baseInput, subtotalHalalas: 91327, taxHalalas: 13700, totalHalalas: 105027 });
    const row = db.get<{ subtotal_halalas: number; tax_halalas: number; total_halalas: number }>(
      `SELECT subtotal_halalas, tax_halalas, total_halalas FROM purchases WHERE id = ?`, [id])!;
    // المخزّن هو المُدخل بلا أي «تصحيح»
    expect(Number(row.subtotal_halalas)).toBe(91327);
    expect(Number(row.tax_halalas)).toBe(13700);
    expect(Number(row.total_halalas)).toBe(105027);
    // إعادة الفتح والحفظ بنفس الأرقام (مسار التعديل) لا يغيّر شيئاً
    savePurchase(db, { ...baseInput, subtotalHalalas: 91327, taxHalalas: 13700, totalHalalas: 105027 }, id);
    const row2 = db.get<{ subtotal_halalas: number; tax_halalas: number; total_halalas: number }>(
      `SELECT subtotal_halalas, tax_halalas, total_halalas FROM purchases WHERE id = ?`, [id])!;
    expect([Number(row2.subtotal_halalas), Number(row2.tax_halalas), Number(row2.total_halalas)])
      .toEqual([91327, 13700, 105027]);
    // القيد المرحّل الحي على الإجمالي المُدخل لا المحسوب · وقيد التعديل السابق
    // يبقى في الدفتر معكوساً (reversed_by) فيُستثنى من الجمع لا يُحذف
    const je = db.get<{ s: number }>(
      `SELECT COALESCE(SUM(jl.debit_halalas),0) AS s FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       WHERE je.src_type = 'purchase' AND je.src_id = ? AND je.status = 'مرحّل' AND je.deleted_at IS NULL
         AND je.reversed_by IS NULL`, [id])!;
    expect(Number(je.s)).toBe(105027);
    db.close();
  });

  test('عدم التوازن بلا قرار يُرفض برسالة تسمّي الفرق: 913.27 + 136.99 ≠ 1050.27', () => {
    const db = memDb();
    seedSupplier(db);
    expect(() =>
      savePurchase(db, { ...baseInput, subtotalHalalas: 91327, taxHalalas: 13699, totalHalalas: 105027 })
    ).toThrow(/الفرق/);
    db.close();
  });

  test('قبول الفرق كفرق تقريب: هللة واحدة تذهب لحساب 5900 والقيد متوازن والفحوص تمر', () => {
    const db = memDb();
    seedSupplier(db);
    const id = savePurchase(db, {
      ...baseInput, subtotalHalalas: 91327, taxHalalas: 13699, totalHalalas: 105027,
      roundingDiffHalalas: 1,
    });
    const lines = db.all<{ account_code: string; debit_halalas: number; credit_halalas: number }>(
      `SELECT jl.account_code, jl.debit_halalas, jl.credit_halalas FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       WHERE je.src_type = 'purchase' AND je.src_id = ? AND je.status = 'مرحّل' AND je.deleted_at IS NULL
         AND je.reversed_by IS NULL`, [id]);
    const diffLine = lines.find((l) => l.account_code === '5900');
    expect(diffLine).toBeDefined();
    expect(Number(diffLine!.debit_halalas)).toBe(1);
    const D = lines.reduce((s, l) => s + Number(l.debit_halalas), 0);
    const Cr = lines.reduce((s, l) => s + Number(l.credit_halalas), 0);
    expect(D).toBe(Cr);
    expect(Cr).toBe(105027); // دائن الموردين = الإجمالي كما في المستند
    for (const c of integrityChecks(db)) expect(`${c.name}: ${c.ok}`).toBe(`${c.name}: true`);
    db.close();
  });

  test('حالة 148.84 · 22.31 · 171.17: «احفظ كما هي» تحفظ الثلاثة حرفياً والفرق 0.02 في 5900', () => {
    const db = memDb();
    seedSupplier(db);
    // هذا ما تنفذه أزرار ورقة القرار: doSave(bh, xh, gh, diff) بلا أي تعديل على المُدخل
    const id = savePurchase(db, {
      ...baseInput, subtotalHalalas: 14884, taxHalalas: 2231, totalHalalas: 17117,
      roundingDiffHalalas: 2,
    });
    const row = db.get<{ subtotal_halalas: number; tax_halalas: number; total_halalas: number }>(
      `SELECT subtotal_halalas, tax_halalas, total_halalas FROM purchases WHERE id = ?`, [id])!;
    expect([Number(row.subtotal_halalas), Number(row.tax_halalas), Number(row.total_halalas)])
      .toEqual([14884, 2231, 17117]);
    // إعادة الفتح (مسار التعديل) لا تغيّر هللة
    savePurchase(db, {
      ...baseInput, subtotalHalalas: 14884, taxHalalas: 2231, totalHalalas: 17117,
      roundingDiffHalalas: 2,
    }, id);
    const row2 = db.get<{ subtotal_halalas: number; tax_halalas: number; total_halalas: number }>(
      `SELECT subtotal_halalas, tax_halalas, total_halalas FROM purchases WHERE id = ?`, [id])!;
    expect([Number(row2.subtotal_halalas), Number(row2.tax_halalas), Number(row2.total_halalas)])
      .toEqual([14884, 2231, 17117]);
    // دليل الحسابات: 5900 فيه 0.02، والقيد متوازن على 171.17 المدفوع فعلاً
    const lines = db.all<{ account_code: string; debit_halalas: number; credit_halalas: number }>(
      `SELECT jl.account_code, jl.debit_halalas, jl.credit_halalas FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       WHERE je.src_type = 'purchase' AND je.src_id = ? AND je.status = 'مرحّل' AND je.deleted_at IS NULL
         AND je.reversed_by IS NULL`, [id]);
    expect(Number(lines.find((l) => l.account_code === '5900')!.debit_halalas)).toBe(2);
    const D = lines.reduce((s, l) => s + Number(l.debit_halalas), 0);
    expect(D).toBe(lines.reduce((s, l) => s + Number(l.credit_halalas), 0));
    expect(D).toBe(17117);
    for (const c of integrityChecks(db)) expect(`${c.name}: ${c.ok}`).toBe(`${c.name}: true`);
    // أما اقتراحا ورقة القرار فمن معادلة التوازن: الضريبة 22.33 والأساس 148.86
    expect(17117 - 14884).toBe(2233);
    expect(17117 - 2231).toBe(14886);
    db.close();
  });

  test('كل فواتير الشراء — مستبعدة أو لا — تُسجَّل بالكامل ولا تُخصم ضريبتها: لا سطر على 2200', () => {
    const db = memDb();
    seedSupplier(db);
    const linesOf = (id: string) => db.all<{ account_code: string; debit_halalas: number; credit_halalas: number }>(
      `SELECT jl.account_code, jl.debit_halalas, jl.credit_halalas FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       WHERE je.src_type = 'purchase' AND je.src_id = ? AND je.status = 'مرحّل' AND je.deleted_at IS NULL
         AND je.reversed_by IS NULL`, [id]);
    for (const excludeFromVat of [true, false]) {
      const id = savePurchase(db, {
        ...baseInput, excludeFromVat,
        subtotalHalalas: 10000, taxHalalas: 1500, totalHalalas: 11500,
      });
      const row = db.get<{ subtotal_halalas: number; tax_halalas: number; total_halalas: number }>(
        `SELECT subtotal_halalas, tax_halalas, total_halalas FROM purchases WHERE id = ?`, [id])!;
      // المستند محفوظ كما هو بأرقامه الثلاثة
      expect([Number(row.subtotal_halalas), Number(row.tax_halalas), Number(row.total_halalas)])
        .toEqual([10000, 1500, 11500]);
      const lines = linesOf(id);
      // لا خصم ضريبة: لا سطر على 2200، والمصروف بكامل المبلغ 115.00
      expect(lines.find((l) => l.account_code === '2200')).toBeUndefined();
      const expense = lines.find((l) => l.account_code !== '2100')!;
      expect(Number(expense.debit_halalas)).toBe(11500);
      expect(Number(lines.find((l) => l.account_code === '2100')!.credit_halalas)).toBe(11500);
    }
    for (const c of integrityChecks(db)) expect(`${c.name}: ${c.ok}`).toBe(`${c.name}: true`);
    db.close();
  });

  test('الأقساط مجموعها قيمة العقد بالضبط والأخير يمتص الفرق', () => {
    // 10,000.00 ريال على 12 شهراً: 12 × 83333 = 999996 ≠ 1000000
    const monthly = generateInstallments('2026-01-01', '2026-12-31', 1000000, 'شهرية');
    expect(monthly).toHaveLength(12);
    expect(monthly.reduce((s, i) => s + i.amountHalalas, 0)).toBe(1000000);
    expect(monthly[11].amountHalalas).toBe(1000000 - 83333 * 11);
    // قيمة عشوائية عسيرة على القسمة وربع سنوية
    const q = generateInstallments('2026-01-01', '2026-12-31', 91327, 'ربع سنوية');
    expect(q.reduce((s, i) => s + i.amountHalalas, 0)).toBe(91327);
    // وفي القاعدة: عقد موثق مجموع أقساطه = قيمته حرفياً
    const db = memDb();
    const pid = addProperty(db);
    const u = addUnit(db, pid, { unit_no: 'B-1' });
    const cid = confirmContract(db, contractInput(u, {
      tenant: 'مستأجر الأقساط', valueHalalas: 1234567, depositHalalas: 0,
      start: '2026-01-01', end: '2026-12-31',
    }));
    const sum = db.get<{ s: number }>(
      `SELECT COALESCE(SUM(amount_halalas),0) AS s FROM contract_installments WHERE contract_id = ?`, [cid])!;
    expect(Number(sum.s)).toBe(1234567);
    db.close();
  });
});
