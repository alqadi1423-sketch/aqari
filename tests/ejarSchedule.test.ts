/**
 * جدول الدفعات من ملف إيجار (قرار المالك ٢٠٢٦-١٠-٠٥): تواريخ الأقساط تؤخذ من جدول الملف دائماً،
 * وإن تعذّرت قراءته تُحسب ويظهر تنبيه. نصوص مصطنعة بتواريخ آخر الشهر، بالترتيبين وبمستخرج يبتلع المسافات.
 */
import { parseEjarContract, parseEjarSchedule } from '@/domain/pdf/parseEjar';

const HEAD = `
Ejar Contract
Contract No. 20260012345 / 1-2026
Tenant Data
Name مستأجر مصطنع للاختبار
ID No. 1000000017
Mobile No. +966500000101
Tenant Representative Data
Tenancy Start Date 2026-01-31
Tenancy End Date 2026-07-30
Total Contract value 6,000.00
Security Deposit
Amount 500.00
Rent payment cycle شهري
`;

const SCHEDULE = `
Rent Payments Schedule جدول سداد الدفعات
No. Due Date (Hijri) Due Date (Gregorian) Payment Deadline (Hijri) Payment Deadline (Gregorian) Amount
1 1447-08-12 2026-01-31 1447-09-12 2026-03-01 1,000.00
2 1447-09-11 2026-02-28 1447-10-11 2026-03-30 1,000.00
3 1447-10-12 2026-03-31 1447-11-12 2026-04-30 1,000.00
4 1447-11-13 2026-04-30 1447-12-13 2026-05-30 1,000.00
5 1447-12-14 2026-05-31 1448-01-14 2026-06-30 1,000.00
6 1448-01-15 2026-06-30 1448-02-15 2026-07-30 1,000.00
Obligations of the Parties
`;

const DATES = ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'];

describe('جدول الدفعات من ملف إيجار', () => {
  test('الترتيب المنطقي: التواريخ والمبالغ كما في الجدول', () => {
    const r = parseEjarContract(HEAD + SCHEDULE);
    expect(r.schedule?.map((x) => x.dueDate)).toEqual(DATES);
    expect(r.schedule?.every((x) => x.amountHalalas === 100000)).toBe(true);
    expect(r.found).toContain('schedule');
  });

  test('مستخرج يبتلع المسافات ويلصق الأرقام', () => {
    const glued = SCHEDULE.split('\n').map((l) => l.replace(/[ \t]+/g, '')).join('\n');
    expect(parseEjarSchedule(HEAD + glued)?.map((x) => x.dueDate)).toEqual(DATES);
    expect(parseEjarSchedule(HEAD + glued)?.map((x) => x.amountHalalas)).toEqual(Array(6).fill(100000));
  });

  test('العنوان العربي وحده معكوساً بصرياً', () => {
    const arOnly = SCHEDULE.replace('Rent Payments Schedule جدول سداد الدفعات', [...'جدول سداد الدفعات'].reverse().join(''));
    expect(parseEjarSchedule(HEAD + arOnly)?.length).toBe(6);
  });

  test('أعمدة الصف بترتيب الرسم (المهلة قبل الاستحقاق): الأبكر استحقاق والأبعد آخر المهلة · كلٌّ في خانته', () => {
    // كما يخرج من ملفٍ يرسم الجدول من اليمين: المبلغ ثم المهلة الهجرية ثم الاستحقاق الهجري ثم الفترة ثم المهلة الميلادية ثم الاستحقاق ثم الرقم
    const visual = `\nRent Payments Schedule\n` + DATES.map((d, i) => {
      const dl = ['2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10', '2026-07-10'][i];
      return `1,000.00 1448-01-0${i + 1} 1447-12-2${i + 1} يوم ${dl} ${d} ${i + 1}`;
    }).join('\n') + '\nObligations by Parties\n';
    const r = parseEjarSchedule(HEAD + visual)!;
    expect(r.map((x) => x.dueDate)).toEqual(DATES);
    expect(r.map((x) => x.deadline)).toEqual(['2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10', '2026-07-10']);
    // والترتيب المنطقي يعطي الشيء نفسه
    expect(parseEjarSchedule(HEAD + SCHEDULE)!.map((x) => [x.dueDate, x.deadline])[0]).toEqual(['2026-01-31', '2026-03-01']);
  });

  test('لا جدول في الملف: لا شيء يُقرأ', () => {
    const r = parseEjarContract(HEAD);
    expect(r.schedule).toBeUndefined();
    expect(r.found).not.toContain('schedule');
  });

  test('تاريخ خارج مدة العقد أو غير متصاعد: الجدول مرفوض كله', () => {
    expect(parseEjarSchedule(HEAD + SCHEDULE.replace('2026-02-28 1447', '2025-02-28 1447'))).toBeNull();
    expect(parseEjarSchedule(HEAD + SCHEDULE.replace('2026-03-31 1447', '2026-02-20 1447'))).toBeNull();
  });
});

describe('التوثيق من جدول الملف', () => {
  const setup = async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const db = memDb();
    const input = { ...contractInput(addUnit(db, addProperty(db)), { tenant: 'مستأجر مصطنع للاختبار', start: '2026-01-31', end: '2026-07-30', valueHalalas: 600000, cycle: 'شهرية', depositHalalas: 0 }) };
    return { db, input };
  };
  const dues = (db: import('@/db/adapter').DB, cid: string) =>
    db.all<{ d: string; a: number }>(`SELECT due_date AS d, amount_halalas AS a FROM contract_installments WHERE contract_id = ? ORDER BY sort`, [cid]);

  test('التواريخ والمبالغ من الجدول ولو خالفت الحساب · والمصدر «ملف»', async () => {
    const { db, input } = await setup();
    const { confirmContract } = await import('@/domain/contracts/service');
    // جدولٌ يستحق يوم ٢٥ من كل شهر: الحساب يعطي ٣١/٢٨… والملف يقول غير ذلك فيُؤخذ الملف
    const schedule = ['2026-01-31', '2026-02-25', '2026-03-25', '2026-04-25', '2026-05-25', '2026-06-25'].map((d) => ({ dueDate: d, amountHalalas: 100000 }));
    const cid = confirmContract(db, { ...input, schedule, fromEjarFile: true });
    expect(dues(db, cid).map((x) => x.d)).toEqual(schedule.map((x) => x.dueDate));
    expect(db.get<{ s: string }>(`SELECT installments_source AS s FROM contracts WHERE id = ?`, [cid])!.s).toBe('ملف');
  });

  test('آخر مهلة السداد من الجدول إلى مهلة القسط · لا إلى استحقاقه', async () => {
    const { db, input } = await setup();
    const { confirmContract } = await import('@/domain/contracts/service');
    const schedule = DATES.map((d, i) => ({ dueDate: d, deadline: ['2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10', '2026-07-10'][i], amountHalalas: 100000 }));
    const cid = confirmContract(db, { ...input, schedule, fromEjarFile: true });
    const r = db.all<{ d: string; g: string | null }>(`SELECT due_date AS d, grace_until AS g FROM contract_installments WHERE contract_id = ? ORDER BY sort`, [cid]);
    expect(r.map((x) => x.d)).toEqual(DATES);
    expect(r.map((x) => x.g)).toEqual(schedule.map((x) => x.deadline));
  });

  test('تعذّر الجدول: تُحسب الأقساط والمصدر «محسوبة» للتنبيه', async () => {
    const { db, input } = await setup();
    const { confirmContract } = await import('@/domain/contracts/service');
    const cid = confirmContract(db, { ...input, schedule: null, fromEjarFile: true });
    expect(dues(db, cid).map((x) => x.d).slice(0, 3)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(db.get<{ s: string }>(`SELECT installments_source AS s FROM contracts WHERE id = ?`, [cid])!.s).toBe('محسوبة');
  });

  test('الجدول يُحفظ مع المسودة ويُبنى منه عند التوثيق لاحقاً', async () => {
    const { db, input } = await setup();
    const { saveDraft, confirmContract } = await import('@/domain/contracts/service');
    const schedule = ['2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'].map((d) => ({ dueDate: d, amountHalalas: 100000 }));
    const id = saveDraft(db, { ...input, schedule, fromEjarFile: true });
    const cid = confirmContract(db, input, id);
    expect(dues(db, cid).map((x) => x.d)).toEqual(schedule.map((x) => x.dueDate));
  });

  test('مجموع الجدول لا يطابق القيمة: التواريخ منه والقيمة تُقسم بالهللات', async () => {
    const { db, input } = await setup();
    const { confirmContract } = await import('@/domain/contracts/service');
    const schedule = DATES.map((d) => ({ dueDate: d, amountHalalas: 90000 }));
    const cid = confirmContract(db, { ...input, schedule, fromEjarFile: true });
    const r = dues(db, cid);
    expect(r.map((x) => x.d)).toEqual(DATES);
    expect(r.reduce((s, x) => s + x.a, 0)).toBe(600000);
  });

  test('عقد أُدخل يدوياً: بلا مصدر', async () => {
    const { db, input } = await setup();
    const { confirmContract } = await import('@/domain/contracts/service');
    const cid = confirmContract(db, input);
    expect(db.get<{ s: string | null }>(`SELECT installments_source AS s FROM contracts WHERE id = ?`, [cid])!.s).toBeNull();
  });
});

describe('أداة مقارنة العقود القائمة بجدول ملفها', () => {
  const seed = async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const db = memDb();
    const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db)), { tenant: 'مستأجر مصطنع للاختبار', start: '2026-01-31', end: '2026-07-30', valueHalalas: 600000, cycle: 'شهرية', depositHalalas: 0 }));
    db.run(`INSERT OR IGNORE INTO blobs (sha256, ext, size_bytes, created_at) VALUES ('s1', 'pdf', 1, '2026-01-01T00:00:00Z')`);
    db.run(`INSERT INTO attachments (id, sha256, entity_type, entity_id, kind, original_name, mime, created_at) VALUES ('A1','s1','contract',?, 'lease','عقد.pdf','application/pdf','2026-01-01T00:00:00Z')`, [cid]);
    return { db, cid };
  };
  // الملف يقول: يوم ٢٥ من كل شهر بعد الأول
  const fileText = HEAD + SCHEDULE
    .replace('2026-02-28 1447', '2026-02-25 1447').replace('2026-03-31 1447', '2026-03-25 1447');

  test('المعاينة تسرد الفروق ولا تغيّر شيئاً · والتطبيق يصحّح التواريخ ويوسم العقد', async () => {
    const { db, cid } = await seed();
    const { previewEjarSchedules, applyEjarSchedules } = await import('@/domain/ejarScheduleRepair');
    const diffs = await previewEjarSchedules(db, async () => fileText);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].changes.filter((c) => c.from !== c.to).map((c) => [c.from, c.to])).toEqual([['2026-02-28', '2026-02-25'], ['2026-03-31', '2026-03-25']]);
    // وآخر المهلة من الملف لكل قسط · العقد المحسوب بلا مهلة
    expect(diffs[0].changes.map((c) => [c.graceFrom, c.graceTo])).toEqual([[null, '2026-03-01'], [null, '2026-03-30'], [null, '2026-04-30'], [null, '2026-05-30'], [null, '2026-06-30'], [null, '2026-07-30']]);
    expect(db.get<{ d: string }>(`SELECT due_date AS d FROM contract_installments WHERE contract_id = ? AND sort = 1`, [cid])!.d).toBe('2026-02-28');
    expect(applyEjarSchedules(db, diffs)).toBe(1);
    expect(db.get<{ d: string }>(`SELECT due_date AS d FROM contract_installments WHERE contract_id = ? AND sort = 1`, [cid])!.d).toBe('2026-02-25');
    expect(db.get<{ g: string }>(`SELECT grace_until AS g FROM contract_installments WHERE contract_id = ? AND sort = 1`, [cid])!.g).toBe('2026-03-30');
    expect(db.get<{ s: string }>(`SELECT installments_source AS s FROM contracts WHERE id = ?`, [cid])!.s).toBe('ملف');
    expect(await previewEjarSchedules(db, async () => fileText)).toEqual([]);
  });

  test('عدد مختلف أو جدول غير مقروء: موقوف بسببه', async () => {
    const { db } = await seed();
    const { previewEjarSchedules } = await import('@/domain/ejarScheduleRepair');
    const fewer = HEAD + SCHEDULE.split('\n').filter((l) => !l.startsWith('6 ')).join('\n');
    expect((await previewEjarSchedules(db, async () => fewer))[0].blocked).toMatch(/أقساطه 6 والجدول في الملف 5/);
    expect((await previewEjarSchedules(db, async () => HEAD))[0].blocked).toMatch(/جدول الدفعات/);
  });
});
