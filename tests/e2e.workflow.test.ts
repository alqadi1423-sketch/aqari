/**
 * سيناريو متكامل من طرف لطرف — دورة الاستخدام الكاملة كما تمر عبر الشاشات:
 * عقار ← وحدات ← مورد وعدادات ← حجز ← مسودة عقد ← توثيق ← تحصيل متعدد ←
 * تجديد ← إلغاء بمطالبة تلقائية ← تحصيل المطالبة ← فواتير ← مشتريات وسداد ←
 * تقبيل ← نموذج استلام ← مكتبة ← تنبيهات ← سلة ← فحوص ← نسخة واستعادة نظيفة.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { saveProperty, saveUnit, bulkAddUnits } from '@/domain/propertiesService';
import { replaceMeters, supplierMeters, metersForPurchase, meterReadings } from '@/domain/meters';
import { createReservation, cancelReservation } from '@/domain/reservations';
import {
  saveDraft, confirmContract, recordRentPayment, renewContract, cancelContract,
  saveDepositSettlement, saveTenantRating,
} from '@/domain/contracts/service';
import { getContract, contractDisplayId, unitCurrentContract, unitActiveReservation } from '@/domain/contracts/rules';
import { saveClaim, collectClaim } from '@/domain/claims';
import { saveInvoice, setInvoiceStatus, payInvoice, deleteInvoice } from '@/domain/invoices';
import { savePurchase, payPurchase, unmarkPurchasePaid } from '@/domain/purchases';
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { buildHandoverSections } from '@/domain/handover/build';
import { putAttachment, liveBlobs } from '@/files/store';
import { libraryFiles } from '@/domain/library';
import { computeReminders, computeSchedule } from '@/domain/reminders';
import { trashItems, restoreFromTrash } from '@/domain/trash';
import { accountBalance } from '@/domain/accounting/ledger';
import { bankBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { allInstallments, collectKpis, tenantOutstanding, propertyStats, unitStatusInfo } from '@/domain/stats';
import { createBackup } from '@/domain/backup/create';
import { restoreBackup } from '@/domain/backup/restore';
import { templateContext, resolveTemplateTokens } from '@/domain/templates';
import { today, addDays } from '@/domain/dates';
import { uid } from '@/domain/ids';

let dirs: string[] = [];
function newDir(): string { const d = tempDir('aqari-e2e-'); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmrf(d); });

test('دورة الاستخدام الكاملة تعمل من الطرف للطرف وتبقي الدفتر متوازناً', async () => {
  const env = makeBackupEnv(newDir());
  const db = env.db;
  const T = today();

  /* ═══ ١) عقار بطوابق وفئات وأقسام وعدادات ═══ */
  const propertyId = saveProperty(db, {
    name: 'برج الاختبار الشامل', address: 'الرياض — طريق الملك فهد',
    floors: 2, activityType: 'سكني', activitySubtype: '',
    ownership: 'ملك', deedNo: '410123456789',
    leaseValueHalalas: null, leaseCycle: null, leaseStart: null, leaseEnd: null,
    opRate: null, lat: 24.7136, lng: 46.6753,
    floorCategories: { 'الطابق 1': 'عوائل' },
    areas: [{ name: 'المدخل الرئيسي', items: [{ name: 'باب زجاجي', descr: 'مزدوج' }] }],
    meters: [],
  });
  expect(db.get(`SELECT id FROM properties WHERE id = ?`, [propertyId])).toBeTruthy();

  /* ═══ ٢) مورد كهرباء وعداداته على الوحدة ═══ */
  const supplierId = uid();
  db.run(`INSERT INTO suppliers (id, name, utility_type, created_at) VALUES (?,?,?,?)`,
    [supplierId, 'الشركة السعودية للكهرباء', 'كهرباء', new Date().toISOString()]);

  const unit1 = saveUnit(db, {
    propertyId, unitNo: 'A-1', floor: 'الأرضي', type: 'سكني', subtype: 'عوائل',
    rentMonthlyHalalas: 250000,
    rooms: [{ name: 'الصالة', items: [{ name: 'مكيف سبلت', descr: '' }] }],
    meters: [{ kind: 'كهرباء', number: 'E-100', supplierId }],
  });
  const { added } = bulkAddUnits(db, propertyId, 3, {
    prefix: 'B-', start: 1, floor: 'الطابق 1', type: 'سكني', subtype: 'عوائل', rentHalalas: 200000,
  });
  expect(added).toBe(3);
  expect(supplierMeters(db, supplierId)).toHaveLength(1);
  expect(metersForPurchase(db, supplierId, propertyId).map((m) => m.number)).toEqual(['E-100']);

  /* ═══ ٣) بنك ═══ */
  const bankId = uid();
  db.run(`INSERT INTO banks (id, name, opening_halalas, opening_date, created_at) VALUES (?,?,?,?,?)`,
    [bankId, 'الراجحي', 1000000, T, new Date().toISOString()]);

  /* ═══ ٤) حجز بعربون يمنع الغير ثم يتحول لعقد لصاحبه ═══ */
  const rsvId = createReservation(db, {
    unitId: unit1, name: 'فيصل الاسمري', phone: '0501111111',
    depositHalalas: 100000, expiryDate: addDays(T, 30),
  });
  expect(accountBalance(db, '2450')).toBe(100000);
  expect(unitStatusInfo(db, { id: unit1, under_maintenance: 0 }).key).toBe('reserved');

  /* ═══ ٥) مسودة بلا رقم ثم توثيق بمراجعة ═══ */
  const input = {
    tenant: 'فيصل الاسمري', phone: '0501111111', idNumber: '1055555555',
    unitId: unit1, valueHalalas: 3000000, cycle: 'شهرية',
    start: T, end: addDays(T, 364), depositHalalas: 300000,
    ejarNo: '', services: 'ماء', furnished: 'غير مؤثثة', typeSpecific: {},
  };
  const contractId = saveDraft(db, input);
  expect(contractDisplayId(getContract(db, contractId)!)).toBe('لا يوجد');
  confirmContract(db, { ...input, reservationId: rsvId }, contractId); // التحويل بمعرّف الحجز (المراجعة ٤.٤)
  const c = getContract(db, contractId)!;
  expect(c.contract_no).toMatch(/^EJ-\d{4}-001$/);
  expect(c.status).toBe('سارٍ');
  // جدول الدفعات وُلّد ومجموعه = قيمة العقد بالهللة
  const insts = db.all<{ id: string; amount_halalas: number }>(
    `SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [contractId]
  );
  expect(insts.reduce((s, i) => s + Number(i.amount_halalas), 0)).toBe(3000000);
  // التأمين رُحّل والعربون تحوّل
  expect(accountBalance(db, '2400')).toBe(300000);
  expect(accountBalance(db, '2450')).toBe(0);
  expect(unitActiveReservation(db, unit1)).toBeNull();
  expect(unitCurrentContract(db, unit1)?.id).toBe(contractId);

  // العربون (١٠٠٠) سدّد من القسط الأول بتاريخ العقد (المراجعة ٤.٤)
  expect(db.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = ?`, [insts[0].id])!.p).toBe(100000);

  /* ═══ ٦) تحصيل متعدد الطرق: جزئي ثم إكمال ═══ */
  recordRentPayment(db, contractId, {
    installmentId: insts[0].id, period: 'الشهر الأول', date: T,
    lines: [
      { method: 'bank', bankId, amountHalalas: 100000 },
      { method: 'cash', amountHalalas: 20000 },
    ],
    discountHalalas: 0, notes: '',
  });
  let inst0 = db.get<{ status: string; paid_halalas: number }>(
    `SELECT status, paid_halalas FROM contract_installments WHERE id = ?`, [insts[0].id])!;
  expect(inst0.status).toBe('مدفوعة جزئياً');
  recordRentPayment(db, contractId, {
    installmentId: insts[0].id, period: 'الشهر الأول', date: T,
    lines: [{ method: 'cash', amountHalalas: Number(insts[0].amount_halalas) - 120000 - 100000 }],
    discountHalalas: 0, notes: 'إكمال',
  });
  inst0 = db.get<{ status: string; paid_halalas: number }>(
    `SELECT status, paid_halalas FROM contract_installments WHERE id = ?`, [insts[0].id])!;
  expect(inst0.status).toBe('مدفوعة');
  expect(bankBalance(db, bankId)).toBe(1000000 + 100000);
  expect(accountBalance(db, '4200')).toBe(Number(insts[0].amount_halalas));
  // شاشة التحصيل ترى الحال
  const kpis = collectKpis(allInstallments(db, T), T);
  expect(kpis.paidThisMonth).toBe(Number(insts[0].amount_halalas));
  expect(tenantOutstanding(db, 'فيصل الاسمري')).toBe(3000000 - Number(insts[0].amount_halalas));

  /* ═══ ٧) قوالب الرسائل تُحلّ رموزها من العقد ═══ */
  const msg = resolveTemplateTokens('عزيزي {المستأجر}، المتبقي {المتبقي} على وحدة {الوحدة}',
    templateContext(db, contractId));
  expect(msg).toContain('فيصل الاسمري');
  expect(msg).toContain('A-1');

  /* ═══ ٨) نموذج الاستلام يُبنى من تفاصيل الوحدة ═══ */
  const sections = buildHandoverSections(db, unit1, null);
  expect(sections.map((s) => s.section)).toContain('الصالة');
  expect(sections.map((s) => s.section)).toContain('مشترك: المدخل الرئيسي');

  /* ═══ ٩) عقد ثانٍ يقترب انتهاؤه ← تجديد بترحيل تأمين ═══ */
  const unit2 = db.get<{ id: string }>(
    `SELECT id FROM units WHERE property_id = ? AND unit_no = 'B-1'`, [propertyId])!.id;
  const c2input = { ...input, tenant: 'سعد قاسم', phone: '0502222222', unitId: unit2,
    start: addDays(T, -335), end: addDays(T, 30), depositHalalas: 150000 };
  const c2 = confirmContract(db, c2input);
  const before2400 = accountBalance(db, '2400');
  const c3 = renewContract(db, c2, {
    start: addDays(T, 31), end: addDays(addDays(T, 31), 364),
    valueHalalas: 3300000, cycle: 'شهرية', carryDeposit: true, extraDepositHalalas: 50000,
    services: '', furnished: 'غير مؤثثة', ejarNo: '', note: 'تجديد بزيادة 10٪',
  });
  expect(getContract(db, c2)!.status).toBe('منتهٍ');
  expect(getContract(db, c2)!.renewed_to).toBe(getContract(db, c3)!.contract_no);
  expect(accountBalance(db, '2400')).toBe(before2400 + 50000); // الترحيل لم يزد إلا الإضافي

  /* ═══ ١٠) إلغاء بخصم يتجاوز التأمين ← مطالبة تلقائية ثم تحصيلها ═══ */
  const { excessClaimCreated } = cancelContract(db, c3, {
    date: addDays(T, 40), reason: 'إخلال', installmentsFate: 'cancel',
    settle: true, deductionHalalas: 250000, refundHalalas: 0, deductionReason: 'أضرار',
  });
  expect(excessClaimCreated).toBe(true);
  const autoClaim = db.get<{ id: string; amount_halalas: number; source: string }>(
    `SELECT id, amount_halalas, source FROM claims WHERE contract_id = ?`, [c3])!;
  expect(autoClaim.source).toBe('تسوية تأمين');
  expect(Number(autoClaim.amount_halalas)).toBe(50000); // 250000 − 200000 تأمين c3
  expect(accountBalance(db, '1250')).toBe(50000);
  collectClaim(db, autoClaim.id);
  expect(accountBalance(db, '1250')).toBe(0);

  /* ═══ ١١) مطالبة يدوية ═══ */
  const manualClaim = saveClaim(db, {
    contractId, amountHalalas: 20000, reason: 'كسر زجاج', date: T,
  });
  expect(accountBalance(db, '1250')).toBe(20000);

  /* ═══ ١٢) فاتورة مبيعات: إصدار ← مدفوعة ← مسودة تعكس القيد ═══ */
  const invId = saveInvoice(db, {
    customer: 'شركة أفق', customerVat: '300012345600003',
    issue: T, due: addDays(T, 30), notes: '',
    lines: [{ descr: 'إيجار مساحة إعلانية', qty: 2, priceHalalas: 50000, taxPct: 15 }],
  }, 'مستحقة');
  expect(accountBalance(db, '1200')).toBeGreaterThan(0);
  const invEntry1 = db.get<{ journal_entry_id: string }>(
    `SELECT journal_entry_id FROM invoices WHERE id = ?`, [invId])!.journal_entry_id;
  payInvoice(db, invId, { method: 'cash', bankId: null, date: T }); // التحصيل بقيد (المراجعة ٤.٢)
  expect(() => setInvoiceStatus(db, invId, 'مدفوعة')).toThrow();
  setInvoiceStatus(db, invId, 'مسودة'); // يعكس القيد بقيد مرآة ولا يخفيه
  const ar = accountBalance(db, '1200');
  setInvoiceStatus(db, invId, 'مستحقة'); // يعيد الترحيل
  expect(accountBalance(db, '1200')).toBe(ar + 115000);
  // القيد الأصلي باقٍ في الدفتر مختوماً بمن عكسه · لا إخفاء ناعم لمرحّل
  const inv1 = db.get<{ deleted_at: string | null; reversed_by: string | null }>(
    `SELECT deleted_at, reversed_by FROM journal_entries WHERE id = ?`, [invEntry1])!;
  expect(inv1.deleted_at).toBeNull();
  expect(inv1.reversed_by).toBeTruthy();

  /* ═══ ١٢ب) تعديل فاتورة مرحّلة: عكس الأصل وترحيل الجديد وسجل بالقيم ═══ */
  const beforeEntry = db.get<{ journal_entry_id: string }>(
    `SELECT journal_entry_id FROM invoices WHERE id = ?`, [invId])!.journal_entry_id;
  saveInvoice(db, {
    customer: 'شركة أفق', customerVat: '300012345600003',
    issue: T, due: addDays(T, 30), notes: '',
    lines: [{ descr: 'إيجار مساحة إعلانية', qty: 3, priceHalalas: 50000, taxPct: 15 }],
  }, 'مستحقة', invId);
  const old = db.get<{ deleted_at: string | null; reversed_by: string | null }>(
    `SELECT deleted_at, reversed_by FROM journal_entries WHERE id = ?`, [beforeEntry])!;
  expect(old.deleted_at).toBeNull();
  expect(old.reversed_by).toBeTruthy();
  const rev = db.get<{ memo: string; status: string }>(
    `SELECT memo, status FROM journal_entries WHERE id = ?`, [old.reversed_by])!;
  expect(rev.status).toBe('مرحّل');
  expect(rev.memo).toContain('تعديل الفاتورة');
  // الرصيد يعكس القيم الجديدة وحدها (172,500 = 150,000 + ضريبة) بعد عكس القديمة
  expect(accountBalance(db, '1200')).toBe(ar + 172500);
  const audit = db.get<{ before_json: string | null; after_json: string | null }>(
    `SELECT before_json, after_json FROM audit_log
     WHERE module = 'الفواتير' AND action_type = 'update' AND before_json IS NOT NULL
     ORDER BY id DESC LIMIT 1`)!;
  expect(JSON.parse(audit.before_json!)['الإجمالي']).toBe(115000);
  expect(JSON.parse(audit.after_json!)['الإجمالي']).toBe(172500);

  /* ═══ ١٣) فاتورة شراء بعداد: تسجيل ← سداد بنكي ← تراجع ═══ */
  const meterId = supplierMeters(db, supplierId)[0].id;
  const purId = savePurchase(db, {
    supplier: 'الشركة السعودية للكهرباء', date: T, due: addDays(T, 10),
    category: 'كهرباء', incorpItem: '', amortize: false, amortizeMonths: null,
    exempt: false, excludeFromVat: false, unitId: unit1, propertyId,
    subtotalHalalas: 40000, taxHalalas: 6000, totalHalalas: 46000, meterId, meterReading: 5230,
  });
  expect(meterReadings(db, meterId)).toHaveLength(1);
  expect(accountBalance(db, '2100')).toBe(46000); // 40000 + 15٪
  payPurchase(db, purId, 'bank', bankId, T);
  expect(accountBalance(db, '2100')).toBe(0);
  expect(bankBalance(db, bankId)).toBe(1100000 - 46000);
  const payJeId = db.get<{ payment_journal_entry_id: string }>(
    `SELECT payment_journal_entry_id FROM purchases WHERE id = ?`, [purId])!.payment_journal_entry_id;
  const payJeNo = db.get<{ no: string }>(
    `SELECT no FROM journal_entries WHERE id = ?`, [payJeId])!.no;
  unmarkPurchasePaid(db, purId);
  expect(accountBalance(db, '2100')).toBe(46000);
  expect(bankBalance(db, bankId)).toBe(1100000);
  // التراجع قيدٌ عكسي لا إخفاء: قيد السداد باقٍ بلا deleted_at ومختوم بقيد العكس
  const payJe = db.get<{ deleted_at: string | null; reversed_by: string | null }>(
    `SELECT deleted_at, reversed_by FROM journal_entries WHERE id = ?`, [payJeId])!;
  expect(payJe.deleted_at).toBeNull();
  expect(payJe.reversed_by).not.toBeNull();
  const revJe = db.get<{ no: string; status: string; memo: string; src_type: string }>(
    `SELECT no, status, memo, src_type FROM journal_entries WHERE id = ?`, [payJe.reversed_by!])!;
  expect(revJe.status).toBe('مرحّل');
  expect(revJe.src_type).toBe('purchase_pay_rev');
  expect(revJe.memo).toContain('عكس سداد الفاتورة');
  expect(revJe.memo).toContain(payJeNo);
  // كشف البنك صادق مع الدفتر: الحركة الأصلية باقية وتقابلها حركة معاكسة مرتبطة بقيد العكس
  const origTx = db.all<{ amount_halalas: number; deleted_at: string | null }>(
    `SELECT amount_halalas, deleted_at FROM bank_tx WHERE journal_no = ?`, [payJeNo]);
  expect(origTx).toHaveLength(1);
  expect(origTx[0].deleted_at).toBeNull();
  expect(Number(origTx[0].amount_halalas)).toBe(-46000);
  const counterTx = db.all<{ amount_halalas: number; deleted_at: string | null }>(
    `SELECT amount_halalas, deleted_at FROM bank_tx WHERE journal_no = ?`, [revJe.no]);
  expect(counterTx).toHaveLength(1);
  expect(counterTx[0].deleted_at).toBeNull();
  expect(Number(counterTx[0].amount_halalas)).toBe(46000);

  /* ═══ ١٤) تقبيل بعمولة بنكية ═══ */
  recordKeyMoneyDeal(db, {
    unitId: unit1, contractId, outgoing: 'فيصل الاسمري', incoming: 'ماجد العتيبي',
    amountHalalas: 500000, date: T, commissionHalalas: 25000,
    method: 'bank', bankId, notes: '',
  });
  expect(bankBalance(db, bankId)).toBe(1100000 + 25000);

  /* ═══ ١٥) مرفقات ومكتبة ═══ */
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  await putAttachment(env.filesEnv, bytes, {
    entityType: 'contract', entityId: contractId, kind: 'lease', originalName: 'عقد.pdf', mime: 'application/pdf',
  });
  await putAttachment(env.filesEnv, bytes, { // نفس المحتوى — بصمة واحدة
    entityType: 'library', kind: 'other', originalName: 'نسخة.pdf', mime: 'application/pdf',
  });
  expect(liveBlobs(db)).toHaveLength(1);
  const lib = libraryFiles(env.filesEnv);
  expect(lib).toHaveLength(2);
  expect(lib.find((f) => f.link.startsWith('عقد:'))?.unitId).toBe(unit1);

  /* ═══ ١٦) التنبيهات: مستحقة الآن + جدولة مستقبلية ═══ */
  db.run(`INSERT INTO company_docs (id, name, expiry, created_at) VALUES (?,?,?,?)`,
    [uid(), 'رخصة البلدية', addDays(T, 10), new Date().toISOString()]);
  const reminders = computeReminders(db, T);
  expect(reminders.some((r) => r.kind === 'مستند ينتهي')).toBe(true);
  expect(computeSchedule(db, T).length).toBeGreaterThan(0);

  /* ═══ ١٧) السلة: حذف مورد واستعادته ═══ */
  db.run(`UPDATE suppliers SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), supplierId]);
  const trashed = trashItems(db);
  expect(trashed.some((t) => t.table === 'suppliers' && t.id === supplierId)).toBe(true);
  restoreFromTrash(db, 'suppliers', supplierId);
  expect(db.get(`SELECT id FROM suppliers WHERE id = ? AND deleted_at IS NULL`, [supplierId])).toBeTruthy();

  /* ═══ ١٨) إحصاءات العقار ═══ */
  const pstats = propertyStats(db, propertyId, T);
  expect(pstats.total).toBe(4);
  // A-1 بعقدها الساري، وB-1 ما زالت مشغولة اليوم بعقدها المنتهي-بالتجديد حتى نهايته (T+30)
  // — التجديد الملغى (c3) يبدأ بعدها ولا يشغلها
  expect(pstats.occupied).toBe(2);

  /* ═══ ١٩) الفحوص الثمانية كلها تمر بعد كل هذا النشاط ═══ */
  const checks = integrityChecks(db);
  for (const ch of checks) expect({ n: ch.name, v: ch.value, ok: ch.ok }).toEqual({ n: ch.name, v: ch.value, ok: true });

  /* ═══ ٢٠) نسخة احتياطية موثَّقة ← استعادة على جهاز نظيف ← تطابق كامل ═══ */
  const archive = path.join(env.root, 'full.aqbk');
  const manifest = await createBackup(env, archive);
  expect(manifest.complete).toBe(true);
  expect(manifest.integrity.every((c) => c.ok)).toBe(true);
  expect(manifest.table_counts['contracts']).toBe(3);

  const clean = makeBackupEnv(newDir());
  const restored = await restoreBackup(clean, archive);
  expect(restored.manifest.db_sha256).toBe(manifest.db_sha256);
  // البيانات نفسها بعد الاستعادة
  expect(clean.live().get<{ n: number }>(`SELECT COUNT(*) AS n FROM contracts`)!.n).toBe(3);
  expect(accountBalance(clean.live() as never, '4200')).toBe(accountBalance(db, '4200'));
  for (const ch of integrityChecks(clean.live())) expect(ch.ok).toBe(true);
  const restoredBlob = liveBlobs(clean.live())[0];
  expect(fs.existsSync(path.join(clean.attachmentsDir, `${restoredBlob.sha256}.${restoredBlob.ext}`))).toBe(true);

  env.closeLive();
  clean.closeLive();
}, 180000);
