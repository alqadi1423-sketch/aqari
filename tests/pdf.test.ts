/**
 * اختبارات قراءة عقد الإيجار من PDF · عقد بالترتيبين المنطقي والبصري ← ١٠/١٠،
 * وأسماء تنتهي بـ«سم» لا تُقصّ.
 */
import {
  parseEjarContract, arabicIsReversed, arabicIsVisual, reverseArabicRuns, cleanArabicName,
  fixArabicOrder, fixLatinSpaces, anchorDiagnostics } from '@/domain/pdf/parseEjar';

/** نص عقد إيجار واقعي بالترتيب المنطقي (كما يخزنه PDF سليم) */
const LOGICAL_CONTRACT = `
Ejar Contract
Contract No. 20240012345 / 10-2024
Property Data
Owner Data
Name مالك العقار المفترض
ID No. 1099999999
Mobile No. +966501111111
Tenant Data
Name الاسم باسم بن جاسم الاسماني
ID No. 1055555555
Mobile No. +966547777777
Tenant Representative Data
Name ممثل المستأجر المفترض
ID No. 1044444444
Mobile No. +966533333333
Tenancy Start Date 2024-10-01
Tenancy End Date 2025-09-30
Total Contract value 36,000.00
Security Deposit
Amount 3,000.00
Rent payment cycle سنوي
`;

/** نفس العقد لكن العربي مخزَّن بترتيب بصري (معكوس) · بعض ملفات PDF تفعل هذا */
const VISUAL_CONTRACT = LOGICAL_CONTRACT.split('\n')
  .map((line) =>
    line.replace(/[؀-ۿﭐ-﻿][؀-ۿﭐ-﻿\s]*/g, (m) => [...m].reverse().join(''))
  )
  .join('\n');

/** نص كما يخرجه مستخرِج يبتلع المسافات (بيانات مصطنعة) */
const SPACELESS_CONTRACT = `
EjarContract
ContractNo.20240012345/10-2024
PropertyData
OwnerData
Nameمالك العقار المفترض
IDNo.1099999999
MobileNo.+966501111111
TenantData
Nameالاسم باسم بن جاسم الاسماني
IDNo.1055555555
MobileNo.+966500000025
TenantRepresentativeData
Nameممثل المستأجر المفترض
IDNo.1044444444
MobileNo.+966533333333
TenancyStartDate2025-10-01
TenancyEndDate2026-03-31
TotalContractvalue9600
SecurityDeposit
Amount-:
Rentpaymentcycleيرهش
`;

describe('قراءة عقد الإيجار من PDF', () => {
  test('جدول الأنكرات الثمانية: نص بلا مسافات (كما على الجهاز) ← ١٠/١٠ حقول', () => {
    const r = parseEjarContract(SPACELESS_CONTRACT);
    // الجدول: الأنكر ← القيمة المستخرجة
    expect(r.contractNo).toBe('20240012345/10-2024');   // Contract No.
    expect(r.idNumber).toBe('1055555555');              // ID No. (من مقطع المستأجر)
    expect(r.phone).toBe('0500000025');                 // Mobile No. (+966 طُبّعت)
    expect(r.start).toBe('2025-10-01');                 // Tenancy Start Date
    expect(r.end).toBe('2026-03-31');                   // Tenancy End Date
    expect(r.valueHalalas).toBe(960000);                // Total Contract value = 9600 ر
    expect(r.depositHalalas).toBe(0);                   // Security Deposit «-» = صفر لا فراغ
    expect(r.cycle).toBe('شهرية');                      // Rent payment cycle (معكوسة: يرهش)
    expect(r.tenant).toBe('باسم بن جاسم الاسماني');       // Name (مقطع المستأجر وحده)
    expect(r.months).toBe(6);                           // محسوبة من التاريخين
    expect(r.found.length).toBeGreaterThanOrEqual(10);
  });

  test('الترتيب المنطقي: الحقول العشرة تُستخرج ١٠/١٠', () => {
    const r = parseEjarContract(LOGICAL_CONTRACT);
    expect(r.contractNo).toBe('20240012345/10-2024');
    expect(r.tenant).toBe('باسم بن جاسم الاسماني');
    expect(r.idNumber).toBe('1055555555'); // من مقطع المستأجر لا المالك ولا الممثل
    expect(r.phone).toBe('0547777777');
    expect(r.start).toBe('2024-10-01');
    expect(r.end).toBe('2025-09-30');
    expect(r.valueHalalas).toBe(3600000); // 36,000.00 ر.س = 3,600,000 هللة
    expect(r.depositHalalas).toBe(300000);
    expect(r.cycle).toBe('سنوية');
    expect(r.months).toBe(12);
    // عشرة حقول مستخرجة
    const ten = ['contractNo','tenant','idNumber','phone','start','end','valueHalalas','depositHalalas','cycle','months'];
    for (const k of ten) expect(r.found).toContain(k);
  });

  test('الترتيب البصري (معكوس): نفس الحقول العشرة ١٠/١٠', () => {
    expect(arabicIsReversed(VISUAL_CONTRACT)).toBe(true);
    const r = parseEjarContract(VISUAL_CONTRACT);
    expect(r.tenant).toBe('باسم بن جاسم الاسماني');
    expect(r.idNumber).toBe('1055555555');
    expect(r.phone).toBe('0547777777');
    expect(r.contractNo).toBe('20240012345/10-2024');
    expect(r.start).toBe('2024-10-01');
    expect(r.end).toBe('2025-09-30');
    expect(r.valueHalalas).toBe(3600000);
    expect(r.depositHalalas).toBe(300000);
    expect(r.cycle).toBe('سنوية');
    expect(r.months).toBe(12);
  });

  test('أسماء بـ«سم» تبقى، والاسم البصري المعكوس مع تسميته يستقيم (أسماء مصطنعة)', () => {
    expect(cleanArabicName('حامد جاسم الفلاني')).toBe('حامد جاسم الفلاني');
    expect(cleanArabicName('ماجد بن جاسم')).toBe('ماجد بن جاسم');
    expect(cleanArabicName('كامل سالم الاسماني')).toBe('كامل سالم الاسماني');
    expect(cleanArabicName([...'الاسم: ندى كامل علي الفهري'].reverse().join(''))).toBe('ندى كامل علي الفهري');
  });

  test('ملف غير عقد إيجار: صفر حقول بلا انهيار · فتعرض الواجهة «لم تُقرأ حقول واضحة»', () => {
    const r = parseEjarContract('فاتورة كهرباء شهر أغسطس\nرقم الحساب 3345\nالمبلغ المستحق 245.60');
    expect(r.found.length).toBe(0);
    const r2 = parseEjarContract('');
    expect(r2.found.length).toBe(0);
  });

  test('أسماء تنتهي بـ«سم» لا تُقصّ: جاسم والاسماني', () => {
    expect(cleanArabicName('الاسم جاسم الفلاني', false)).toBe('جاسم الفلاني');
    expect(cleanArabicName('جاسم الفلاني الاسم', false)).toBe('جاسم الفلاني');
    expect(cleanArabicName('الاسم حامد الاسماني', false)).toBe('حامد الاسماني');
    expect(cleanArabicName(': الاسم ماجد جاسم', false)).toBe('ماجد جاسم');
    // «الاسم» وحدها تُنزع كلياً
    expect(cleanArabicName('الاسم', false)).toBe('');
  });

  test('العكس يجري قبل التطبيع: ﻻ (حرف واحد) تنفك بعد العكس لا قبله', () => {
    // كلمة «الأحوال» مكتوبة بصرياً بحرف اللام-ألف المدمج ﻻ
    const visual = [...'اﻻستقبال'].reverse().join(''); // «الاستقبال» معكوسة بصرياً بحرف مدمج
    const fixed = fixArabicOrder(visual, true);
    expect(fixed).toBe('الاستقبال');
    // لو طُبّع أولاً لانفكّ ﻻ إلى ل+ا ثم انعكس ترتيبهما خطأً: ا+ل
    const wrongOrder = visual.normalize('NFKC');
    expect([...wrongOrder].reverse().join('')).not.toBe('الاستقبال');
  });

  test('كشف الاتجاه بالكلمات المرجعية وبأداة التعريف عند التعادل', () => {
    expect(arabicIsReversed('عقد المستأجر تاريخ الجوال')).toBe(false);
    expect(arabicIsReversed(reverseArabicRuns('عقد المستأجر تاريخ الجوال'))).toBe(true);
    // نص بلا كلمات مرجعية: يُفصل بموضع «ال»
    expect(arabicIsReversed('البيت الكبير الجميل')).toBe(false);
    expect(arabicIsReversed(reverseArabicRuns('البيت الكبير الجميل'))).toBe(true);
  });

  test('الهوية والجوال من مقطع المستأجر وحده · لا يختلطان بالمالك أو الممثل', () => {
    const r = parseEjarContract(LOGICAL_CONTRACT);
    expect(r.idNumber).not.toBe('1099999999'); // المالك
    expect(r.idNumber).not.toBe('1044444444'); // الممثل
    expect(r.phone).not.toBe('0501111111');
    expect(r.phone).not.toBe('0533333333');
  });

  test('دورة السداد تُطبَّع لقيم النموذج الأربع', () => {
    const mk = (cy: string) => `Tenant Data\nName فلان\nTenant Representative Data\nRent payment cycle ${cy}\n`;
    expect(parseEjarContract(mk('نصف سنوي')).cycle).toBe('نصف سنوية');
    expect(parseEjarContract(mk('ربع سنوي')).cycle).toBe('ربع سنوية');
    expect(parseEjarContract(mk('شهري')).cycle).toBe('شهرية');
    expect(parseEjarContract(mk('سنوي')).cycle).toBe('سنوية');
  });
});

describe('النمط الثالث · مسافات مبعثرة (عقد مصطنع)', () => {
  // المسافات تبعثرت: ضاعت من بين الكلمات وظهرت داخلها وقبل الشرطة المائلة
  const SCATTERED = `
Residential Rental Contract
Contract No. : 10099887766 /2-0
Tenancy StartDate: 2026-03-10
TenancyEnd Date: 2026-08-09
TenantData
Nam e :ينامسلاارماسدنه
IDNo. : 1000000066
M obile No. : +966500000017
Tenant Representative Data
Name: ممثل لا يخصنا
ID No.: 2222222222
Financial Information
Tota lContract value: 7,350.00
Security Deposit
Amount 600.00 :
Rent paym ent cycle يرهش
`;
  const r = parseEjarContract(SCATTERED);

  test('١٠/١٠ بمبدأ التسطيح لا بمعالجة خاصة', () => {
    expect(r.contractNo).toBe('10099887766/2-0');
    expect(r.idNumber).toBe('1000000066');
    expect(r.phone).toBe('0500000017');
    expect(r.start).toBe('2026-03-10');
    expect(r.end).toBe('2026-08-09');
    expect(r.valueHalalas).toBe(735000);
    expect(r.depositHalalas).toBe(60000);
    expect(r.cycle).toBe('شهرية');
    expect(r.months).toBe(5);
    // الاسم لا يُترك فارغاً: يخرج ولو ملتصقاً مع طلب المراجعة
    expect(r.tenant && r.tenant.length > 5).toBe(true);
    expect(r.nameNeedsReview).toBe(true);
    expect(r.found.length).toBeGreaterThanOrEqual(10);
  });

  test('تشخيص الأنكرات: الثمانية تطابق على النص المبعثر', () => {
    const diag = anchorDiagnostics(SCATTERED);
    // التاسع «جدول الدفعات» (قرار المالك ٢٠٢٦-١٠-٠٥) · هذا النص بلا جدول فيبلّغ بغيابه
    expect(diag).toHaveLength(9);
    for (const d of diag.slice(0, 8)) expect(d.label + ': ' + d.ok).toBe(d.label + ': true');
    expect(diag[8]).toEqual({ label: 'جدول الدفعات', ok: false, sample: '' });
  });

  test('رقم العقد بمسافة قبل الشرطة المائلة يخرج كاملاً موصولاً', () => {
    expect(r.contractNo).toContain('/');
    expect(r.contractNo).not.toContain(' ');
  });
});

/**
 * تشكيل بصري كما يخزّنه بعض منتجي PDF: كل حرف بشكل عرضه (U+FB50..U+FEFC)
 * ولام-ألف حرف واحد ﻻ، ثم يُعكس ترتيب المحارف.
 * الخريطة تُبنى من الترميز نفسه بالتطبيع العكسي فلا جدول يدوي يُصان.
 */
const toVisual = (s: string): string => {
  const forms = new Map<string, string>();
  for (let c = 0xfb50; c <= 0xfefc; c++) {
    const ch = String.fromCharCode(c);
    const base = ch.normalize('NFKC');
    if (base.length === 1 && !forms.has(base)) forms.set(base, ch);
  }
  const shaped = [...s.replace(/لا/g, 'ﻻ')].map((ch) => forms.get(ch) ?? ch).join('');
  return [...shaped].reverse().join('');
};

describe('النمط الرابع · أشكال العرض دليل الاتجاه (ثلاث حالات مصطنعة)', () => {
  const NAME = 'سلمى حامد بن ماجد الامين';
  const VIS_NAME = toVisual(NAME);

  test('العلة: التطبيع NFKC يمحو أشكال العرض فيضيع دليل الاتجاه', () => {
    // الدليل موجود في الخام، ومعدوم بعد التطبيع
    expect(/[ﭐ-ﻼ]/.test(VIS_NAME)).toBe(true);
    expect(/[ﭐ-ﻼ]/.test(VIS_NAME.normalize('NFKC'))).toBe(false);
    // فالكشف على الخام يصيب، وعلى المُطبَّع يخطئ (وهذا ما كان يشوّه الاسم)
    expect(arabicIsVisual(VIS_NAME)).toBe(true);
    expect(arabicIsVisual(VIS_NAME.normalize('NFKC'))).toBe(false);
  });

  test('حالة ١ · اسم عربي مقلوب بأشكال عرض يستقيم كاملاً', () => {
    expect(cleanArabicName(VIS_NAME)).toBe(NAME);
    // ﻻ في «الامين» حرف واحد: لو طُبّع قبل العكس لانقلب إلى «االمين»
    expect(cleanArabicName(VIS_NAME)).not.toContain('االمين');
  });

  test('حالة ٢ · عبارة عربية مقلوبة تستقيم بالدليلين: أشكال العرض والكلمات المرجعية', () => {
    const phrase = 'رقم سجل العقد';
    expect(fixArabicOrder(toVisual(phrase))).toBe(phrase);
    expect(fixArabicOrder([...phrase].reverse().join(''))).toBe(phrase);
  });

  test('حالة ٣ · لاتيني مبعثر المسافات: M ain ContractNo. تصير Main Contract No.', () => {
    expect(fixLatinSpaces('M ain ContractNo.')).toBe('Main Contract No.');
    expect(fixArabicOrder('M ain ContractNo.')).toBe('Main Contract No.');
    expect(fixLatinSpaces('M obile No. : +966500000017')).toBe('Mobile No. : +966500000017');
    // كلمة مفردة حقيقية لا تُلصق، والعربي لا يُمسّ
    expect(fixLatinSpaces('Building A 5')).toBe('Building A 5');
    expect(fixLatinSpaces('a new contract')).toBe('a new contract');
    expect(fixLatinSpaces('رقم سجل العقد')).toBe('رقم سجل العقد');
  });

  test('عقد كامل بأشكال العرض: ١٠/١٠ حقول والاسم سليم', () => {
    const PRES_CONTRACT = `
Ejar Contract
Contract No. 11223344556 / 3-1
Owner Data
Name ${toVisual('مالك مفترض')}
ID No. 1099999999
Mobile No. +966501111111
Tenant Data
Name ${toVisual(NAME)}
ID No. 1066666666
Mobile No. +966551234567
Tenant Representative Data
Name ${toVisual('ممثل المستأجر')}
ID No. 1044444444
Tenancy Start Date 2026-01-01
Tenancy End Date 2026-12-31
Total Contract value 24,000.00
Security Deposit
Amount 1,000.00
Rent payment cycle ${toVisual('شهري')}
`;
    const r = parseEjarContract(PRES_CONTRACT);
    expect(r.tenant).toBe(NAME);
    expect(r.nameNeedsReview).toBeUndefined();
    expect(r.contractNo).toBe('11223344556/3-1');
    expect(r.idNumber).toBe('1066666666');
    expect(r.phone).toBe('0551234567');
    expect(r.start).toBe('2026-01-01');
    expect(r.end).toBe('2026-12-31');
    expect(r.valueHalalas).toBe(2400000);
    expect(r.depositHalalas).toBe(100000);
    expect(r.cycle).toBe('شهرية');
    expect(r.months).toBe(12);
    expect(r.found.length).toBeGreaterThanOrEqual(10);
  });
});
