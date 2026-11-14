/**
 * كشف البنك (التوجيه الرابع ٦ · ٢): القارئ العام · نماذج مخترعة بأشكال أشهر البنوك السعودية كما وصفتها الدراسة
 * (docs/التقارير/دراسة-كشف-البنك-2026-11-07.md · القسم «ما يعنيه هذا للبناء» البند ١٠) · لا بيانات لأحد: أسماء وأرقام ومبالغ مصطنعة.
 * المعيار في كل نموذج: الأسطر بتواريخها ومبالغها الموقَّعة بالهللة، والافتتاحي مع الحركات يساوي الختامي، وما لا يثبت لا يُقبل.
 */
import { parseStatementAmount, parseStatementDate } from '@/domain/bankStatement/normalize';
import { parseCsv } from '@/domain/bankStatement/csv';
import { parseMt940 } from '@/domain/bankStatement/mt940';
import { readStatementGrid, readStatementFile, type StatementResult } from '@/domain/bankStatement/read';
import { gridFromPdfItems } from '@/domain/bankStatement/pdfTable';
import { statementLineKeys } from '@/domain/bankStatement/dedupe';
import { buildXlsx } from '@/domain/officeBuild';

const ok = (r: StatementResult) => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error + ' ' + (r.detail ?? '')); return r; };
const amounts = (r: StatementResult) => ok(r).lines.map((l) => l.amount);
const dates = (r: StatementResult) => ok(r).lines.map((l) => l.date);

describe('تطبيع المبالغ والتواريخ', () => {
  test.each([
    ['1,234.50', 123450], ['1234.5', 123450], ['١٬٢٣٤٫٥٠', 123450], ['١٢٣٤٫٥', 123450], ['(1,234.50)', -123450], ['1,234.50-', -123450],
    ['-1,234.50', -123450], ['1,234.50 CR', 123450], ['1,234.50 DR', -123450], ['SAR 1,234.50', 123450], ['1,234.50 ر.س', 123450],
    ['1234ﺭ50', 123450], ['٠٫٠٠', 0], ['  ', null], ['abc', null], ['12.345', null], ['1,23,4.00', null],
  ])('%s', (raw, want) => expect(parseStatementAmount(raw)).toBe(want));

  test.each([
    ['2026/10/05', 'dmy', '2026-10-05'], ['2026-10-05', 'dmy', '2026-10-05'], ['05/10/2026', 'dmy', '2026-10-05'], ['05-10-2026', 'dmy', '2026-10-05'],
    ['10/05/2026', 'mdy', '2026-10-05'], ['05/10/26', 'dmy', '2026-10-05'], ['05 Oct 2026', 'dmy', '2026-10-05'], ['٠٥/١٠/٢٠٢٦', 'dmy', '2026-10-05'],
    ['31/02/2026', 'dmy', null], ['2026/13/01', 'dmy', null], ['هجري', 'dmy', null],
  ])('%s (%s)', (raw, order, want) => expect(parseStatementDate(raw, { order: order as 'dmy' | 'mdy' })).toBe(want));

  test('بلا سنة: من سياق فترة الكشف', () => {
    expect(parseStatementDate('10/05', { order: 'mdy', year: 2026 })).toBe('2026-10-05');
    expect(parseStatementDate('10/05', { order: 'mdy' })).toBeNull();
  });
});

describe('CSV', () => {
  test('الفاصلة والفاصلة المنقوطة والجدولة، والعلامات المقتبسة، وBOM', () => {
    expect(parseCsv('﻿a,b,c\n1,"x, y",3\n')).toEqual([['a', 'b', 'c'], ['1', 'x, y', '3']]);
    expect(parseCsv('a;b;c\r\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(parseCsv('a\tb\n1\t"q""t"')).toEqual([['a', 'b'], ['1', 'q"t']]);
  });
});

/** شبيه الراجحي: التاريخ YYYY/MM/DD، ومدين ودائن ورصيد بلاحقة SAR، وبيانٌ على سطرين، والافتتاحي والختامي في الرأس والتذييل */
const RAJHI_LIKE = [
  ['كشف حساب', '', '', '', ''],
  ['رقم الحساب', 'SA0000000000000000000001', '', '', ''],
  ['الرصيد الافتتاحي', '10,000.00 SAR', '', '', ''],
  ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
  ['2026/10/01', 'حوالة واردة مصطنعة', '', '5,000.00 SAR', '15,000.00 SAR'],
  ['', 'من شركة مصطنعة', '', '', ''],
  ['2026/10/03', 'رسوم خدمة', '11.50 SAR', '', '14,988.50 SAR'],
  ['2026/10/07', 'سداد فاتورة مصطنعة', '988.50 SAR', '', '14,000.00 SAR'],
  ['الرصيد الختامي', '14,000.00 SAR', '', '', ''],
];

describe('القارئ العام · أشكال البنوك', () => {
  test('شبيه الراجحي: مدين ودائن، وبيانٌ يكمل في السطر التالي، والافتتاحي والختامي', () => {
    const r = ok(readStatementGrid(RAJHI_LIKE));
    expect(dates(r)).toEqual(['2026-10-01', '2026-10-03', '2026-10-07']);
    expect(amounts(r)).toEqual([500000, -1150, -98850]);
    expect(r.lines[0].descr).toBe('حوالة واردة مصطنعة من شركة مصطنعة');
    expect(r.opening).toBe(1000000);
    expect(r.closing).toBe(1400000);
    expect(r.checks).toMatchObject({ chain: true, closing: true });
  });

  test('شبيه الأهلي (الجديد): الأعمدة معكوسة بعناوين ثنائية اللغة، وDD/MM/YYYY، والجدول مطبوعٌ مرتين في الملف', () => {
    const head = ['Balance الرصيد', 'Credit دائن', 'Debit مدين', 'Description البيان', 'Date التاريخ'];
    const rows = [
      ['20,000.00', '20,000.00', '', 'إيداع مصطنع', '02/10/2026'],
      ['19,750.00', '', '250.00', 'نقاط بيع مصطنعة', '15/10/2026'],
      ['19,700.00', '', '50.00', 'رسوم', '28/10/2026'],
    ];
    const r = ok(readStatementGrid([['Opening Balance الرصيد السابق', '0.00'], head, ...rows, head, ...rows, ['Closing Balance', '19,700.00']]));
    expect(dates(r)).toEqual(['2026-10-02', '2026-10-15', '2026-10-28']);
    expect(amounts(r)).toEqual([2000000, -25000, -5000]);
    expect(r.mapping.dateOrder).toBe('dmy');
  });

  test('شبيه الرياض: تاريخان هجري وميلادي، ومبلغٌ واحد بلا إشارة تحدده الأرصدة، والأحدث أولاً، وترتيب القيد في اليوم الواحد يخالف ترتيب الصفوف', () => {
    // (والمبلغ بلا إشارة لا يُحسم أول سطرٍ فيه إلا بالافتتاحي المطبوع)
    const r = ok(readStatementGrid([
      ['الرصيد الافتتاحي', '0.00'],
      ['التاريخ الهجري', 'التاريخ', 'تفاصيل العملية', 'المبلغ', 'الرصيد'],
      ['1448/05/12', '2026/10/24', 'إيداع مصطنع', '2,000.00', '5,000.00'],
      ['1448/05/12', '2026/10/24', 'سحب صراف مصطنع', '300.00', '4,700.00'],
      ['1448/05/01', '2026/10/13', 'شراء مصطنع', '1,000.00', '3,000.00'],
      ['1448/04/22', '2026/10/04', 'افتتاح', '4,000.00', '4,000.00'],
    ]));
    // تصاعدياً، والإشارة من تسلسل الأرصدة، وفي اليوم الواحد بترتيب القيد
    expect(dates(r)).toEqual(['2026-10-04', '2026-10-13', '2026-10-24', '2026-10-24']);
    expect(amounts(r)).toEqual([400000, -100000, 200000, -30000]);
    expect(r.opening).toBe(0);
    expect(r.closing).toBe(470000);
  });

  test('شبيه ساب: أرقامٌ هندية، والفاصل العشري «ﺭ»، وتاريخٌ بلا سنة من فترة الكشف، ورصيدٌ متقطع، والختامي وحده', () => {
    // (والسطر الأول بلا رصيد لا يشهد له إلا الافتتاحي: بلا افتتاحيٍّ يُطلب مع المشتق تعبئةً، وبه يُقرأ · المدقق الخارجي U١)
    const grid = [
      ['الفترة من ٠١/١٠/٢٠٢٦ إلى ٣١/١٠/٢٠٢٦'],
      ['التاريخ', 'الوصف', 'مدين', 'دائن', 'الرصيد'],
      ['١٠/٠٢', 'راتب مصطنع', '', '٨٠٠٠ﺭ٠٠', ''],
      ['١٠/٠٥', 'سداد مصطنع', '١٢٠٠ﺭ٥٠', '', '٩٧٩٩ﺭ٥٠'],
      ['١٠/٢٠', 'تحويل مصطنع', '٧٩٩ﺭ٥٠', '', ''],
      ['الرصيد الختامي', '', '', '', '٩٠٠٠ﺭ٠٠'],
    ];
    const ask = readStatementGrid(grid);
    expect(ask).toMatchObject({ ok: false, error: 'needBalances', partial: { opening: 300000 } });
    const r = ok(readStatementGrid(grid, { opening: 300000 }));
    expect(dates(r)).toEqual(['2026-10-02', '2026-10-05', '2026-10-20']);
    expect(amounts(r)).toEqual([800000, -120050, -79950]);
    expect(r.opening).toBe(300000);
    expect(r.closing).toBe(900000);
  });

  test('شبيه العربي: مبلغٌ موقَّع وتاريخ ISO', () => {
    const r = ok(readStatementGrid([
      ['Posting Date', 'Narration', 'Amount', 'Running Balance'],
      ['2026-10-01', 'Transfer in', '1500.00', '2500.00'],
      ['2026-10-09', 'Card purchase', '-75.25', '2424.75'],
    ]));
    expect(amounts(r)).toEqual([150000, -7525]);
    expect(r.opening).toBe(100000);
  });

  test('شبيه الجزيرة: تاريخ القيمة مع تاريخ الحركة، و«الرصيد السابق» يناقض المجاميع فيُقدَّم الثابت بالتسلسل', () => {
    const r = ok(readStatementGrid([
      ['الرصيد السابق', '9,999.00'],
      ['تاريخ الحركة', 'تاريخ القيمة', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['01/10/2026', '02/10/2026', 'إيداع مصطنع', '', '500.00', '1,500.00'],
      ['05/10/2026', '05/10/2026', 'رسوم', '25.00', '', '1,475.00'],
      ['إجمالي المدين', '25.00', 'إجمالي الدائن', '500.00'],
    ]));
    expect(r.lines.map((l) => [l.date, l.valueDate])).toEqual([['2026-10-01', '2026-10-02'], ['2026-10-05', '2026-10-05']]);
    expect(r.opening).toBe(100000);
    expect(r.warnings).toContain('openingPrinted');
  });

  test('ما لا يثبت لا يُقبل: رصيدٌ لا يتسلسل، وختامي يخالف، وبلا أرصدة ولا افتتاحي', () => {
    const broken = readStatementGrid([
      ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/01', 'أ', '', '100.00', '1,100.00'],
      ['2026/10/02', 'ب', '50.00', '', '1,070.00'],
    ]);
    expect(broken).toMatchObject({ ok: false, error: 'balance' });
    const closing = readStatementGrid([
      ['الرصيد الافتتاحي', '1,000.00'], ['التاريخ', 'البيان', 'مدين', 'دائن'],
      ['2026/10/01', 'أ', '', '100.00'], ['الرصيد الختامي', '1,200.00'],
    ]);
    expect(closing).toMatchObject({ ok: false, error: 'balance' });
    const none = readStatementGrid([['التاريخ', 'البيان', 'مدين', 'دائن'], ['2026/10/01', 'أ', '', '100.00']]);
    expect(none).toMatchObject({ ok: false, error: 'needBalances' });
    // والافتتاحي والختامي يكتبهما المستخدم من رأس الكشف
    expect(ok(readStatementGrid([['التاريخ', 'البيان', 'مدين', 'دائن'], ['2026/10/01', 'أ', '', '100.00']], { opening: 0, closing: 10000 })).lines).toHaveLength(1);
    expect(readStatementGrid([['لا شيء هنا']])).toMatchObject({ ok: false, error: 'columns' });
  });

  test('الربط المحفوظ يُستعمل في الكشف التالي ولو تغيّرت عناوين الأعمدة شكلاً', () => {
    const first = ok(readStatementGrid(RAJHI_LIKE));
    const again = ok(readStatementGrid(RAJHI_LIKE.map((r) => (r[0] === 'التاريخ' ? ['Date', 'Desc', 'Dr', 'Cr', 'Bal'] : r)), { mapping: first.mapping }));
    expect(amounts(again)).toEqual(amounts(first));
  });
});

describe('MT940', () => {
  test('الافتتاحي :60F: والحركات :61: وتفاصيلها :86: والختامي :62F:', () => {
    const text = [
      ':20:STMT0001', ':25:SA0000000000000000000002', ':28C:00001/001',
      ':60F:C261001SAR10000,00',
      ':61:2610021002C5000,00NTRFNONREF//REF0001', ':86:حوالة واردة مصطنعة',
      ':61:2610051005D11,50NCHG//REF0002', ':86:رسوم',
      ':61:2610071007D988,50NTRF//REF0003', ':86:سداد فاتورة',
      ':62F:C261031SAR14000,00',
    ].join('\r\n');
    const m = parseMt940(text);
    expect(m.opening).toBe(1000000);
    expect(m.closing).toBe(1400000);
    expect(m.lines.map((l) => [l.date, l.amount, l.descr])).toEqual([
      ['2026-10-02', 500000, 'حوالة واردة مصطنعة'], ['2026-10-05', -1150, 'رسوم'], ['2026-10-07', -98850, 'سداد فاتورة']]);
  });
});

describe('الملف: PDF بمواضع نصه، وExcel، وCSV، وMT940', () => {
  test('PDF: صفوفٌ بالموضع العمودي، وأعمدةٌ بمواضع العناوين', () => {
    // عناوين من اليمين إلى اليسار كما يرسمها كشفٌ عربي · وكل قطعة بموضعها
    const at = (str: string, x: number, y: number) => ({ str, x, y, size: 9 });
    const items = [
      at('الرصيد', 60, 700), at('دائن', 160, 700), at('مدين', 240, 700), at('البيان', 380, 700), at('التاريخ', 520, 700),
      at('15,000.00', 50, 680), at('5,000.00', 150, 680), at('حوالة واردة', 370, 680), at('2026/10/01', 510, 680),
      at('14,988.50', 50, 665), at('11.50', 235, 665), at('رسوم', 385, 665), at('2026/10/03', 510, 665),
    ];
    const grid = gridFromPdfItems([items]);
    const r = ok(readStatementGrid([['الرصيد الافتتاحي', '10,000.00'], ...grid]));
    expect(amounts(r)).toEqual([500000, -1150]);
  });

  test('Excel بعناوين ثنائية اللغة، وCSV، وMT940 بالامتداد', () => {
    const xlsx = buildXlsx([{ name: 'كشف', blocks: [{ heading: 'كشف حساب مصطنع', meta: [], totals: [], sections: [{ title: 'الحركات',
      header: ['Date التاريخ', 'Description البيان', 'Debit مدين', 'Credit دائن', 'Balance الرصيد'],
      rows: [['2026-10-01', 'إيداع', '', '1000.00', '1000.00'], ['2026-10-02', 'رسوم', '10.00', '', '990.00']] }] }] }]);
    expect(amounts(readStatementFile({ name: 'statement.xlsx', bytes: xlsx }, { opening: 0 }))).toEqual([100000, -1000]);
    const csv = new TextEncoder().encode('Date,Description,Amount,Balance\n2026-10-01,In,100.00,100.00\n2026-10-02,Out,-40.00,60.00\n');
    expect(amounts(readStatementFile({ name: 'x.csv', bytes: csv }))).toEqual([10000, -4000]);
    const sta = new TextEncoder().encode(':60F:C261001SAR0,00\n:61:2610011001C100,00NTRF//R1\n:86:In\n:62F:C261031SAR100,00\n');
    expect(amounts(readStatementFile({ name: 'x.sta', bytes: sta }))).toEqual([10000]);
    expect(readStatementFile({ name: 'x.docx', bytes: new Uint8Array([1, 2, 3]) })).toMatchObject({ ok: false, error: 'format' });
  });
});

describe('منع التكرار', () => {
  test('بصمة السطر ثابتةٌ بين قراءتين، والمتطابقان في الكشف الواحد يُميَّزان برقم تكرارهما، والكشفان المتداخلان يتشاركان البصمات', () => {
    const r = ok(readStatementGrid(RAJHI_LIKE));
    const k1 = statementLineKeys('bank-1', r.lines);
    expect(statementLineKeys('bank-1', ok(readStatementGrid(RAJHI_LIKE)).lines)).toEqual(k1);
    expect(new Set(k1).size).toBe(k1.length);
    const twin = [r.lines[1], { ...r.lines[1] }];
    const kt = statementLineKeys('bank-1', twin);
    expect(kt[0]).not.toBe(kt[1]);
    expect(statementLineKeys('bank-2', r.lines)[0]).not.toBe(k1[0]);
  });
});
