/**
 * مولّدا العينات للحكم البصري على الحاسوب (المراجعة الشاملة 2026-11-13 · G-15): كانا اختبارين في tests/ ينجحان دائماً حين يغيب
 * PRINT_SAMPLES_DIR (`expect(true).toBe(true)`)، فيزيدان العدد الأخضر بلا فحص · فنُقلا هنا مولّدين صريحين، ويفشلان بلا المجلد.
 * الاستعمال:
 *   PRINT_SAMPLES_DIR=<مجلد> npx jest --roots '<rootDir>/scripts' --testRegex 'samples[.]ts$'
 * ثم تُحوَّل ملفات HTML إلى PDF على الحاسوب · بيانات مصطنعة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { memDb } from '../../tests/helpers/testDb';
import { addProperty, addUnit, contractInput } from '../../tests/helpers/fixtures';
import {
  buildReceiptDoc, buildInvoiceDoc, buildStatementDoc, buildContractDoc, buildHandoverDoc, PRINT_CSS, type CompanyInfo,
} from '@/domain/printDocs';
import type { HandoverSection } from '@/domain/handover/build';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { savePurchase } from '@/domain/purchases';
import { saveInvoice } from '@/domain/invoices';
import { vatReturnData } from '@/domain/vatReturn';

/** مجلد العينات · بلا مجلدٍ لا يُكتب شيءٌ ولا يُظن أنه كُتب */
function samplesDir(): string {
  const d = process.env.PRINT_SAMPLES_DIR;
  if (!d) throw new Error('PRINT_SAMPLES_DIR غير مضبوط · اكتب مجلد العينات');
  return d;
}

const CO: CompanyInfo = {
  name: 'مكتب النخيل العقاري', vatno: '310123456700003', cr: '1010445566',
  phone: '0501234567', address: 'الرياض · حي الملقا', vatEnabled: true,
};
const NOW = '20/08/2026 04:15';
const receipt = {
  no: 'RCP-2026-0043', tenantName: 'سلمى كمال بن حامد الفلاني', contractNo: '20260012345',
  unitLabel: 'برج النخيل · A-1', date: '2026-08-20', period: 'أغسطس', methodLabel: 'نقداً',
  notes: '', grossHalalas: 400000, discountHalalas: 0, netHalalas: 400000,
};

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

describe('نماذج الحكم البصري · خمسة ملفات HTML للتحويل PDF على الحاسوب', () => {
  test('تُكتب الخمسة إلى مجلد النماذج', () => {
    const outDir = samplesDir();
    fs.mkdirSync(outDir, { recursive: true });
    const db = memDb();
    // القالب المرجعي القديم نصاً للنموذج · لا قالب يُزرع في القاعدة
    const { LEGACY_HANDOVER_TEMPLATE } = require('@/db/seed') as { LEGACY_HANDOVER_TEMPLATE: Array<{ section: string; items: string[] }> };
    const tpl = LEGACY_HANDOVER_TEMPLATE;
    const sections: HandoverSection[] = tpl
      ? tpl.map((s) => ({
          section: s.section,
          items: s.items.map((n) => ({ name: n, count: '1', receiveCondition: 'سليم', deliverCondition: '', notes: '' })),
        }))
      : [];
    db.close();
    const wrap = (title: string, body: string) =>
      `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>${title}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
    const stRows = [];
    for (let i = 0; i < 18; i++) {
      stRows.push({ date: `2026-0${(i % 9) + 1}-14`, descr: 'قسط إيجار مستحق', debitHalalas: 201667, creditHalalas: 0 });
      if (i % 2 === 0) stRows.push({ date: `2026-0${(i % 9) + 1}-20`, descr: 'سداد · تحويل بنكي', debitHalalas: 0, creditHalalas: 201667 });
    }
    const files: Array<[string, string]> = [
      ['سند-قبض-RCP-2026-0043', buildReceiptDoc(CO, receipt, NOW, 'both')],
      ['عقد-20260012345', buildContractDoc(CO, {
        contractNo: '20260012345', tenantName: 'سلمى كمال بن حامد الفلاني', idNumber: '1000000074',
        phone: '0500000033', unitLabel: 'A-1', propertyName: 'برج النخيل', start: '2026-05-10',
        end: '2027-04-09', valueHalalas: 2530000, depositHalalas: 200000, cycle: 'شهرية', status: 'سارٍ',
        installments: Array.from({ length: 11 }, (_, i) => ({
          dueDate: `2026-${String(((i + 4) % 12) + 1).padStart(2, '0')}-10`, amountHalalas: i === 10 ? 2530000 - 230000 * 10 : 230000, paidHalalas: i < 2 ? 230000 : 0,
          status: i < 2 ? 'مدفوعة' : 'مستحقة',
        })),
      }, NOW)],
      ['محضر-استلام-وتسليم', buildHandoverDoc(CO, {
        type: 'استلام وتسليم', tenantName: 'سلمى كمال بن حامد الفلاني', idNumber: '1000000074',
        phone: '0500000033', address: 'الرياض · حي الملقا', unitFloor: 'A-1 · الدور الثاني',
        contractPeriod: '11 شهراً', date: '2026-08-20', tenantSign: '', companySign: 'مدير المكتب',
        sections, legalFooter: 'يقرّ المستأجر باستلام الوحدة بالحالة الموضحة أعلاه، ويلتزم بإعادتها بالحالة نفسها مع مراعاة الاستهلاك الطبيعي، وتُحسم قيمة أي تلف يتجاوز ذلك من مبلغ التأمين.',
      }, NOW, 'office')],
      ['كشف-حساب-20260012345', buildStatementDoc(CO, {
        tenantName: 'سلمى كمال بن حامد الفلاني', contractNo: '20260012345', unitLabel: 'برج النخيل · A-1',
        start: '2026-05-10', end: '2027-04-09', rows: stRows,
      }, NOW)],
      ['فاتورة-INV-2026-0007', buildInvoiceDoc(CO, {
        no: 'INV-2026-0007', customerName: 'شركة الأمل للتجارة', customerVat: '311111111100003',
        issue: '2026-08-20', due: '2026-09-20', notes: 'تُسدَّد خلال ثلاثين يوماً من تاريخ الإصدار.',
        subtotalHalalas: 2530000, taxHalalas: 379500, totalHalalas: 2909500,
        lines: [
          { descr: 'إيجار مكتب تجاري · A-1 · سنة', qty: 1, priceHalalas: 2200000, taxPct: 15 },
          { descr: 'رسوم خدمات مشتركة', qty: 1, priceHalalas: 220000, taxPct: 15 },
        ],
      }, NOW)],
    ];
    for (const [name, body] of files) {
      fs.writeFileSync(path.join(outDir, name + '.html'), wrap(name, body), 'utf8');
    }
    expect(fs.readdirSync(outDir).filter((f) => f.endsWith('.html'))).toHaveLength(5);
  });
});


describe('عينات الإقرار للحكم على الحاسوب · ثلاث صيغ لنفس التقرير', () => {
  test('تُكتب xlsx وdocx وHTML (يُحوَّل PDF) لربع مبذور', async () => {
    const outDir = samplesDir();
    const fsN = await import('node:fs');
    const pathN = await import('node:path');
    const { buildXlsx, buildDocx, PRINT_CSS_SHIM } = { ...(await import('@/domain/officeBuild')), PRINT_CSS_SHIM: (await import('@/domain/printDocs')).PRINT_CSS };
    type RB = import('@/domain/officeBuild').ReportBlock;
    const M = (h: number) => ({ money: h });
    const db = seed();
    // المنشأة مسجّلة في الضريبة: «قابلة للخصم» لها وحدها (كان المولّد معطّلاً بهذا ولا يُرى لأنه ينجح دائماً بلا المجلد)
    db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
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

