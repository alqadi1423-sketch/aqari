/**
 * بنود عقد إيجار التي لها خانة ولم تكن تُقرأ (قرارات تفصيل العقد ٢٠٢٦-١٠-٠٧) · نصوص مصطنعة على هيئة
 * المستخرج: «التسمية الإنجليزية القيمة:التسمية العربية»، وتسمياتٌ تنكسر على سطرين.
 */
import { parseEjarExtras, scheduleChecks, compareExtras, applyExtras, unitByNumber, mapFurnished, mapUnitType, mapUsage, mapFloor } from '@/domain/pdf/ejarExtras';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit } from './helpers/fixtures';

const TEXT = `
Contract Data بيانات العقد
Lessor Data بيانات المؤجر
Company name/Founder مؤسسة مصطنعة للاختبار:اسم الشركة
Unified Number 7000000001 CR No. 1000000002:رقم السجل التجاري
Lessor Representative Data
Tenant Data بيانات المستأجر
Name مستأجر مصطنع:الاسم
ID No. 1000000017 ID Type هوية وطنية
Email tenant.test@example.test Mobile No. +966500000101
Tenant Representative Data
Ownership document Data
Issuer: وزارة العدل Title Deed No: 123456789012:رقم الصك
Property Data بيانات العقار
National Address حي مصطنع، شارع الاختبار:العنوان الوطني
Property Usage سكني:الغرض من استخدام العقار Property Type عمارة:نوع بناء العقار
Number of Units 12:عدد الوحدات Number of Floors 4:عدد الطوابق
Rental Units Data
Unit No. 7:رقم الوحدة Unit Type شقة:نوع الوحدة
Unit Area 120.5 Floor No. 2:رقم الطابق
Kitchen Cabinets Installed نعم:خزائن المطبخ Furnished نعم:مؤثثة
Furnishing Status مؤثثة جزئياً:حالة التأثيث Number of AC units 3
Current meter reading 1520 Electricity meter number 33445566
Current meter reading - Gas meter number -
Current meter reading 88 Water meter number 77889900
Financial Data البيانات المالية
Gas total: 0 Electricity total: 600.00
Parking Annual Amount 0 Water total: 300.00
Parking Lots Rented: 0 Total rent value: 6,000.00
Rent payment cycle شهري Regular Rent Payment: 1,725.00
Number of Rent
Payments: 4 Last Rent Payment: 1,725.00
Total Contract value 6,900.00
`;

test('يقرأ العقار والوحدة والبريد والمؤجر والمالية والعدادات', () => {
  const x = parseEjarExtras(TEXT);
  expect(x.property).toEqual({ usage: 'سكني', floors: 4, deedNo: '123456789012', nationalAddress: 'حي مصطنع، شارع الاختبار' });
  expect(x.unit).toEqual({ unitNo: '7', unitType: 'شقة', floorNo: '2', furnished: 'مؤثثة جزئياً' });
  expect(x.tenant.email).toBe('tenant.test@example.test');
  expect(x.lessor).toEqual({ cr: '1000000002', unified: '7000000001', name: 'مؤسسة مصطنعة للاختبار' });
  expect(x.financial).toMatchObject({ rentValue: 600000, totalValue: 690000, electricity: 60000, water: 30000, gas: 0, parking: 0, regular: 172500, last: 172500, count: 4 });
  expect(x.meters).toEqual([{ kind: 'electricity', number: '33445566', reading: 1520 }, { kind: 'water', number: '77889900', reading: 88 }]);
});

test('مؤثثة وحالة التأثيث في خانة واحدة · وأنواع الوحدة والغرض والطابق إلى قيم التطبيق', () => {
  expect(mapFurnished('لا', undefined)).toBe('غير مؤثثة');
  expect(mapFurnished('نعم', 'مؤثثة بالكامل')).toBe('مؤثثة');
  expect(mapFurnished('نعم', 'مؤثثة جزئياً')).toBe('مؤثثة جزئياً');
  expect(mapFurnished(undefined, undefined)).toBeUndefined();
  expect(mapUnitType('شقة')).toBe('سكني');
  expect(mapUnitType('محل تجاري')).toBe('محل');
  expect(mapUnitType('مجهول')).toBeNull();
  expect(mapUsage('تجاري- سكني')).toBe('مختلط');
  expect(mapFloor('0')).toBe('الأرضي');
  expect(mapFloor('2')).toBe('الطابق 2');
});

test('فحوص الجدول: العدد والدفعة الدورية والأخيرة مقابل المقروء', () => {
  const sch = [1, 2, 3].map((i) => ({ dueDate: '2026-0' + i + '-05', amountHalalas: 172500 }));
  expect(scheduleChecks(sch, { count: 4, regular: 172500, last: 172500 })).toEqual([{ code: 'count', expected: 4, actual: 3 }]);
  expect(scheduleChecks([...sch, { dueDate: '2026-04-05', amountHalalas: 100 }], { count: 4, regular: 172500, last: 172500 }))
    .toEqual([{ code: 'last', expected: 172500, actual: 100 }]);
  expect(scheduleChecks([{ dueDate: '2026-01-05', amountHalalas: 5 }, ...sch], { regular: 172500 })[0].code).toBe('regular');
  expect(scheduleChecks(null, { count: 4 })).toEqual([]);
});

test('المقارنة بالقائم: الفارغ يُملأ افتراضاً والمختلف لا يُكتب إلا بموافقة · والغاز بلا خانة لا يُكتب', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار مقارنة مصطنع' });
  const u = addUnit(db, p, { unit_no: '7' });
  db.run(`UPDATE properties SET deed_no = '999' WHERE id = ?`, [p]);
  expect(unitByNumber(db, p, '٧')).toBe(u);
  const x = parseEjarExtras(TEXT.replace('Gas meter number -', 'Gas meter number 55667788'));
  const diffs = compareExtras(db, x, { unitId: u, tenantName: 'مستأجر مصطنع' });
  const deed = diffs.find((d) => d.key === 'property.deed')!;
  expect([deed.current, deed.read, deed.fillsEmpty]).toEqual(['999', '123456789012', false]);
  expect(diffs.find((d) => d.key === 'property.address')!.fillsEmpty).toBe(true);
  expect(diffs.find((d) => d.key === 'meter.gas')!.noSlot).toBe(true);
  // يُكتب ما وافق عليه وحده: العنوان والعداد · والصك المختلف بلا موافقة يبقى
  const n = applyExtras(db, diffs, new Set(['property.address', 'meter.electricity', 'meter.gas']), { unitId: u, tenantName: 'مستأجر مصطنع', start: '2026-01-01', handoverRef: 'قراءة استلام' });
  expect(n).toBe(2);
  expect(db.get<{ a: string; d: string }>(`SELECT address AS a, deed_no AS d FROM properties WHERE id = ?`, [p])).toEqual({ a: 'حي مصطنع، شارع الاختبار', d: '999' });
  const m = db.get<{ id: string; number: string }>(`SELECT id, number FROM meters WHERE owner_id = ? AND kind = 'كهرباء'`, [u])!;
  expect(m.number).toBe('33445566');
  expect(db.get<{ r: number }>(`SELECT reading AS r FROM meter_readings WHERE meter_id = ?`, [m.id])!.r).toBe(1520);
});
