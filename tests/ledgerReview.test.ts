/**
 * مراجعة الأقساط من الدفتر · بيانات اصطناعية بشكل البيانات المنقولة إلى التطبيق (لا بيانات أحد):
 * نقد الدفعات موزَّع على الأقساط بالترتيب، والخصم على صف الدفعة، وقيد خصم منفصل مربوط بقسطه.
 * تُبنى على إصدار ١٩ ثم تُرقّى كما تُرقّى أي قاعدة قديمة. الدفتر هو المرجع، وما لا يحسمه يُترك ويُذكر.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import { memDb, tempDir, rmrf } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv } from './helpers/backupEnv';
import { MemoryRemote } from './helpers/memoryRemote';
import { openNodeDb } from '@/db/nodeAdapter';
import { migrate } from '@/db/migrations';
import { MIGRATIONS } from '@/db/schema';
import { seed } from '@/db/seed';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { postEntry } from '@/domain/accounting/post';
import { semanticIssues } from '@/domain/backup/semantic';
import { createBackup, tableCounts } from '@/domain/backup/create';
import { prepareRestore, commitRestore, abortRestore } from '@/domain/backup/restore';
import { nodeHasher } from '@/files/nodeFs';
import { planLedgerRepair, applyLedgerRepair, unbookedDiscounts, bookDiscount } from '@/domain/ledgerReview';
import { INSTALLMENT_DISCOUNT_SQL, DISCOUNT_AFTER_DUE, DISCOUNT_REDUCES_INSTALLMENT } from '@/domain/contracts/installments';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
const newDir = () => { const d = tempDir('aq-ledger-'); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmrf(d); });

/** قاعدة بإصدار ١٩ · بلا محفّزات سقف (كما يكتب من لا يمرّ بها) */
function v19(file = ':memory:'): DB {
  const db = openNodeDb(file);
  db.exec('PRAGMA foreign_keys = OFF');
  for (let v = 0; v < 19; v++) db.exec(MIGRATIONS[v]);
  db.exec('PRAGMA user_version = 19');
  db.exec('PRAGMA foreign_keys = ON');
  seed(db);
  for (const t of ['trg_pay_insert_cap', 'trg_pay_update_cap', 'trg_inst_update_cap']) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  return db;
}

let seq = 0;
function contract(db: DB, monthly = 100000, live = 3) {
  const p = addProperty(db);
  const u = addUnit(db, p, { rent: monthly });
  seq += 1;
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر ' + seq, valueHalalas: monthly * 12, depositHalalas: 0,
    idNumber: '10' + String(10000000 + seq), start: '2026-01-01', end: '2026-12-31' }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  // ما بعد الأقساط الحيّة ملغى كعقد أُلغي في منتصفه
  for (const id of insts.slice(live)) db.run(`UPDATE contract_installments SET status = 'ملغية' WHERE id = ?`, [id]);
  return { cid, insts };
}
/** دفعة بالشكل المنقول: قيدها نقد وإيراد بالصافي ومصدره rent_payment · وخصمها على صفّها وحده */
function legacyPay(db: DB, cid: string, inst: string, date: string, net: number, disc: number, withEntry = true): string {
  const id = 'P' + (++seq);
  const e = withEntry ? postEntry(db, { date, memo: 'تحصيل', srcType: 'rent_payment', srcId: id,
    lines: [{ account: '1100', debit: net, credit: 0 }, { account: '4200', debit: 0, credit: net }] }) : null;
  db.run(`INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,method_label,notes,journal_entry_id,created_at)
          VALUES (?,?,?,?,?,?,?,?,'','',?,'x')`, [id, cid, inst, date.slice(0, 7), date, net + disc, disc, net, e?.id ?? null]);
  return id;
}
/** قيد خصم منفصل مربوط بالقسط بتاريخ استحقاقه */
const legacyDiscount = (db: DB, inst: string, amount: number) => {
  const due = db.get<{ d: string }>(`SELECT due_date AS d FROM contract_installments WHERE id = ?`, [inst])!.d;
  return postEntry(db, { date: due, memo: 'خصم ممنوح', srcType: 'discount', srcId: inst,
    lines: [{ account: '4900', debit: amount, credit: 0 }, { account: '4200', debit: 0, credit: amount }] })!;
};
const paid = (db: DB, inst: string, v: number) => db.run(`UPDATE contract_installments SET paid_halalas = ? WHERE id = ?`, [v, inst]);
const paidOf = (db: DB, ids: string[]) => ids.map((id) => Number(db.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = ?`, [id])!.p));
const discOf = (db: DB, ids: string[]) => ids.map((id) => Number(db.get<{ d: number }>(
  `SELECT ${INSTALLMENT_DISCOUNT_SQL} AS d FROM contract_installments i WHERE i.id = ?`, [id])!.d));

/** عقد يحسمه الدفتر: نقد ٢٦٠٠ وخصومات ٦٠٠ (٢٠٠ لكل قسط) على ثلاثة أقساط ١٠٠٠ · فالسعة ٢٤٠٠ وفائض ٢٠٠ */
function surplusCase(db: DB) {
  const k = contract(db);
  legacyPay(db, k.cid, k.insts[0], '2026-01-04', 100000, 20000);
  legacyPay(db, k.cid, k.insts[1], '2026-02-03', 80000, 20000);
  legacyPay(db, k.cid, k.insts[1], '2026-03-07', 80000, 20000);
  paid(db, k.insts[0], 100000); paid(db, k.insts[1], 100000); paid(db, k.insts[2], 60000);
  const entries = k.insts.slice(0, 3).map((i) => legacyDiscount(db, i, 20000).no);
  return { ...k, entries };
}

describe('اقتراح التصحيح من الدفتر', () => {
  test('خصم كل قسط من قيوده · والمسدَّد مبلغه ناقص خصمه حين يغطي النقد كل الأقساط · والفائض يُذكر ولا يُنسب', () => {
    const db = v19();
    const k = surplusCase(db);
    migrate(db);
    expect(discOf(db, k.insts.slice(0, 3))).toEqual([20000, 20000, 20000]);
    expect(semanticIssues(db).join(' | ')).toContain('قسط يتجاوز المسدَّدُ مع الخصم');
    const plan = planLedgerRepair(db);
    expect(plan.changes.map((c) => [c.due, c.fromPaid, c.toPaid, c.ledgerDiscount, c.discountEntries])).toEqual([
      ['2026-01-01', 100000, 80000, 20000, [k.entries[0]]],
      ['2026-02-01', 100000, 80000, 20000, [k.entries[1]]],
      ['2026-03-01', 60000, 80000, 20000, [k.entries[2]]],
    ]);
    expect(plan.issues.map((x) => x.reason)).toEqual(['نقد زائد 200.00 عن أقساط العقد بعد خصومها في الدفتر · لم يُنسب لقسط ويبقى قرارُه لك']);
    // الاقتراح قراءة محضة · لا شيء تغيّر قبل التطبيق
    expect(paidOf(db, k.insts.slice(0, 3))).toEqual([100000, 100000, 60000]);
    const ledger = JSON.stringify([db.all(`SELECT * FROM journal_entries ORDER BY id`), db.all(`SELECT * FROM journal_lines ORDER BY id`),
      db.all(`SELECT * FROM contract_payments ORDER BY id`), db.all(`SELECT * FROM payment_allocations ORDER BY id`)]);
    expect(applyLedgerRepair(db, plan)).toBe(3);
    expect(paidOf(db, k.insts.slice(0, 3))).toEqual([80000, 80000, 80000]);
    expect(semanticIssues(db)).toEqual([]);
    // لا قيد ولا دفعة ولا توزيع تغيّر · وكل تغيير في سجل العمليات بقيمه
    expect(JSON.stringify([db.all(`SELECT * FROM journal_entries ORDER BY id`), db.all(`SELECT * FROM journal_lines ORDER BY id`),
      db.all(`SELECT * FROM contract_payments ORDER BY id`), db.all(`SELECT * FROM payment_allocations ORDER BY id`)])).toBe(ledger);
    const log = db.all<{ b: string; a: string }>(`SELECT before_json AS b, after_json AS a FROM audit_log WHERE entity_type = 'تصحيح من الدفتر' ORDER BY rowid`);
    expect(log.map((x) => [JSON.parse(x.b).paid_halalas, JSON.parse(x.a).paid_halalas])).toEqual([[100000, 80000], [100000, 80000], [60000, 80000]]);
    // والفائض الذي لم يحسمه الدفتر يُسجَّل عند التطبيق فلا يضيع بعد خروج العقد من المراجعة
    expect(db.get<{ e: string }>(`SELECT entity_name AS e FROM audit_log WHERE entity_type = 'ما لم يحسمه الدفتر'`)!.e)
      .toContain('نقد زائد 200.00');
    expect(planLedgerRepair(db).changes).toEqual([]);
    db.close();
  });

  test('ما لا يحسمه الدفتر يُترك كما هو ويُذكر سببه: متبقٍ لا يُعرف قسطه · دفعة بلا قيد · خصم أكبر من قسطه · مسدَّد لا يطابق النقد', () => {
    const db = v19();
    // متبقٍ: نقد ١٥٠٠ وخصم ٢٠٠ على القسط الأول المملوء نقداً · والسعة ٢٨٠٠
    const a = contract(db);
    legacyPay(db, a.cid, a.insts[0], '2026-01-04', 150000, 20000);
    paid(db, a.insts[0], 100000); paid(db, a.insts[1], 50000);
    legacyDiscount(db, a.insts[0], 20000);
    // دفعة بلا قيد
    const b = contract(db);
    legacyPay(db, b.cid, b.insts[0], '2026-01-04', 100000, 20000, false);
    paid(db, b.insts[0], 100000);
    legacyDiscount(db, b.insts[0], 20000);
    // خصم أكبر من قسطه
    const c = contract(db);
    legacyPay(db, c.cid, c.insts[0], '2026-01-04', 100000, 0);
    paid(db, c.insts[0], 100000);
    legacyDiscount(db, c.insts[0], 150000);
    // مسدَّد لا يطابق النقد
    const d = contract(db);
    legacyPay(db, d.cid, d.insts[0], '2026-01-04', 80000, 20000);
    paid(db, d.insts[0], 100000); paid(db, d.insts[1], 100000);
    legacyDiscount(db, d.insts[0], 20000);
    migrate(db);
    const before = JSON.stringify(db.all(`SELECT * FROM contract_installments ORDER BY id`));
    const plan = planLedgerRepair(db);
    expect(plan.changes).toEqual([]);
    const reasons = plan.issues.map((x) => x.reason);
    expect(reasons).toContain('على العقد بعد خصومه في الدفتر متبقٍ 1,300.00 ولا يحدد الدفتر أي أقساطه لم تُسدَّد');
    expect(reasons).toContain('دفعة 2026-01-04 (1,000.00) بلا قيد مرحّل قائم في الدفتر · فلا يُعرف نقد العقد من الدفتر');
    expect(reasons).toContain('خصم قسط 2026-01-01 في الدفتر (1,500.00) أكبر من مبلغه (1,000.00)');
    expect(reasons).toContain('مسدَّد الأقساط (2,000.00) لا يطابق نقد الدفعات في الدفتر (800.00) · فلا يُعرف أي الأقساط يُصحَّح');
    applyLedgerRepair(db, plan);
    expect(JSON.stringify(db.all(`SELECT * FROM contract_installments ORDER BY id`))).toBe(before);
    db.close();
  });

  test('عقد سليم لا يُمسّ · ولو دُفع قسطه الثاني قبل الأول وفيه خصم من النوعين', () => {
    const db = memDb();
    const k = contract(db, 100000, 12);
    recordRentPayment(db, k.cid, { installmentId: k.insts[1], period: 'فبراير', date: '2026-01-10', notes: '',
      discountHalalas: 20000, discountKind: DISCOUNT_AFTER_DUE, lines: [{ method: 'cash', amountHalalas: 80000 }] });
    recordRentPayment(db, k.cid, { installmentId: k.insts[0], period: 'يناير', date: '2026-01-12', notes: '',
      discountHalalas: 10000, discountKind: DISCOUNT_REDUCES_INSTALLMENT, lines: [{ method: 'cash', amountHalalas: 90000 }] });
    expect(planLedgerRepair(db)).toEqual({ changes: [], issues: [] });
    db.close();
  });

  test('التطبيق يرفض إن تغيّر القسط منذ عرض الاقتراح · ولا يطبّق شيئاً', () => {
    const db = v19();
    const k = surplusCase(db);
    migrate(db);
    const plan = planLedgerRepair(db);
    db.run(`UPDATE contract_installments SET paid_halalas = 70000 WHERE id = ?`, [k.insts[2]]);
    expect(() => applyLedgerRepair(db, plan)).toThrow('منذ عرض التصحيح · أعد العرض');
    expect(paidOf(db, k.insts.slice(0, 3))).toEqual([100000, 100000, 70000]);
    db.close();
  });
});

describe('الاستعادة والمزامنة مع التصحيح', () => {
  /** أرشيف قاعدته بالشكل المنقول (إصدار ١٩) · البيان مطابق لما فيه */
  async function legacyArchive(): Promise<string> {
    const src = makeBackupEnv(newDir());
    const base = path.join(src.root, 'base.aqbk');
    await createBackup(src, base);
    src.closeLive();
    const file = path.join(src.root, 'legacy.db');
    const db = v19(file);
    surplusCase(db);
    const counts = tableCounts(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const bytes = new Uint8Array(fs.readFileSync(file));
    const entries: Record<string, Uint8Array> = unzipSync(new Uint8Array(fs.readFileSync(base)));
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
    manifest.db_sha256 = await nodeHasher(bytes);
    manifest.table_counts = counts;
    manifest.schema_version = 19;
    entries['data.db'] = bytes;
    entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
    const out = path.join(src.root, 'legacy.aqbk');
    fs.writeFileSync(out, zipSync(entries));
    return out;
  }

  test('النسخة التي يحسمها دفترها: التصحيح على نسخة التجهيز ويُعرض · والبيانات الحية لا تُمسّ حتى الموافقة · والإلغاء يتركها كما هي', async () => {
    const archive = await legacyArchive();
    const target = makeBackupEnv(newDir());
    const live = JSON.stringify(tableCounts(target.db));
    const plan = await prepareRestore(target, archive);
    expect(plan.ledgerRepair!.changes.map((c) => [c.fromPaid, c.toPaid])).toEqual([[100000, 80000], [100000, 80000], [60000, 80000]]);
    expect(plan.ledgerRepair!.issues).toHaveLength(1);
    expect(JSON.stringify(tableCounts(target.db))).toBe(live);
    abortRestore(target, plan.stagingDir);
    expect(JSON.stringify(tableCounts(target.db))).toBe(live);
    // وبالموافقة تدخل مصحَّحة
    const plan2 = await prepareRestore(target, archive);
    const res = await commitRestore(target, plan2);
    expect(semanticIssues(res.db)).toEqual([]);
    expect(Number(res.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'تصحيح من الدفتر'`)!.n)).toBe(3);
    target.closeLive();
  });

  test('بعد التصحيح: جهاز ثانٍ يستقبل كل شيء ولا يرفض صفاً · وقيود الخصم المنفصلة تصل بخصمها', async () => {
    const a = v19();
    const k = surplusCase(a);
    migrate(a);
    applyLedgerRepair(a, planLedgerRepair(a));
    const r = new MemoryRemote();
    enableSync(a, 'U');
    await syncOnce(a, r, getMeta(a, 'device_id')!);
    const b = memDb();
    enableSync(b, 'U');
    const rep = await syncOnce(b, r, getMeta(b, 'device_id')!);
    expect(rep.rejected).toBe(0);
    expect(discOf(b, k.insts.slice(0, 3))).toEqual([20000, 20000, 20000]);
    expect(paidOf(b, k.insts.slice(0, 3))).toEqual([80000, 80000, 80000]);
    a.close(); b.close();
  });
});

describe('خصومات بلا سطر في الدفتر', () => {
  /** دفعة من إصدار سابق للتطبيق: خصمها على صفّها وقيدها بالصافي وحده · بلا نوع */
  function appPay(db: DB, cid: string, inst: string, date: string, net: number, disc: number): string {
    const id = 'A' + (++seq);
    const e = postEntry(db, { date, memo: 'تحصيل', srcType: 'rent', srcId: inst,
      lines: [{ account: '1100', debit: net, credit: 0 }, { account: '4200', debit: 0, credit: net }] })!;
    db.run(`INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,method_label,notes,journal_entry_id,created_at)
            VALUES (?,?,?,?,?,?,?,?,'','',?,'x')`, [id, cid, inst, date.slice(0, 7), date, net + disc, disc, net, e.id]);
    db.run(`UPDATE contract_installments SET paid_halalas = paid_halalas + ? WHERE id = ?`, [net, inst]);
    return id;
  }

  test('تُعرض ولا يُنشأ لها شيء · ويُعدّ خصمها مؤقتاً فلا يظهر دين لم يكن · والمغطّاة بقيود أقساطها لا تُعرض · والمختلطة تُذكر بفرقها', () => {
    const db = memDb();
    const plain = contract(db, 100000, 12);
    const p1 = appPay(db, plain.cid, plain.insts[0], '2026-09-05', 80000, 20000);
    const covered = contract(db, 100000, 12);
    appPay(db, covered.cid, covered.insts[0], '2026-09-05', 80000, 20000);
    legacyDiscount(db, covered.insts[0], 20000);
    const mixed = contract(db, 100000, 12);
    appPay(db, mixed.cid, mixed.insts[0], '2026-09-05', 80000, 20000);
    appPay(db, mixed.cid, mixed.insts[1], '2026-10-05', 70000, 30000);
    legacyDiscount(db, mixed.insts[0], 20000);
    const entries = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n);
    const rep = unbookedDiscounts(db);
    expect(rep.items.map((x) => [x.paymentId, x.received, x.discount, x.due])).toEqual([[p1, 80000, 20000, '2026-01-01']]);
    expect(rep.ambiguous.map((x) => [x.gap, x.candidates.length])).toEqual([[30000, 2]]);
    expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n)).toBe(entries);
    expect(discOf(db, [plain.insts[0], covered.insts[0]])).toEqual([20000, 20000]);
    db.close();
  });

  test('بعد الاستحقاق: قيد جديد مربوط بالدفعة لا تعديل لقيدها · والمتبقي كما هو · وفي سجل العمليات', () => {
    const db = memDb();
    const k = contract(db, 100000, 12);
    const pid = appPay(db, k.cid, k.insts[0], '2026-09-05', 80000, 20000);
    const own = JSON.stringify(db.all(`SELECT * FROM journal_lines WHERE entry_id = (SELECT journal_entry_id FROM contract_payments WHERE id = ?)`, [pid]));
    bookDiscount(db, pid, DISCOUNT_AFTER_DUE);
    const e = db.get<{ date: string; src_id: string; id: string }>(`SELECT date, src_id, id FROM journal_entries WHERE src_type = 'discount'`)!;
    expect(e).toMatchObject({ date: '2026-09-05', src_id: pid });
    expect(db.all(`SELECT account_code AS a, debit_halalas AS d, credit_halalas AS c FROM journal_lines WHERE entry_id = ? ORDER BY account_code`, [e.id]))
      .toEqual([{ a: '4200', d: 0, c: 20000 }, { a: '4900', d: 20000, c: 0 }]);
    expect(JSON.stringify(db.all(`SELECT * FROM journal_lines WHERE entry_id = (SELECT journal_entry_id FROM contract_payments WHERE id = ?)`, [pid]))).toBe(own);
    expect(db.get<{ k: string }>(`SELECT discount_kind AS k FROM contract_payments WHERE id = ?`, [pid])!.k).toBe(DISCOUNT_AFTER_DUE);
    expect(discOf(db, [k.insts[0]])).toEqual([20000]);
    expect(unbookedDiscounts(db).items).toEqual([]);
    expect(db.get(`SELECT id FROM audit_log WHERE entity_type = 'خصم بعد الاستحقاق بأثر رجعي'`)).toBeTruthy();
    expect(() => bookDiscount(db, pid, DISCOUNT_AFTER_DUE)).toThrow('ربما حُدّد نوعه من قبل');
    expect(semanticIssues(db)).toEqual([]);
    db.close();
  });

  test('تنزيل من القسط: القسط يُخفَّض ولا قيد · والمتبقي كما هو · وفي سجل العمليات بتنبيه منصة إيجار', () => {
    const db = memDb();
    const k = contract(db, 100000, 12);
    const pid = appPay(db, k.cid, k.insts[0], '2026-09-05', 80000, 20000);
    const entries = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n);
    bookDiscount(db, pid, DISCOUNT_REDUCES_INSTALLMENT);
    expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n)).toBe(entries);
    expect(db.get(`SELECT amount_halalas AS a, paid_halalas AS p FROM contract_installments WHERE id = ?`, [k.insts[0]])).toEqual({ a: 80000, p: 80000 });
    expect(discOf(db, [k.insts[0]])).toEqual([0]);
    expect(db.get<{ e: string }>(`SELECT entity_name AS e FROM audit_log WHERE entity_type = 'تنزيل من قيمة القسط بأثر رجعي'`)!.e)
      .toContain('يخالف قيمة العقد الموثّقة في منصة إيجار');
    expect(semanticIssues(db)).toEqual([]);
    db.close();
  });

  test('في عقد له قيود خصم أخرى: تحديد نوع خصم يتجاوز سقف قسطه يُرفض كله ولا يترك قيداً', () => {
    const db = memDb();
    const k = contract(db, 100000, 12);
    legacyDiscount(db, k.insts[1], 10000);
    const pid = appPay(db, k.cid, k.insts[0], '2026-09-05', 100000, 20000);
    const entries = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n);
    expect(() => bookDiscount(db, pid, DISCOUNT_AFTER_DUE)).toThrow('الخصم يتجاوز المتبقي على القسط');
    expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n)).toBe(entries);
    expect(db.get<{ k: string | null }>(`SELECT discount_kind AS k FROM contract_payments WHERE id = ?`, [pid])!.k).toBeNull();
    db.close();
  });
});
