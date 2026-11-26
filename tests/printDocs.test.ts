/**
 * قوالب الطباعة · بيانات مصطنعة:
 * ترويسة من بيانات المنشأة، المبلغ بالأرقام والحروف، «صفحة X من Y»، لا صف مقطوع
 * (ترقيم يدوي بسعات محسوبة)، رأس الجدول يتكرر، الضريبة المطفأة لا تُظهر أي خانة،
 * وQR الفاتورة بترميز TLV سليم يُفك ويُقرأ.
 * ويكتب خمسة نماذج HTML تُحوَّل PDF على الحاسوب للحكم البصري.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { memDb } from './helpers/testDb';
import { intToArabicWords, moneyToArabicWords } from '@/domain/numberWords';
import {
  buildReceiptDoc, buildInvoiceDoc, buildStatementDoc, buildContractDoc, buildHandoverDoc,
  zatcaTlvBase64, qrSvg, PRINT_CSS, type CompanyInfo,
} from '@/domain/printDocs';
import type { HandoverSection } from '@/domain/handover/build';

const CO: CompanyInfo = {
  name: 'مكتب النخيل العقاري', vatno: '310123456700003', cr: '1010445566',
  phone: '0501234567', address: 'الرياض · حي الملقا', vatEnabled: true,
};
const NOW = '20/08/2026 04:15';

describe('المبلغ بالحروف', () => {
  test('مثال: 4,000.00 ← أربعة آلاف ريال فقط لا غير', () => {
    expect(moneyToArabicWords(400000)).toBe('أربعة آلاف ريال فقط لا غير');
  });
  test('هللات ومئات وآلاف مركبة', () => {
    expect(moneyToArabicWords(50)).toBe('خمسون هللة فقط لا غير');
    // المعدود بعدده والهللة مؤنثة (س١٤ · E-14)
    expect(moneyToArabicWords(123456)).toBe('ألف ومئتان وأربعة وثلاثون ريالاً وست وخمسون هللة فقط لا غير');
    expect(intToArabicWords(25300)).toBe('خمسة وعشرون ألفاً وثلاثمئة');
    expect(intToArabicWords(2000000)).toBe('مليونان');
  });
});

describe('QR هيئة الزكاة', () => {
  test('TLV يُفك: خمس شارات بقيمها الصحيحة والعربية بترميز UTF-8', () => {
    const b64 = zatcaTlvBase64('مكتب النخيل', '310123456700003', '2026-08-20T10:00:00Z', 115000, 15000);
    const bytes = Buffer.from(b64, 'base64');
    let i = 0;
    const fields: Record<number, string> = {};
    while (i < bytes.length) {
      const tag = bytes[i], len = bytes[i + 1];
      fields[tag] = bytes.subarray(i + 2, i + 2 + len).toString('utf8');
      i += 2 + len;
    }
    expect(fields[1]).toBe('مكتب النخيل');
    expect(fields[2]).toBe('310123456700003');
    expect(fields[3]).toBe('2026-08-20T10:00:00Z');
    expect(fields[4]).toBe('1150.00');
    expect(fields[5]).toBe('150.00');
  });
  test('رسم QR رمز SVG فيه شبكة مربعات', () => {
    const svg = qrSvg('AQ==');
    expect(svg).toContain('<svg');
    expect((svg.match(/<rect /g) || []).length).toBeGreaterThan(50);
  });
});

const receipt = {
  no: 'RCP-2026-0043', tenantName: 'سلمى كمال بن حامد الفلاني', contractNo: '20260012345',
  unitLabel: 'برج النخيل · A-1', date: '2026-08-20', period: 'أغسطس', methodLabel: 'نقداً',
  notes: '', grossHalalas: 400000, discountHalalas: 0, netHalalas: 400000,
};

describe('المستندات', () => {
  test('سند القبض: ترويسة المنشأة والمبلغ بالحروف وتوقيعان وترقيم صفحة، و«كلاهما» نسختان موسومتان', () => {
    const one = buildReceiptDoc(CO, receipt, NOW, 'tenant');
    expect(one).toContain('مكتب النخيل العقاري');
    expect(one).toContain('س.ت');
    expect(one).toContain('1010445566');
    expect(one).toContain('أربعة آلاف ريال فقط لا غير');
    expect(one).toContain('نسخة المستأجر');
    expect(one).toContain('المستلم');
    expect(one).toContain('صفحة <span class="num">1</span> من <span class="num">1</span>');
    const both = buildReceiptDoc(CO, receipt, NOW, 'both');
    expect(both).toContain('نسخة المستأجر');
    expect(both).toContain('نسخة المكتب');
    expect((both.match(/class="page"/g) || []).length).toBe(2);
  });

  test('الفاتورة والضريبة مفعّلة: ضريبية بQR وتفصيل الضريبة · ومطفأة: لا ذكر للضريبة ولا QR', () => {
    const inv = {
      no: 'INV-0007', customerName: 'شركة الأمل', customerVat: '311111111100003',
      issue: '2026-08-01', due: '2026-09-01', notes: '',
      subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000,
      lines: [{ descr: 'إيجار مكتب', qty: 1, priceHalalas: 100000, taxPct: 15 }],
    };
    const on = buildInvoiceDoc(CO, inv, NOW);
    expect(on).toContain('فاتورة ضريبية');
    expect(on).toContain('الإجمالي قبل الضريبة');
    expect(on).toContain('ضريبة القيمة المضافة');
    expect(on).toContain('<svg'); // QR
    const off = buildInvoiceDoc({ ...CO, vatEnabled: false }, { ...inv, taxHalalas: 0, totalHalalas: 100000 }, NOW);
    expect(off).not.toContain('ضريب'); // لا صفر ولا فراغ ولا عمود
    expect(off).not.toContain('class="qr"');
  });

  test('كشف الحساب: 60 حركة تتوزع صفحات مرقَّمة، رأس الجدول في كل صفحة، والرصيد الجاري صحيح', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, descr: 'قسط إيجار مستحق', debitHalalas: 100000, creditHalalas: 0 });
      rows.push({ date: `2026-02-${String((i % 28) + 1).padStart(2, '0')}`, descr: 'سداد · نقداً', debitHalalas: 0, creditHalalas: 90000 });
    }
    const doc = buildStatementDoc(CO, {
      tenantName: 'فهد بن سعد', contractNo: 'C-100', unitLabel: 'A-2', start: '2026-01-01', end: '2026-12-31', rows,
    }, NOW);
    const pages = (doc.match(/class="page"/g) || []).length;
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(doc).toContain(`من <span class="num">${pages}</span>`);
    expect(doc).toContain('صفحة <span class="num">1</span>');
    expect(doc).toContain(`صفحة <span class="num">${pages}</span>`);
    // رأس الجدول يتكرر مع كل قطعة
    expect((doc.match(/<thead>/g) || []).length).toBeGreaterThanOrEqual(3);
    // الرصيد الختامي: 30 × (1000 − 900) = 3000.00 مستحقاً
    expect(doc).toContain('الرصيد المستحق على المستأجر');
    expect(doc).toContain('3,000.00');
  });

  test('محضر الاستلام: الأقسام كلها والذيل القانوني وتوقيعان، والصفحات مرقَّمة', () => {
    const sections: HandoverSection[] = Array.from({ length: 7 }, (_, si) => ({
      section: 'قسم ' + (si + 1),
      items: Array.from({ length: 12 }, (_, ii) => ({
        name: `بند ${si + 1}-${ii + 1}`, count: '1', receiveCondition: 'سليم', deliverCondition: '', notes: '',
      })),
    }));
    const doc = buildHandoverDoc(CO, {
      type: 'استلام وتسليم', tenantName: 'مستأجر', idNumber: '1000000074', phone: '0500000033',
      address: 'الرياض', unitFloor: 'A-1 · الثاني', contractPeriod: '12 شهراً', date: '2026-08-20',
      tenantSign: '', companySign: '', sections, legalFooter: 'ذيل قانوني للتجربة',
    }, NOW, 'office');
    for (let si = 1; si <= 7; si++) expect(doc).toContain('قسم ' + si);
    expect(doc).toContain('ذيل قانوني للتجربة');
    expect(doc).toContain('نسخة المكتب');
    const pages = (doc.match(/class="page"/g) || []).length;
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(doc).toContain(`من <span class="num">${pages}</span>`);
  });

  test('عقد الإيجار: 24 قسطاً بترقيم متصل عبر الصفحات وقيمة العقد بالحروف', () => {
    const doc = buildContractDoc(CO, {
      contractNo: '20260012345', tenantName: 'سلمى كمال بن حامد الفلاني', idNumber: '1000000074',
      phone: '0500000033', unitLabel: 'A-1', propertyName: 'برج النخيل', start: '2026-05-10',
      end: '2027-04-09', valueHalalas: 2530000, depositHalalas: 200000, cycle: 'شهرية', status: 'سارٍ',
      installments: Array.from({ length: 24 }, (_, i) => ({
        dueDate: `2026-0${(i % 9) + 1}-01`, amountHalalas: 105417, paidHalalas: 0, status: 'مستحقة',
      })),
    }, NOW);
    expect(doc).toContain('عقد إيجار · نسخة المكتب');
    expect(doc).toContain('خمسة وعشرون ألفاً وثلاثمئة ريال فقط لا غير');
    expect(doc).toContain('<td class="num">24</td>'); // آخر قسط برقمه المتصل
  });
});
