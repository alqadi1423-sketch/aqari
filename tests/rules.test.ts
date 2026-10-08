/**
 * اختبارات قواعد العمل الثلاث عشرة — اختبار لكل قاعدة (docs/DESIGN.md §٥)
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import {
  saveDraft, deleteDraft, confirmContract, cancelContract, renewContract,
  recordRentPayment, saveDepositSettlement, saveTenantRating, RuleViolation,
} from '@/domain/contracts/service';
import {
  contractDisplayId, keyMoneyBlockReason, getContract, unitCurrentContract, contractDisplayStatus,
  contractStatusLabel, contractStatusKind,
} from '@/domain/contracts/rules';
import { accountBalance } from '@/domain/accounting/ledger';
import { generateInstallments } from '@/domain/contracts/installments';
import { buildSectionsFromUnit, buildHandoverSections } from '@/domain/handover/build';
import { replaceMeters, utilitySuppliers, supplierMeters, metersForPurchase } from '@/domain/meters';
import { uid } from '@/domain/ids';
import { today, addDays } from '@/domain/dates';


/** قالب استلام وتسليم ينشئه المستخدم · بنص القالب المرجعي القديم */
function addTemplate(db: import('@/db/adapter').DB): void {
  const { LEGACY_HANDOVER_TEMPLATE } = require('@/db/seed');
  db.run(`INSERT INTO form_templates (id, name, is_system, sections_json, created_at) VALUES ('tpl-test','قالب اختبار',0,?,'2026-01-01')`,
    [JSON.stringify(LEGACY_HANDOVER_TEMPLATE)]);
}

describe('قواعد العمل الثلاث عشرة', () => {
  // ── القاعدة ١: نشاط العقار وفئته وفئة الطابق تقيّد عقود وحداته ──
  test('١ — نشاط العقار وفئته وفئة الطابق تقيّد العقود', () => {
    const db = memDb();
    // ١أ: نشاط مختلف
    const p1 = addProperty(db, { name: 'سكني صرف', activity_type: 'سكني' });
    const u1 = addUnit(db, p1, { type: 'محل' });
    expect(() => confirmContract(db, contractInput(u1))).toThrow(/مخصَّص لنشاط "سكني"/);
    // ١ب: فئة فرعية مختلفة
    const p2 = addProperty(db, { name: 'عوائل فقط', activity_type: 'سكني', activity_subtype: 'عوائل' });
    const u2 = addUnit(db, p2, { type: 'سكني', subtype: 'عزاب' });
    expect(() => confirmContract(db, contractInput(u2))).toThrow(/مخصَّص لفئة "عوائل" فقط/);
    // ١ج: فئة الطابق
    const p3 = addProperty(db, { name: 'طوابق مقيدة', activity_type: 'سكني' });
    db.run(`INSERT INTO property_floor_categories (property_id, floor_label, category) VALUES (?,?,?)`,
      [p3, 'الطابق 1', 'طالبات']);
    const u3 = addUnit(db, p3, { floor: 'الطابق 1', type: 'سكني', subtype: 'عوائل' });
    expect(() => confirmContract(db, contractInput(u3))).toThrow(/مخصَّص لفئة "طالبات" فقط/);
    // «مختلط» لا يقيّد
    const p4 = addProperty(db, { name: 'مختلط', activity_type: 'مختلط' });
    const u4 = addUnit(db, p4, { type: 'محل' });
    expect(() => confirmContract(db, contractInput(u4))).not.toThrow();
    db.close();
  });

  // ── القاعدة ٢: العقار المستأجَر من الغير يمنع تجاوز leaseEnd ──
  test('٢ — العقار المستأجَر من الغير يمنع أي عقد وحدة يتجاوز نطاق عقده', () => {
    const db = memDb();
    const p = addProperty(db, {
      name: 'مستأجر من الغير', ownership: 'إيجار',
      lease_start: '2026-01-01', lease_end: '2026-12-31',
    });
    const u = addUnit(db, p);
    expect(() =>
      confirmContract(db, contractInput(u, { start: '2026-06-01', end: '2027-05-31' }))
    ).toThrow(/لا يمكن تأجير الوحدة لفترة تتجاوز هذا النطاق/);
    expect(() =>
      confirmContract(db, contractInput(u, { start: '2026-02-01', end: '2026-11-30' }))
    ).not.toThrow();
    db.close();
  });

  // ── القاعدة ٣: منع تعارض العقود زمنياً ──
  test('٣ — منع تعارض العقود على نفس الوحدة زمنياً', () => {
    const db = memDb();
    const p = addProperty(db);
    const u = addUnit(db, p);
    confirmContract(db, contractInput(u, { tenant: 'الأول', start: '2026-01-01', end: '2026-12-31' }));
    expect(() =>
      confirmContract(db, contractInput(u, { tenant: 'الثاني', start: '2026-06-01', end: '2027-05-31' }))
    ).toThrow(/تتداخل مدته مع العقد/);
    // بعد نهاية الأول لا تعارض
    expect(() =>
      confirmContract(db, contractInput(u, { tenant: 'الثاني', start: '2027-01-01', end: '2027-12-31' }))
    ).not.toThrow();
    db.close();
  });

  // ── القاعدة ٤: الحجز بعربون يمنع التأجير لغير صاحبه ──
  test('٤ — الحجز بعربون يمنع غير صاحبه، ومعرّف الحجز (لا الاسم) يحوّله لعقد بقيده', () => {
    const db = memDb();
    const p = addProperty(db);
    const u = addUnit(db, p);
    const rid = uid();
    db.run(
      `INSERT INTO reservations (id, unit_id, name, deposit_halalas, expiry_date, created_date, status)
       VALUES (?,?,?,?,?,?,'نشط')`,
      [rid, u, 'صاحب الحجز', 100000, addDays(today(), 30), today()]
    );
    expect(() => confirmContract(db, contractInput(u, { tenant: 'دخيل' }))).toThrow(/محجوزة بعربون/);
    // نفس الاسم وحده لا يكفي (المراجعة ٤.٤) · التحويل باختيار الحجز بمعرّفه، وقيده 2450←الإيجار
    expect(() => confirmContract(db, contractInput(u, { tenant: 'صاحب الحجز' }))).toThrow(/محجوزة بعربون/);
    const before2450 = accountBalance(db, '2450');
    confirmContract(db, { ...contractInput(u, { tenant: 'صاحب الحجز' }), reservationId: rid });
    const r = db.get<{ status: string }>(`SELECT status FROM reservations WHERE id = ?`, [rid])!;
    expect(r.status).toBe('محوَّل لعقد');
    expect(accountBalance(db, '2450')).toBe(before2450 - 100000);
    db.close();
  });

  // ── القاعدة ٥: بعد الإنشاء لا يُعدَّل ولا يُحذف ──
  test('٥ — العقد الموثَّق مقفل: لا تعديل ولا حذف — يُلغى أو يُجدَّد فقط', () => {
    const db = memDb();
    const p = addProperty(db);
    const u = addUnit(db, p);
    const id = confirmContract(db, contractInput(u));
    expect(() => saveDraft(db, contractInput(u), id)).toThrow(/لا يُعدَّل/);
    expect(() => deleteDraft(db, id)).toThrow(/لا يُحذف/);
    db.close();
  });

  // ── القاعدة ٦: المسودة بلا رقم ولا تستهلك تسلسلاً ──
  test('٦ — المسودة بلا رقم وتُعرض «لا يوجد» ولا تستهلك رقماً، وتأخذ رقمها عند التأكيد', () => {
    const db = memDb();
    const p = addProperty(db);
    const u1 = addUnit(db, p);
    const u2 = addUnit(db, p);
    const u3 = addUnit(db, p);
    const draftId = saveDraft(db, contractInput(u1, { tenant: 'مسودة أولى' }));
    const d = getContract(db, draftId)!;
    expect(d.contract_no).toBeNull();
    expect(contractDisplayId(d)).toBe('لا يوجد');
    // مسودة لا تستهلك رقماً: عقد موثق بعدها يأخذ 001
    const c1 = confirmContract(db, contractInput(u2, { tenant: 'موثق أول' }));
    expect(getContract(db, c1)!.contract_no).toBe('EJ-2026-001');
    // تأكيد المسودة يمنحها الرقم التالي
    confirmContract(db, contractInput(u1, { tenant: 'مسودة أولى' }), draftId);
    expect(getContract(db, draftId)!.contract_no).toBe('EJ-2026-002');
    // والمسودة لا تشغل وحدة
    const draft2 = saveDraft(db, contractInput(u3, { tenant: 'مسودة ثانية' }));
    expect(unitCurrentContract(db, u3)).toBeNull();
    expect(getContract(db, draft2)!.status).toBe('مسودة');
    db.close();
  });

  // ── القاعدة ٧: التجديد ──
  test('٧ — التجديد قبل ٦٠ يوماً فقط، لا تجديد لعقد له خلف، والتجديد لانهائي', () => {
    const db = memDb();
    const p = addProperty(db);
    const u = addUnit(db, p);
    const T = today();
    // عقد ينتهي بعد 120 يوماً — التجديد ممنوع
    const far = confirmContract(db, contractInput(u, {
      tenant: 'بعيد', start: addDays(T, -100), end: addDays(T, 120),
    }));
    expect(() =>
      renewContract(db, far, {
        start: addDays(T, 121), end: addDays(T, 485), valueHalalas: 2400000, cycle: 'شهرية',
        carryDeposit: false, extraDepositHalalas: 0, services: '', furnished: '', ejarNo: '', note: '',
      })
    ).toThrow(/التجديد يتاح قبل انتهاء العقد بـ60 يوماً/);

    // عقد ينتهي بعد 30 يوماً — يُجدَّد، مع ترحيل التأمين (2400 لا يتغير)
    const u2 = addUnit(db, p);
    const c1 = confirmContract(db, contractInput(u2, {
      tenant: 'قريب', start: addDays(T, -335), end: addDays(T, 30), depositHalalas: 150000,
    }));
    const bal2400 = accountBalance(db, '2400');
    const newEnd = addDays(addDays(T, 31), 364);
    const c2 = renewContract(db, c1, {
      start: addDays(T, 31), end: newEnd, valueHalalas: 2600000, cycle: 'شهرية',
      carryDeposit: true, extraDepositHalalas: 0, services: '', furnished: '', ejarNo: '', note: '',
    });
    expect(accountBalance(db, '2400')).toBe(bal2400); // الترحيل لا يزيد الرصيد
    const old = getContract(db, c1)!;
    expect(old.status).toBe('منتهٍ');
    expect(old.renewed_to).toBe(getContract(db, c2)!.contract_no);
    // لا يُجدَّد عقد له خلف
    expect(() =>
      renewContract(db, c1, {
        start: addDays(newEnd, 1), end: addDays(newEnd, 365), valueHalalas: 2600000, cycle: 'شهرية',
        carryDeposit: false, extraDepositHalalas: 0, services: '', furnished: '', ejarNo: '', note: '',
      })
    ).toThrow(/مُجدَّد بالفعل/);
    // التجديد لانهائي: العقد الجديد يُجدَّد بدوره (نقرّب نهايته بعد نهاية سلفه)
    db.run(`UPDATE contracts SET end = ? WHERE id = ?`, [addDays(T, 40), c2]);
    const c3 = renewContract(db, c2, {
      start: addDays(T, 41), end: addDays(T, 405), valueHalalas: 2700000, cycle: 'شهرية',
      carryDeposit: false, extraDepositHalalas: 0, services: '', furnished: '', ejarNo: '', note: '',
    });
    expect(getContract(db, c3)!.renew_count).toBe(2);
    db.close();
  });

  // ── القاعدة ٨: التقييم والتصرف بالتأمين بعد الانتهاء فقط ──
  test('٨ — التقييم والتصرف بالتأمين لا يتاحان إلا بعد انتهاء العقد', () => {
    const db = memDb();
    const p = addProperty(db);
    const u = addUnit(db, p);
    const T = today();
    const active = confirmContract(db, contractInput(u, {
      tenant: 'نشط', start: addDays(T, -30), end: addDays(T, 300),
    }));
    // التأمين كاملاً بين الخصم والمسترَد (قرار المالك على #27: «والنقص لا يُحفظ حتى يُوزَّع»)
    const settlement = { date: T, deductionHalalas: 0, deductionReason: '', refundHalalas: 200000, notes: '' };
    const rating = { onTime: 'ممتاز', paymentCommit: 'ممتاز', contractCommit: 'ممتاز', unitCondition: 'ممتاز', neighborComplaints: 'لا توجد', notes: '' };
    expect(() => saveDepositSettlement(db, active, settlement)).toThrow(/يتاح بعد انتهاء العقد/);
    expect(() => saveTenantRating(db, active, rating)).toThrow(/يتاح بعد انتهاء العقد/);
    // عقد منتهٍ زمنياً
    db.run(`UPDATE contracts SET start = ?, end = ? WHERE id = ?`, [addDays(T, -400), addDays(T, -35), active]);
    expect(() => saveDepositSettlement(db, active, settlement)).not.toThrow();
    expect(() => saveTenantRating(db, active, rating)).not.toThrow();
    db.close();
  });

  // ── القاعدة ٩: التقبيل لا يُسجَّل على ملغى أو مسودة ──
  test('٩ — التقبيل ممنوع على العقد الملغى والمسودة', () => {
    const db = memDb();
    const p = addProperty(db);
    const u = addUnit(db, p);
    const draftId = saveDraft(db, contractInput(u));
    expect(keyMoneyBlockReason(getContract(db, draftId)!)).toMatch(/مسودة/);
    confirmContract(db, contractInput(u), draftId);
    expect(keyMoneyBlockReason(getContract(db, draftId)!)).toBeNull();
    cancelContract(db, draftId, { date: today(), reason: '', installmentsFate: 'keep', settle: false, deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });
    expect(keyMoneyBlockReason(getContract(db, draftId)!)).toMatch(/ملغى/);
    db.close();
  });

  // ── القاعدة ١٠: جدول الدفعات يُولَّد عند الإنشاء ولا يُعاد توليده ──
  test('١٠ — جدول الدفعات يُولَّد آلياً مرة واحدة والقسط الأخير يمتص فرق التقريب', () => {
    const db = memDb();
    // 12 شهراً شهرية بقيمة 100000 ريال = 10000000 هللة: 12 قسطاً
    const insts = generateInstallments('2026-01-01', '2026-12-31', 10000000, 'شهرية');
    expect(insts).toHaveLength(12);
    expect(insts.reduce((s, i) => s + i.amountHalalas, 0)).toBe(10000000);
    // قيمة لا تقبل القسمة: 1000.01 ريال على 3 أقساط ربع سنوية (9 أشهر... نستخدم سنوية 3 أشهر)
    const odd = generateInstallments('2026-01-01', '2026-03-31', 100001, 'شهرية');
    expect(odd.reduce((s, i) => s + i.amountHalalas, 0)).toBe(100001);

    // لا يُعاد توليده: التوثيق لا يمس جدولاً قائماً
    const p = addProperty(db);
    const u = addUnit(db, p);
    const draftId = saveDraft(db, contractInput(u));
    db.run(
      `INSERT INTO contract_installments (id, contract_id, due_date, amount_halalas, sort) VALUES (?,?,?,?,0)`,
      ['PRESET', draftId, '2026-01-01', 999999, ]
    );
    confirmContract(db, contractInput(u), draftId);
    const rows = db.all(`SELECT id FROM contract_installments WHERE contract_id = ?`, [draftId]);
    expect(rows).toHaveLength(1); // بقي الجدول الموجود ولم يُولَّد غيره
    db.close();
  });

  // ── القاعدة ١١: الإلغاء والخصم والمطالبة التلقائية ──
  test('١١ — إلغاء العقد: خصم من التأمين، والفائض مطالبة تلقائية بالفرق', () => {
    const db = memDb();
    const p = addProperty(db);
    const u = addUnit(db, p);
    const T = today();
    const id = confirmContract(db, contractInput(u, {
      depositHalalas: 100000, start: addDays(T, -100), end: addDays(T, 200),
    }));
    const { excessClaimCreated } = cancelContract(db, id, {
      date: T, reason: 'أضرار جسيمة', installmentsFate: 'cancel',
      settle: true, deductionHalalas: 150000, refundHalalas: 0, deductionReason: 'إصلاح تلفيات',
    });
    expect(excessClaimCreated).toBe(true);
    const claim = db.get<{ amount_halalas: number; source: string; status: string }>(
      `SELECT amount_halalas, source, status FROM claims WHERE contract_id = ?`, [id]
    )!;
    expect(Number(claim.amount_halalas)).toBe(50000); // الفرق فقط
    expect(claim.source).toBe('تسوية تأمين');
    expect(claim.status).toBe('مفتوحة');
    expect(accountBalance(db, '1250')).toBe(50000);
    expect(accountBalance(db, '2400')).toBe(0); // التأمين أُطفئ كاملاً
    const c = getContract(db, id)!;
    expect(c.status).toBe('ملغى');
    expect(c.end).toBe(T); // الوحدة تصبح متاحة من تاريخ الإلغاء
    // الدفعات المستقبلية غير المدفوعة أُلغيت
    const stats = db.all<{ status: string }>(
      `SELECT status FROM contract_installments WHERE contract_id = ? AND due_date >= ?`, [id, T]
    );
    for (const s of stats) expect(s.status).toBe('ملغية');
    db.close();
  });

  // ── القاعدة ١٢: نماذج الاستلام تُبنى آلياً من تفاصيل الوحدة والعقار ──
  test('١٢ — نموذج الاستلام يُبنى من غرف الوحدة وأقسام العقار، وإلا فقالب المستخدم', () => {
    const db = memDb();
    const p = addProperty(db);
    const u = addUnit(db, p);
    // بلا تفاصيل ولا قالب ← لا أقسام (لا قالب يُزرع · قرار المالك ٢٠٢٦-١٠-٠٥)
    expect(buildSectionsFromUnit(db, u)).toBeNull();
    expect(buildHandoverSections(db, u, null)).toEqual([]);
    // بقالبٍ أنشأه المستخدم ← أقسامه
    addTemplate(db);
    const fromTemplate = buildHandoverSections(db, u, null);
    expect(fromTemplate).toHaveLength(7);
    expect(fromTemplate[0].section).toBe('المدخل / الصالة الرئيسية');
    // بتفاصيل ← تُبنى منها + قسما العدادات والحالة العامة
    const roomId = uid();
    db.run(`INSERT INTO unit_rooms (id, unit_id, room_name, sort) VALUES (?,?,?,0)`, [roomId, u, 'الصالة']);
    db.run(`INSERT INTO unit_room_items (id, room_id, name, descr, sort) VALUES (?,?,?,?,0)`,
      [uid(), roomId, 'أريكة', 'مقعدان']);
    const areaId = uid();
    db.run(`INSERT INTO property_areas (id, property_id, area_name, sort) VALUES (?,?,?,0)`, [areaId, p, 'المصعد']);
    db.run(`INSERT INTO property_area_items (id, area_id, name, descr, sort) VALUES (?,?,?,'',0)`,
      [uid(), areaId, 'كبينة المصعد']);
    const auto = buildSectionsFromUnit(db, u)!;
    expect(auto.map((s) => s.section)).toEqual(['الصالة', 'مشترك: المصعد', 'العدادات والمفاتيح', 'الحالة العامة']);
    expect(auto[0].items[0].name).toBe('أريكة · مقعدان');
    db.close();
  });

  // ── القاعدة ١٣: العدّاد يشير لمورده ──
  test('١٣ — العداد يرتبط بمورد نوعه فقط، وفاتورة الشراء تعرض عدادات المورد', () => {
    const db = memDb();
    const p = addProperty(db);
    const u = addUnit(db, p);
    const supElec = uid(), supWater = uid(), supPlain = uid();
    db.run(`INSERT INTO suppliers (id, name, utility_type, created_at) VALUES (?,?,?,?)`,
      [supElec, 'شركة الكهرباء', 'كهرباء', 'x']);
    db.run(`INSERT INTO suppliers (id, name, utility_type, created_at) VALUES (?,?,?,?)`,
      [supWater, 'شركة المياه', 'ماء', 'x']);
    db.run(`INSERT INTO suppliers (id, name, utility_type, created_at) VALUES (?,?,'',?)`,
      [supPlain, 'مورد عادي', 'x']);
    // الميزة لنوعين فقط
    expect(utilitySuppliers(db, 'كهرباء').map((s) => s.id)).toEqual([supElec]);
    expect(utilitySuppliers(db, 'ماء').map((s) => s.id)).toEqual([supWater]);
    // عدادات كثيرة لمورد واحد + عداد الإنترنت لا يحمل مورداً
    replaceMeters(db, 'unit', u, [
      { kind: 'كهرباء', number: 'E-1', supplierId: supElec },
      { kind: 'كهرباء', number: 'E-2', supplierId: supElec },
      { kind: 'ماء', number: 'W-1', supplierId: supWater },
      { kind: 'إنترنت', number: 'N-1', supplierId: supElec }, // يُتجاهل الربط
    ]);
    expect(supplierMeters(db, supElec)).toHaveLength(2);
    expect(supplierMeters(db, supWater)).toHaveLength(1);
    const net = db.get<{ supplier_id: string | null }>(
      `SELECT supplier_id FROM meters WHERE number = 'N-1'`
    )!;
    expect(net.supplier_id).toBeNull();
    // اختيار المورد في فاتورة الشراء يعرض كل عدّاداته، ويضيَّق بالعقار
    expect(metersForPurchase(db, supElec).map((m) => m.number).sort()).toEqual(['E-1', 'E-2']);
    const p2 = addProperty(db, { name: 'عقار آخر' });
    replaceMeters(db, 'property', p2, [{ kind: 'كهرباء', number: 'E-9', supplierId: supElec }]);
    expect(metersForPurchase(db, supElec, p2).map((m) => m.number)).toEqual(['E-9']);
    db.close();
  });

  // ── تكامل: دفعة إيجار متعددة الطرق تحدّث القسط وقيده وحركات البنك ──
  test('تكامل — سداد متعدد الطرق يحدّث القسط والدفتر وحركة البنك', () => {
    const db = memDb();
    const p = addProperty(db);
    const u = addUnit(db, p);
    const bankId = uid();
    db.run(`INSERT INTO banks (id, name, opening_halalas, created_at) VALUES (?,?,0,'x')`, [bankId, 'الراجحي']);
    const cid = confirmContract(db, contractInput(u, { valueHalalas: 1200000, cycle: 'شهرية' }));
    const inst = db.get<{ id: string; amount_halalas: number }>(
      `SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`,
      [cid]
    )!;
    recordRentPayment(db, cid, {
      installmentId: inst.id, period: 'ينا 2026', date: '2026-01-05',
      lines: [
        { method: 'bank', bankId, amountHalalas: 60000 },
        { method: 'cash', amountHalalas: 40000 },
      ],
      discountHalalas: 0, notes: '',
    });
    const after = db.get<{ paid_halalas: number; status: string }>(
      `SELECT paid_halalas, status FROM contract_installments WHERE id = ?`, [inst.id]
    )!;
    expect(Number(after.paid_halalas)).toBe(100000);
    expect(after.status).toBe('مدفوعة');
    expect(accountBalance(db, '4200')).toBeGreaterThanOrEqual(100000);
    const tx = db.get<{ amount_halalas: number }>(
      `SELECT amount_halalas FROM bank_tx WHERE bank_id = ?`, [bankId]
    )!;
    expect(Number(tx.amount_halalas)).toBe(60000);
    db.close();
  });
});

describe('النموذج المرجعي للاستلام والتسليم', () => {
  test('القالب: ٧ أقسام و٨٣ بنداً بأربعة أعمدة لكل بند', () => {
    const db = memDb();
    addTemplate(db);
    const raw = db.get<{ sections_json: string }>(
      `SELECT sections_json FROM form_templates WHERE id = 'tpl-test'`
    )!;
    const sections = JSON.parse(raw.sections_json) as Array<{ section: string; items: string[] }>;
    expect(sections.length).toBe(7);
    expect(sections.reduce((s, x) => s + x.items.length, 0)).toBe(83);
    // البناء من القالب: كل بند بأعمدته الأربعة
    const { sectionsFromTemplate } = require('@/domain/handover/build');
    const built = sectionsFromTemplate(db, 'tpl-test');
    const item = built[0].items[0];
    for (const k of ['count', 'receiveCondition', 'deliverCondition', 'notes']) expect(k in item).toBe(true);
    db.close();
  });

  test('الدمج: غرف الوحدة تُكمَّل بأقسام القالب غير المغطاة', () => {
    const db = memDb();
    const pid = addProperty(db);
    const uidd = addUnit(db, pid);
    const roomId = 'R_' + uidd;
    db.run(`INSERT INTO unit_rooms (id, unit_id, room_name, sort) VALUES (?,?,?,0)`, [roomId, uidd, 'المطبخ']);
    db.run(`INSERT INTO unit_room_items (id, room_id, name, descr, sort) VALUES (?,?,?,?,0)`, ['I_' + uidd, roomId, 'ثلاجة', '']);
    const { buildHandoverSections } = require('@/domain/handover/build');
    addTemplate(db);
    const secs = buildHandoverSections(db, uidd, null) as Array<{ section: string }>;
    // قسم الوحدة المدخل أولاً، وأقسام القالب غير المغطاة (كالحمامات) تلحق به
    expect(secs[0].section).toBe('المطبخ');
    expect(secs.some((s) => s.section === 'الحمامات')).toBe(true);
    expect(secs.filter((s) => s.section.includes('مطبخ')).length).toBe(1); // لا تكرار للمطبخ
    db.close();
  });
});

describe('حالة العقد من دالة واحدة · الحالات الست بترتيب أسبقيتها', () => {
  const T = '2026-08-22';
  const mk = (status: string, start: string | null, end: string | null) =>
    contractDisplayStatus({ status, start, end } as never, T);
  test('ملغى يسبق كل شيء ثم مسودة ثم موثَّق ولم يبدأ ثم سارٍ وينتهي قريباً ثم منتهٍ', () => {
    expect(mk('ملغى', '2026-01-01', '2026-12-31')).toBe('ملغى');
    expect(mk('مسودة', null, null)).toBe('مسودة');
    expect(mk('سارٍ', '2026-09-01', '2027-08-31')).toBe('موثَّق ولم يبدأ');
    expect(mk('سارٍ', '2026-01-01', '2026-06-30')).toBe('منتهٍ');
    // يتبقى ١٣١ يوماً: سارٍ لا «ينتهي قريباً» (خطأ اصطيد على المحاكي)
    expect(mk('سارٍ', '2026-01-01', '2026-12-31')).toBe('سارٍ');
    // يتبقى ٤٠ يوماً: ينتهي قريباً
    expect(mk('سارٍ', '2026-01-01', '2026-10-01')).toBe('ينتهي قريباً');
  });

  /**
   * حالة مصطنعة: عقود مخزَّنة «سارٍ» تبدأ ١ أكتوبر واليوم ٢٤ سبتمبر ·
   * كل شاشة تعرض الحالة تستدعي هاتين الدالتين فلا تتناقض شاشة مع أخرى.
   */
  test('نص الحالة ولونها محسوبان من التواريخ لا من الحالة المخزَّنة', () => {
    const T2 = '2026-09-24';
    const future = { status: 'سارٍ', start: '2026-10-01', end: '2027-09-30' };
    expect(contractStatusLabel(future, T2)).toBe('موثَّق ولم يبدأ');
    expect(contractStatusKind(future, T2)).toBe('due');
    // والعقد الجاري فعلاً يبقى سارياً بلونه
    const live = { status: 'سارٍ', start: '2026-01-01', end: '2026-12-31' };
    expect(contractStatusLabel(live, T2)).toBe('سارٍ');
    expect(contractStatusKind(live, T2)).toBe('paid');
    // والمقترب من نهايته يُعرض بعدد أيامه
    expect(contractStatusLabel({ status: 'سارٍ', start: '2026-01-01', end: '2026-11-01' }, T2))
      .toBe('ينتهي بعد 38 يوماً');
    expect(contractStatusLabel({ status: 'سارٍ', start: '2026-01-01', end: '2026-09-25' }, T2))
      .toBe('ينتهي غداً');
  });
});
