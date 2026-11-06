/**
 * المراجعة الشاملة · البند ٢٧: إلغاء دفعةٍ سُدّدت من عربون الحجز (allocateDeposit) كان يعكس قيدها (مدين 2450 / دائن الإيراد)
 * فيعود مبلغها التزاماً في 2450، والحجز «محوَّل لعقد» لا يُرد عربونه ولا يُصادر (cancelReservation يرفضه) · فيبقى الرصيد عالقاً
 * بلا مخرج. الخيار (أ): دفعة العربون لا تُلغى · عائقٌ في المعاينة بسببه، والتنفيذ يرفضها ولا يكتب شيئاً، وإلغاء غيرها كما كان.
 * وملاحظات المتحقق المستقل على 7aea4c3: إلغاؤها من جهاز عضوٍ بنسخة قديمة يُرفض على جهاز المالك · و«التحصيل» لا ينشئ عكس
 * تحويل العربون · والرصيد العالق من إلغاءٍ قبل المنع يُحمّر فحص عربون الحجوزات وتسدّده أداة البيانات السابقة · ولا زرّ «إلغاء من
 * مصدره» لقيدها في الدفتر · ومعاينتها المنع وحده.
 * بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment, RuleViolation } from '@/domain/contracts/service';
import { planCancelPayment, cancelPayment, paidFromDeposit } from '@/domain/contracts/cancelPayment';
import { createReservation, cancelReservation } from '@/domain/reservations';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { sourceCancelLocked } from '@/domain/accounting/sourceCancel';
import { reverseEntryById, postReservationDeposit, postEntry } from '@/domain/accounting/post';
import { fileVatReturn, filedDiff, isFiledDate } from '@/domain/vatFilings';
import { vatReturnData } from '@/domain/vatReturn';
import { recomputeInstallments } from '@/domain/contracts/paid';
import { previewRepairs, applyRepair } from '@/domain/reviewRepairs';
import { OP_JOURNAL_SRC, journalSrcAllowed } from '@/domain/access/opWrites';
import { generateOrgRules } from '@/domain/access/rulesGen';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import { MemoryRemote } from './helpers/memoryRemote';
import { t } from '@/i18n';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEPOSIT = 250000; // يغطي القسط الأول (200000) وخمسين ألفاً من الثاني
const REASON = 'إلغاء مصطنع';

function converted(db: DB = memDb()) {
  const u = addUnit(db, addProperty(db, { name: 'عقار عربون البند ٢٧ مصطنع' }));
  const rid = createReservation(db, { unitId: u, name: 'حاجز مصطنع ٢٧', phone: '', depositHalalas: DEPOSIT, expiryDate: '2099-01-01' });
  const cid = confirmContract(db, { ...contractInput(u, { tenant: 'مستأجر البند ٢٧ مصطنع', idNumber: '1000002701', phone: '0500002701',
    start: '2026-01-01', depositHalalas: 0 }), reservationId: rid } as never);
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  const deposits = db.all<{ id: string; installment_id: string; net: number }>(
    `SELECT id, installment_id, net_halalas AS net FROM contract_payments WHERE contract_id = ? AND method_label = 'من العربون' ORDER BY date, rowid`, [cid]);
  return { db, rid, cid, insts, deposits };
}
const paidOf = (db: DB, id: string) => Number(db.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = ?`, [id])!.p);
const cash = (db: DB, cid: string, iid: string, amount: number) => recordRentPayment(db, cid, {
  installmentId: iid, period: 'م', date: '2026-02-05', notes: '', discountHalalas: 0, lines: [{ method: 'cash', amountHalalas: amount }] });
/** كل ما قد يكتبه الإلغاء · للمقارنة قبل المحاولة وبعدها */
const snapshot = (db: DB) => JSON.stringify(['journal_entries', 'journal_lines', 'contract_payments', 'contract_installments',
  'payment_allocations', 'bank_tx', 'tenants', 'reservations', 'audit_log'].map((tb) => db.all(`SELECT * FROM ${tb} ORDER BY rowid`)));
const healthy = (db: DB) => {
  for (const c of integrityChecks(db)) expect(`${c.name}: ${c.ok}`).toBe(`${c.name}: true`);
};

describe('البند ٢٧: دفعة العربون لا تُلغى', () => {
  test('٢٧: إلغاء دفعة العربون يعيد مبلغها إلى 2450 والحجز محوَّل لا يُسوّى عربونه · فيُمنع ويبقى 2450 صفراً', () => {
    const { db, rid, insts, deposits } = converted();
    expect(deposits.map((d) => d.net)).toEqual([200000, 50000]);
    expect(accountBalance(db, '2450')).toBe(0);
    expect(paidOf(db, insts[0])).toBe(200000);
    try { cancelPayment(db, deposits[0].id, { date: '2026-02-01', reason: REASON }); } catch { /* المنع هو المطلوب */ }
    // لا رصيد عالق في التزام العربون، والقسط باقٍ مسدَّداً، والدفعة غير ملغاة
    expect(accountBalance(db, '2450')).toBe(0);
    expect(paidOf(db, insts[0])).toBe(200000);
    expect(db.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [deposits[0].id])!.c).toBeNull();
    // ولا مخرج لما كان سيعود: الحجز المحوَّل لا يُرد عربونه ولا يُصادر
    expect(() => cancelReservation(db, rid, true, '2026-02-02')).toThrow(/محوَّل لعقد/);
    expect(() => cancelReservation(db, rid, false, '2026-02-02')).toThrow(/محوَّل لعقد/);
    healthy(db);
    db.close();
  });

  test('٢٧: المعاينة تعرض سبب المنع بمفتاحه · والتنفيذ يرفض بالسبب نفسه ولا يكتب شيئاً', () => {
    const { db, deposits } = converted();
    const why = t('payment.cancelFromDeposit');
    for (const d of deposits) {
      expect(planCancelPayment(db, d.id, '2026-02-01').blockers).toContain(why);
      const before = snapshot(db);
      expect(() => cancelPayment(db, d.id, { date: '2026-02-01', reason: REASON })).toThrow(RuleViolation);
      expect(() => cancelPayment(db, d.id, { date: '2026-02-01', reason: REASON })).toThrow(why);
      expect(snapshot(db)).toBe(before);
    }
    // والمنع وحده في المعاينة (لا عائقٌ مؤقت معه)
    expect(planCancelPayment(db, deposits[0].id).blockers).toEqual([why]);
    expect(why).not.toBe('payment.cancelFromDeposit'); // مفتاحٌ مترجَم لا اسمه
    db.close();
  });

  test('٢٧: إلغاء الدفعات الأخرى كما كان · ولو على قسطٍ سُدّد بعضه من العربون', () => {
    const { db, cid, insts, deposits } = converted();
    const onShared = cash(db, cid, insts[1], 150000); // باقي القسط الثاني بعد العربون
    const onOwn = cash(db, cid, insts[2], 200000);
    expect(paidOf(db, insts[1])).toBe(200000);
    for (const pid of [onShared, onOwn]) {
      expect(paidFromDeposit(db, pid)).toBe(false);
      expect(planCancelPayment(db, pid, '2026-02-06').blockers).toEqual([]);
      cancelPayment(db, pid, { date: '2026-02-06', reason: REASON });
      expect(db.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [pid])!.c).toBe('2026-02-06');
    }
    expect(paidOf(db, insts[1])).toBe(50000); // يبقى ما سدّده العربون
    expect(paidOf(db, insts[2])).toBe(0);
    expect(accountBalance(db, '2450')).toBe(0);
    for (const d of deposits) expect(paidFromDeposit(db, d.id)).toBe(true);
    healthy(db);
    db.close();
  });
});

/* ─── ملاحظات المتحقق المستقل على 7aea4c3 ─── */

const UID = 'owner-p27';
const MEMBER = 'member-p27';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const reasonOf = (db: DB, pk: string) => db.get<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE pk = ? ORDER BY id DESC`, [pk])?.reason ?? '';
const cancelledAt = (db: DB, id: string) => db.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [id])!.c;
const depositCheck = (db: DB) => integrityChecks(db).find((c) => c.name.includes('عربون الحجوزات'))!;
const entryOf = (db: DB, pid: string) => db.get<{ j: string }>(`SELECT journal_entry_id AS j FROM contract_payments WHERE id = ?`, [pid])!.j;

/** ما كان cancelPayment يكتبه لدفعة العربون قبل منعها حرفياً: عكس القيد، ووسم الدفعة، والمسدَّد من الدفعات · يعيد العاكس */
function legacyCancel(db: DB, pid: string, date: string): string {
  const rev = reverseEntryById(db, entryOf(db, pid), 'إلغاء دفعة · ' + REASON, date)!;
  db.run(`UPDATE contract_payments SET cancelled_at = ?, cancel_reason = ?, cancel_entry_id = ? WHERE id = ?`, [date, REASON, rev.id, pid]);
  recomputeInstallments(db);
  return rev.id;
}

/** جهاز المالك يحوّل الحجز عقداً · وجهازٌ ثانٍ بنسخةٍ قديمة يلغي دفعة العربون الأولى ويرفع · asMember: يُعلَّم ما رفعه بكتابة عضو */
async function cancelledElsewhere(asMember: boolean) {
  const r = new MemoryRemote();
  const owner = memDb();
  const dev = memDb();
  enableSync(owner, UID);
  enableSync(dev, UID);
  const x = converted(owner);
  await sync(owner, r);
  await sync(dev, r);
  const rev = legacyCancel(dev, x.deposits[0].id, '2026-02-01');
  await sync(dev, r);
  if (asMember) {
    // كتابة العضو كما تصل السحابة: «op» قسم العملية تشترطه القواعد على كل كتابة عضو، و«by» كاتب الصف الجديد
    for (const d of [...r.docs.values()] as RemoteDoc[]) {
      if (d.t === 'journal_entries' && d.k === rev) r.inject({ ...d, by: MEMBER, op: 'ledger' });
      if (d.t === 'contract_payments' && d.k === x.deposits[0].id) r.inject({ ...d, op: 'collect' });
    }
  }
  await sync(owner, r);
  await sync(owner, r);
  return { ...x, r, owner, dev, rev };
}

describe('البند ٢٧: ملاحظات المتحقق المستقل', () => {
  test('٢٧: إلغاء دفعة العربون من جهاز عضوٍ بنسخة قديمة يُرفض على جهاز المالك · عاكسها ووسمها · ويبقى 2450 صفراً', async () => {
    const { owner, dev, deposits, insts, rev } = await cancelledElsewhere(true);
    expect(cancelledAt(owner, deposits[0].id)).toBeNull();
    expect(owner.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [rev])).toBeFalsy();
    expect(accountBalance(owner, '2450')).toBe(0);
    expect(paidOf(owner, insts[0])).toBe(200000);
    expect(reasonOf(owner, deposits[0].id)).toContain(t('payment.cancelFromDeposit', { lng: 'ar' }));
    expect(reasonOf(owner, rev)).toContain(t('payment.cancelFromDeposit', { lng: 'ar' }));
    expect(depositCheck(owner).ok).toBe(true);
    owner.close(); dev.close();
  });

  test('٢٧: وإلغاء المالك من جهازه الآخر يُقبل كما كتبه · فيحمرّ فحص عربون الحجوزات بالرصيد العالق', async () => {
    const { owner, dev, deposits } = await cancelledElsewhere(false);
    expect(cancelledAt(owner, deposits[0].id)).toBe('2026-02-01');
    expect(accountBalance(owner, '2450')).toBe(200000);
    expect(depositCheck(owner)).toMatchObject({ ok: false });
    owner.close(); dev.close();
  });

  test('٢٧: «التحصيل» لا ينشئ قيد عكس تحويل العربون · والقواعد المولَّدة والمنشورة بلا هذا المصدر له', () => {
    expect(OP_JOURNAL_SRC.collect).not.toContain('reservation_convert_rev');
    expect(journalSrcAllowed('collect', 'reservation_convert_rev')).toBe(false);
    expect(journalSrcAllowed('collect', 'rent_rev')).toBe(true);
    const collect = (rules: string) => /\|collect:\(([^)]*)\)/.exec(rules)![1].split('|');
    expect(collect(generateOrgRules())).not.toContain('reservation_convert_rev');
    expect(collect(fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'))).not.toContain('reservation_convert_rev');
  });

  test('٢٧: دفعة عربون أُلغيت قبل المنع يُحمّر رصيدها العالق فحص عربون الحجوزات · وأداة البيانات السابقة تسدّده من العربون', () => {
    const { db, insts, deposits } = converted();
    healthy(db);
    legacyCancel(db, deposits[0].id, '2026-02-01');
    expect(accountBalance(db, '2450')).toBe(200000);
    expect(paidOf(db, insts[0])).toBe(0);
    expect(depositCheck(db)).toMatchObject({ ok: false });
    const item = previewRepairs(db).find((p) => p.key === 'cancelled_deposit')!;
    expect(item.items).toHaveLength(1);
    expect(item.items[0].blocked).toBeUndefined();
    expect(applyRepair(db, 'cancelled_deposit')).toBe(1);
    expect(accountBalance(db, '2450')).toBe(0);
    expect(paidOf(db, insts[0])).toBe(200000);
    // الملغاة تبقى ملغاة بتاريخها · والتسديد دفعةٌ جديدة من العربون
    expect(cancelledAt(db, deposits[0].id)).toBe('2026-02-01');
    expect(previewRepairs(db).find((p) => p.key === 'cancelled_deposit')!.items).toHaveLength(0);
    healthy(db);
    db.close();
  });

  test('٢٧: والأداة لا تسدّد العالق إن لم يبق على أقساط العقد ما يسعه · تُوقفه بسببه', () => {
    const { db, cid, insts, deposits } = converted();
    legacyCancel(db, deposits[0].id, '2026-02-01');
    for (const i of insts) {
      const left = Number(db.get<{ n: number }>(`SELECT amount_halalas - paid_halalas AS n FROM contract_installments WHERE id = ?`, [i])!.n);
      if (left > 0) cash(db, cid, i, left);
    }
    const item = previewRepairs(db).find((p) => p.key === 'cancelled_deposit')!.items[0];
    expect(item.blocked).toBeTruthy();
    expect(applyRepair(db, 'cancelled_deposit')).toBe(0);
    expect(accountBalance(db, '2450')).toBe(200000);
    db.close();
  });

  test('٢٧: قيد دفعة العربون لا إلغاء له من مصدره · فلا زرّ «إلغاء من مصدره» له في الدفتر', () => {
    const { db, cid, insts, deposits } = converted();
    const je = entryOf(db, deposits[0].id);
    expect(entrySourceAction(db, je)).toBeNull();
    expect(sourceCancelLocked(db, je)).toBe(true);
    // وقيد دفعةٍ نقدية يُلغى من مصدره كما كان
    const other = entryOf(db, cash(db, cid, insts[2], 200000));
    expect(sourceCancelLocked(db, other)).toBe(false);
    expect(entrySourceAction(db, other)).toMatchObject({ kind: 'payment' });
    // والدفتر يخفي زرّه بالحكم نفسه
    const journal = fs.readFileSync(path.join(__dirname, '..', 'app', 'journal.tsx'), 'utf8');
    expect(journal).toMatch(/sourceCancelLocked\(db, /);
    expect(journal).toMatch(/srcType\?\.endsWith\('_rev'\) \|\| locked/);
    db.close();
  });

  test('٢٧: معاينة دفعة العربون المنع وحده · بلا قيدٍ يُعكس ولا قسطٍ يتغيّر ولا بنك', () => {
    const { db, deposits } = converted();
    for (const d of deposits) {
      const plan = planCancelPayment(db, d.id, '2026-02-01');
      expect(plan).toMatchObject({ entries: [], installments: [], bank: [], creditReversal: 0, restoreAmount: null, cashShort: 0,
        blockers: [t('payment.cancelFromDeposit')] });
    }
    db.close();
  });
});

/* ─── المراجعة الأخيرة: أدوات البيانات السابقة لا ترحّل في ربعٍ قُدِّم إقراره (#29 · البند ٨) ─── */

describe('البند ٢٧ (تتمة · المراجعة الأخيرة): أداة البيانات السابقة بتاريخ تصحيحٍ في فترةٍ مفتوحة', () => {
  const at = (iso: string) => {
    jest.useFakeTimers({ now: new Date(iso), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
  };
  afterEach(() => jest.useRealTimers());
  /** إقرار الربع الرابع مسجَّلٌ مقدَّماً قبل انتهائه بلقطة بنوده الآن · كما قُدِّم قبل منع التقديم المبكر أو وصل من جهازٍ ساعته متقدمة */
  const fileQ4Early = (db: DB) => {
    const data = vatReturnData(db, 2026, 4);
    db.run(`INSERT INTO vat_filings (id, period_from, period_to, filed_at, snapshot, created_at) VALUES (?,?,?,?,?,?)`,
      ['2026-Q4', '2026-10-01', '2026-12-31', '2026-11-05', JSON.stringify({ items: data.items, excluded: data.excluded }), '2026-11-05T00:00:00.000Z']);
  };
  const paymentIds = (db: DB, cid: string) => db.all<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [cid]).map((r) => r.id);
  /** ما أنشأته الأداة من دفعات وتاريخ قيد كلٍّ منها */
  const madeSince = (db: DB, cid: string, ids: string[]) => db.all<{ date: string; je: string }>(
    `SELECT p.date, e.date AS je FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
     WHERE p.contract_id = ? AND p.id NOT IN (${ids.map(() => '?').join(',')}) ORDER BY p.rowid`, [cid, ...ids]);

  test('٢٧ (المراجعة الأخيرة) اليوم في ربعٍ قُدِّم إقراره: تسديد العالق بأول يومٍ في الفترة المفتوحة التالية · والإقرار المقدَّم لا يتغيّر', () => {
    at('2026-11-06T12:00:00');
    const { db, cid, insts, deposits } = converted();
    legacyCancel(db, deposits[0].id, '2026-02-01');
    fileQ4Early(db);
    expect(isFiledDate(db, '2026-11-06')).toBe(true);
    const ids = paymentIds(db, cid);
    // المعاينة تذكر التاريخ الذي يُرحَّل به فعلاً (المتحقق المستقل على التتمة)
    expect(previewRepairs(db).find((p) => p.key === 'cancelled_deposit')!.explain).toContain('01/01/2027');
    expect(applyRepair(db, 'cancelled_deposit')).toBe(1);
    expect(madeSince(db, cid, ids)).toEqual([{ date: '2027-01-01', je: '2027-01-01' }]);
    expect(filedDiff(db, 2026, 4)).toEqual([]);
    expect(accountBalance(db, '2450')).toBe(0);
    expect(paidOf(db, insts[0])).toBe(200000);
    db.close();
  });

  test('٢٧ (المراجعة الأخيرة) وفي ربعٍ مفتوح بتاريخ اليوم كما كان', () => {
    at('2026-11-06T12:00:00');
    const { db, cid, deposits } = converted();
    legacyCancel(db, deposits[0].id, '2026-02-01');
    const ids = paymentIds(db, cid);
    expect(previewRepairs(db).find((p) => p.key === 'cancelled_deposit')!.explain).toContain('06/11/2026');
    expect(applyRepair(db, 'cancelled_deposit')).toBe(1);
    expect(madeSince(db, cid, ids)).toEqual([{ date: '2026-11-06', je: '2026-11-06' }]);
    db.close();
  });

  test('٢٧ (المراجعة الأخيرة) ونظيرتها «تحويل عربون بالقيد السابق»: بداية العقد في ربعٍ قُدِّم إقراره فالتسديد بتاريخ اليوم لا بها', () => {
    at('2026-11-06T12:00:00');
    const db = memDb();
    const unit = addUnit(db, addProperty(db, { name: 'عقار تحويل قديم مصطنع' }));
    const cid = confirmContract(db, contractInput(unit, { tenant: 'مستأجر تحويل قديم مصطنع', idNumber: '1000002702', phone: '0500002702',
      start: '2026-02-01', end: '2027-01-31', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
    const first = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
    recordRentPayment(db, cid, { installmentId: first.id, period: 'الأول', date: '2026-02-01', lines: [{ method: 'cash', amountHalalas: 100000 }],
      discountHalalas: 0, notes: '' });
    const rid = 'R_legacy_p27';
    db.run(`INSERT INTO reservations (id, unit_id, name, deposit_halalas, expiry_date, created_date, status, converted_contract_id)
            VALUES (?,?,?,?,?,?,'محوَّل لعقد',?)`, [rid, unit, 'حاجز قديم مصطنع', 60000, '2026-02-10', '2026-01-20', cid]);
    postReservationDeposit(db, { id: rid, name: 'حاجز قديم مصطنع', deposit: 60000, date: '2026-01-20' });
    postEntry(db, { date: '2026-01-25', memo: 'تحويل عربون إلى عقد (قديم)', srcType: 'reservation_convert', srcId: rid,
      lines: [{ account: '2450', debit: 60000, credit: 0 }, { account: '1200', debit: 0, credit: 60000 }] });
    fileVatReturn(db, 2026, 1, '2026-04-15');
    const ids = paymentIds(db, cid);
    // المعاينة تذكر التاريخ الذي يُرحَّل به فعلاً (المتحقق المستقل على التتمة)
    expect(previewRepairs(db).find((p) => p.key === 'reservation_convert')!.items[0].detail).toContain('06/11/2026');
    expect(applyRepair(db, 'reservation_convert')).toBe(1);
    expect(madeSince(db, cid, ids)).toEqual([{ date: '2026-11-06', je: '2026-11-06' }]);
    expect(filedDiff(db, 2026, 1)).toEqual([]);
    expect(accountBalance(db, '1200')).toBe(0);
    expect(accountBalance(db, '2450')).toBe(0);
    db.close();
  });
});
