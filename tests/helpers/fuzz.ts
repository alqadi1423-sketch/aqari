/**
 * اختبار الثوابت بعمليات عشوائية · مولّد حتمي من بذرة، فكل تسلسل يُعاد بعينه من رقمه.
 *
 * العمليات: عقد · دفعة · دفعة بخصم بعد الاستحقاق · دفعة بتنزيل من القسط · تحصيل جماعي ·
 * عكس قيد من الدفتر · نسخة ثم استعادة (واعتمادها للسحابة) · جهازان: قطع الاتصال ووصله والمزامنة.
 * الثوابت بعد كل عملية على الجهاز الذي عمل: توازن الدفتر وفحوصه · سقف القسط والفحص الدلالي ·
 * المسدَّد على الأقساط = نقد الدفعات في الدفتر · وبعد مزامنة الجهازين في النهاية: تطابقهما.
 *
 * الكتابة على الجهازين معاً بلا اتصال تنتظر قرار ترقيم الأجهزة (البند ٥): الرقم المتسلسل للقيد
 * والعقد يتكرر بين جهازين منفصلين فيُرفض أحدهما · فالمولّد لا يكتب على جهاز ما دام للآخر كتابةٌ
 * لم تُرفع، وما سوى ذلك من تزامن (قطع ووصل وتعارض الصف نفسه) يجري كاملاً.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openNodeDb } from '@/db/nodeAdapter';
import { migrate } from '@/db/migrations';
import { seed, ensureDeviceId } from '@/db/seed';
import type { DB } from '@/db/adapter';
import { confirmContract, recordRentPayment, recordBulkRentPayment, RuleViolation } from '@/domain/contracts/service';
import { DISCOUNT_AFTER_DUE, DISCOUNT_REDUCES_INSTALLMENT, INSTALLMENT_DISCOUNT_SQL } from '@/domain/contracts/installments';
import { postEntry } from '@/domain/accounting/post';
import { reverseFromJournal } from '@/domain/accounting/journalReversal';
import { integrityChecks } from '@/domain/accounting/integrity';
import { semanticIssues } from '@/domain/backup/semantic';
import { DERIVED_PAID_SQL } from '@/domain/contracts/paid';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { setDeviceLetter } from '@/domain/numbering';
import { enableSync, syncOnce, outboxCount, readCloud, planFromSnapshot, adoptAsCloudTruth } from '@/sync/engine';
import { planKeepPosted, applyKeepPosted } from '@/domain/backup/keepPosted';
import { recomputeInstallments } from '@/domain/contracts/paid';
import type { RemoteDoc, RemoteStore, Cursor, WriteResult } from '@/sync/types';
import { MemoryRemote } from './memoryRemote';
import { addProperty, addUnit, contractInput } from './fixtures';

/** مولّد عشوائي حتمي (mulberry32) */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)],
  };
}

const UID = 'fuzz-user';
const UNITS = 12;

/** سحابة يراها جهاز بعينه · تنقطع عنه وحده */
class DeviceRemote implements RemoteStore {
  online = true;
  constructor(private inner: MemoryRemote) {}
  pull(c: Cursor | null, n: number) {
    if (!this.online) return Promise.reject(new Error('Network request failed'));
    return this.inner.pull(c, n);
  }
  write(d: RemoteDoc[]): Promise<WriteResult[]> {
    if (!this.online) return Promise.reject(new Error('Network request failed'));
    return this.inner.write(d);
  }
}

interface Device {
  name: 'A' | 'B';
  file: string;
  db: DB;
  dev: string;
  remote: DeviceRemote;
  /** نسخة احتياطية مأخوذة على هذا الجهاز · مسار ملفها */
  backup: string | null;
}

let template: string | null = null;

/** قاعدة أساس مرة واحدة: مهاجَرة مزروعة بعقار ووحداته · تُنسخ لكل جهاز */
function templateFile(dir: string): string {
  if (template && fs.existsSync(template)) return template;
  const f = path.join(dir, 'template.db').replace(/\\/g, '/');
  const db = openNodeDb(f);
  migrate(db);
  seed(db);
  const p = addProperty(db, { id: 'P_FUZZ', name: 'عقار الاختبار' });
  for (let i = 1; i <= UNITS; i++) addUnit(db, p, { id: 'U_' + i, unit_no: String(i), rent: 100000 });
  db.close();
  template = f;
  return f;
}

function openDevice(dir: string, name: 'A' | 'B', inner: MemoryRemote, seedNo: number): Device {
  const file = path.join(dir, `s${seedNo}-${name}.db`).replace(/\\/g, '/');
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(file + s)) fs.rmSync(file + s);
  fs.copyFileSync(templateFile(dir), file);
  const db = openNodeDb(file);
  const dev = ensureDeviceId(db, 'dev-' + name + '-' + seedNo);
  // حرف الجهاز في ترقيم الحساب (numbering.ts) · الأول بلا حرف والثاني B كما يسجّلهما الحساب
  setDeviceLetter(db, name === 'A' ? '' : 'B');
  inner.letters[dev] = name === 'A' ? '' : 'B';
  enableSync(db, UID);
  return { name, file, db, dev, remote: new DeviceRemote(inner), backup: null };
}

/* ═══════════ الثوابت ═══════════ */

export function invariantIssues(db: DB): string[] {
  const out: string[] = [];
  for (const c of integrityChecks(db)) if (!c.ok) out.push('فحص الدفتر: ' + c.name + ' (' + c.value + ')');
  out.push(...semanticIssues(db).map((s) => 'دلالي: ' + s));
  // ١) المسدَّد المخزَّن هو المحسوب من الدفعات وتوزيعها محدوداً بالمبلغ ناقصاً الخصم (الهجرة ٢١)
  const drift = db.all<{ id: string; paid: number; want: number }>(
    `SELECT i.id, i.paid_halalas AS paid,
            MIN(${DERIVED_PAID_SQL}, MAX(0, i.amount_halalas - ${INSTALLMENT_DISCOUNT_SQL})) AS want
     FROM contract_installments i WHERE i.status != 'ملغية'`).filter((r) => Number(r.paid) !== Number(r.want));
  if (drift.length) out.push('مسدَّد مخزَّن يخالف المحسوب: ' + drift.length + ' قسط');
  // ٢) نقد الإيراد في قيود الدفعات القائمة (4200 ناقص الخصم 4900) = ما دفعته الدفعات على الأقساط بلا حدّ ·
  //    فلا قبض يضيع ولو حُصّل القسط من جهازين (الزائد فوق المبلغ فائضٌ يظهر للرد)
  const rows = db.all<{ id: string; paid: number; cash: number }>(
    `SELECT c.id,
       COALESCE((SELECT SUM(${DERIVED_PAID_SQL}) FROM contract_installments i WHERE i.contract_id = c.id AND i.status != 'ملغية'), 0) AS paid,
       COALESCE((SELECT SUM(CASE WHEN l.account_code = '4200' THEN l.credit_halalas - l.debit_halalas
                                  WHEN l.account_code = '4900' THEN l.credit_halalas - l.debit_halalas ELSE 0 END)
                 FROM contract_payments p
                 JOIN journal_entries e ON e.id = p.journal_entry_id AND e.status = 'مرحّل' AND e.reversed_by IS NULL
                 JOIN journal_lines l ON l.entry_id = e.id
                 WHERE p.contract_id = c.id), 0) AS cash
     FROM contracts c WHERE c.deleted_at IS NULL`);
  for (const r of rows) if (Number(r.paid) !== Number(r.cash)) out.push(`عقد ${r.id}: المسدَّد ${r.paid} ≠ نقد الدفتر ${r.cash}`);
  return out;
}

/** ما يجب أن يتطابق بين الجهازين بعد المزامنة */
export function deviceState(db: DB): string {
  return JSON.stringify({
    contracts: db.all(`SELECT id, contract_no, status, value_halalas FROM contracts ORDER BY id`),
    inst: db.all(`SELECT id, amount_halalas, paid_halalas, status FROM contract_installments ORDER BY id`),
    pays: db.all(`SELECT id, installment_id, net_halalas, discount_halalas, discount_kind, journal_entry_id FROM contract_payments ORDER BY id`),
    allocs: db.all(`SELECT id, payment_id, installment_id, amount_halalas FROM payment_allocations ORDER BY id`),
    entries: db.all(`SELECT id, no, status, src_type, src_id, reversed_by FROM journal_entries ORDER BY id`),
    lines: db.all(`SELECT id, entry_id, account_code, debit_halalas, credit_halalas FROM journal_lines ORDER BY id`),
    tenants: db.all(`SELECT id, credit_halalas FROM tenants ORDER BY id`),
  });
}

/* ═══════════ تسلسل واحد ═══════════ */

export interface FuzzResult { seed: number; ok: boolean; log: string[]; failure?: string }

export async function runSequence(dir: string, seedNo: number, steps = 14): Promise<FuzzResult> {
  const r = rng(seedNo);
  const cloud = new MemoryRemote();
  const A = openDevice(dir, 'A', cloud, seedNo);
  const B = openDevice(dir, 'B', cloud, seedNo);
  const devices = [A, B];
  const log: string[] = [];
  let dateDay = 1;
  let backups = 0;
  const date = () => `2026-${String(1 + Math.floor(dateDay / 28)).padStart(2, '0')}-${String(1 + (dateDay++ % 28)).padStart(2, '0')}`;

  /** جهازٌ لم يسحب بعدُ ما رفعه الآخر · كتابته تصطدم بترقيم الآخر وبمسدَّد القسط نفسه */
  const stale = new Map<Device, boolean>([[A, false], [B, false]]);
  const sync = async (d: Device) => {
    if (!d.remote.online) return;
    const rep = await syncOnce(d.db, d.remote, d.dev, undefined, { sleep: async () => {} });
    stale.set(d, false);
    if (rep.pushed > 0) stale.set(d === A ? B : A, true);
  };
  /**
   * لا يكتب جهازٌ وللآخر كتابة لم تُرفع، ولا وهو متأخر عمّا رفعه الآخر · فالترقيم المتسلسل (البند ٥)
   * ومسدَّد القسط الواحد من جهازين منفصلين ينتظران قرار المالك · فيُرفع ويُسحب أولاً إن أمكن
   */
  // الكتابة على الجهازين معاً بلا اتصال مسموحة منذ ترقيم الأجهزة (numbering.ts) والمسدَّد المحسوب (paid.ts) ·
  // وما بقي من انتظار الآخر للاستعادة وحدها: لا تُعتمد نسخةٌ للسحابة وللآخر كتابة لم تُرفع
  const canWrite = async (d: Device): Promise<boolean> => {
    void d;
    return true;
  };
  const check = (d: Device, what: string) => {
    const issues = invariantIssues(d.db);
    if (issues.length) throw new Error(`بعد «${what}» على ${d.name}: ${issues.join(' | ')}`);
  };

  const ops: Array<{ name: string; run: (d: Device) => Promise<string | null> }> = [
    { name: 'عقد', run: async (d) => {
      const free = d.db.all<{ id: string }>(
        `SELECT u.id FROM units u WHERE NOT EXISTS (SELECT 1 FROM contracts c WHERE c.unit_id = u.id AND c.status IN ('سارٍ','مسودة'))`);
      if (!free.length) return null;
      const monthly = r.int(5, 40) * 10000;
      const u = r.pick(free).id;
      confirmContract(d.db, contractInput(u, {
        tenant: 'مستأجر ' + r.int(1, 999), phone: '05' + r.int(10000000, 99999999), idNumber: '1' + r.int(100000000, 999999999),
        valueHalalas: monthly * 12, cycle: 'شهرية', start: '2026-01-01', end: '2026-12-31', depositHalalas: r.pick([0, monthly]),
      }));
      return `عقد ${monthly}`;
    } },
    { name: 'دفعة', run: async (d) => payOne(d, null) },
    { name: 'خصم بعد الاستحقاق', run: async (d) => payOne(d, DISCOUNT_AFTER_DUE) },
    { name: 'تنزيل من القسط', run: async (d) => payOne(d, DISCOUNT_REDUCES_INSTALLMENT) },
    { name: 'تحصيل جماعي', run: async (d) => {
      const cs = d.db.all<{ id: string }>(`SELECT id FROM contracts WHERE status = 'سارٍ' ORDER BY id`);
      if (!cs.length) return null;
      const c = r.pick(cs);
      const inst = d.db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? AND status != 'ملغية' ORDER BY due_date LIMIT ?`, [c.id, r.int(1, 4)]);
      if (!inst.length) return null;
      const amount = r.int(1, 60) * 10000;
      recordBulkRentPayment(d.db, c.id, { installmentIds: inst.map((i) => i.id), date: date(), notes: '', lines: [{ method: 'cash', amountHalalas: amount }] });
      return `تحصيل جماعي ${amount} على ${inst.length}`;
    } },
    { name: 'قيد يدوي ثم عكسه', run: async (d) => {
      const amt = r.int(1, 50) * 1000;
      const e = postEntry(d.db, { date: date(), memo: 'يدوي', lines: [{ account: '1100', debit: amt, credit: 0 }, { account: '3100', debit: 0, credit: amt }] });
      if (e && r.next() < 0.7) reverseFromJournal(d.db, e.id);
      return `قيد يدوي ${amt}`;
    } },
    { name: 'عكس قيد دفعة من الدفتر', run: async (d) => {
      const es = d.db.all<{ id: string }>(
        `SELECT e.id FROM journal_entries e JOIN contract_payments p ON p.journal_entry_id = e.id
         WHERE e.status = 'مرحّل' AND e.reversed_by IS NULL ORDER BY e.id`);
      if (!es.length) return null;
      const e = r.pick(es);
      reverseFromJournal(d.db, e.id); // يُرفض بسببه · فالمسدَّد لا يفارق الدفتر
      return 'عكس قيد دفعة';
    } },
    { name: 'إلغاء دفعة', run: async (d) => {
      const ps = d.db.all<{ id: string }>(`SELECT id FROM contract_payments WHERE cancelled_at IS NULL ORDER BY id`);
      if (!ps.length) return null;
      cancelPayment(d.db, r.pick(ps).id, { date: date(), reason: 'اختبار' });
      return 'إلغاء دفعة';
    } },
    { name: 'نسخة', run: async (d) => {
      const f = d.file.replace(/\.db$/, `-bk${++backups}.db`);
      if (d.backup) for (const x of ['', '-wal', '-shm']) fs.rmSync(d.backup + x, { force: true });
      d.db.exec(`VACUUM INTO '${f}'`);
      d.backup = f;
      return 'نسخة';
    } },
    { name: 'استعادة واعتمادها', run: async (d) => {
      if (!d.backup || !d.remote.online) return null;
      // الاستعادة مع الدخول كما في التطبيق (prepareRestore ثم الاعتماد): المزامنة متوقفة · لقطة السحابة تُقرأ مرة،
      // والقيود المرحّلة بعد النسخة — من الجهاز والسحابة — تُضمّ إلى قاعدة التجهيز قبل التبديل (التصميم ٤)
      const snap = await readCloud(d.remote);
      const staged = d.file.replace(/.db$/, '-staged.db');
      for (const x of ['', '-wal', '-shm']) fs.rmSync(staged + x, { force: true });
      fs.copyFileSync(d.backup, staged);
      const probe = openNodeDb(staged);
      let kept = 0;
      try {
        recomputeInstallments(probe);
        const letter = d.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'device_letter'`)?.value;
        if (letter !== undefined) probe.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('device_letter', ?)`, [letter]);
        const keep = planKeepPosted(probe, { device: d.db, cloud: snap.docs });
        kept = applyKeepPosted(probe, keep).entries.length;
        probe.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally { probe.close(); }
      d.db.close();
      for (const x of ['', '-wal', '-shm']) if (fs.existsSync(d.file + x)) fs.rmSync(d.file + x);
      fs.copyFileSync(staged, d.file);
      for (const x of ['', '-wal', '-shm']) fs.rmSync(staged + x, { force: true });
      d.db = openNodeDb(d.file);
      ensureDeviceId(d.db, d.dev);
      adoptAsCloudTruth(d.db, UID, planFromSnapshot(d.db, snap));
      await sync(d);
      if (kept) log.push(`${d.name}: استعادة ضمّت ${kept} قيد مرحّل بعد النسخة`);
      // الآخر لم يسحب الاستبدال بعد
      stale.set(d === A ? B : A, true);
      return 'استعادة';
    } },
    { name: 'قطع الاتصال', run: async (d) => { d.remote.online = false; return 'قطع'; } },
    { name: 'وصل الاتصال ومزامنة', run: async (d) => { d.remote.online = true; await sync(d); return 'وصل ومزامنة'; } },
    { name: 'مزامنة', run: async (d) => { await sync(d); return d.remote.online ? 'مزامنة' : null; } },
  ];

  async function payOne(d: Device, kind: string | null): Promise<string | null> {
    const all = d.db.all<{ id: string; contract_id: string; amount: number; paid: number; disc: number }>(
      `SELECT i.id, i.contract_id, i.amount_halalas AS amount, i.paid_halalas AS paid, ${INSTALLMENT_DISCOUNT_SQL} AS disc
       FROM contract_installments i JOIN contracts c ON c.id = i.contract_id
       WHERE c.status = 'سارٍ' AND i.status != 'ملغية' ORDER BY i.id`);
    if (!all.length) return null;
    const i = r.pick(all);
    const remaining = Number(i.amount) - Number(i.paid) - Number(i.disc);
    if (remaining <= 0) return null;
    const discount = kind ? r.int(1, Math.max(1, Math.floor(remaining / 10000))) * 100 : 0;
    const cash = Math.max(1, r.int(1, Math.max(1, remaining - discount)));
    recordRentPayment(d.db, i.contract_id, {
      installmentId: i.id, period: 'فترة', date: date(), notes: '',
      discountHalalas: discount, discountKind: kind as never, lines: [{ method: 'cash', amountHalalas: cash }],
    });
    return `دفعة ${cash}` + (kind ? ` خصم ${discount} (${kind})` : '');
  }

  try {
    for (let s = 0; s < steps; s++) {
      const d = r.pick(devices);
      const op = r.pick(ops);
      const writes = !['قطع الاتصال', 'وصل الاتصال ومزامنة', 'مزامنة', 'نسخة'].includes(op.name);
      if (writes && !(await canWrite(d))) continue;
      let done: string | null = null;
      try {
        done = await op.run(d);
      } catch (e) {
        if (e instanceof RuleViolation) { log.push(`${d.name}: ${op.name} رُفض بقاعدة · ${e.message}`); continue; }
        throw new Error(`${d.name}: ${op.name} رمى · ${e instanceof Error ? e.message : String(e)}`);
      }
      if (done) {
        log.push(`${d.name}: ${done}`);
        if (process.env.FUZZ_TRACE) {
          for (const x of devices) {
            log.push(`   ${x.name} contracts=` + JSON.stringify(x.db.all(`SELECT substr(id,-4) id, contract_no no, deposit_halalas dep FROM contracts`))
              + ' outbox=' + outboxCount(x.db)
              + ' entries=' + JSON.stringify(x.db.all(`SELECT no, src_type FROM journal_entries ORDER BY no`)));
          }
        }
        check(d, op.name);
      }
    }
    // النهاية: الاتصال يعود للجهازين وتتكرر المزامنة حتى تستقر
    for (const d of devices) d.remote.online = true;
    for (let k = 0; k < 3; k++) for (const d of devices) await sync(d);
    for (const d of devices) {
      const rej = Number(d.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects`)!.n);
      if (rej) throw new Error(`${d.name}: ${rej} وارد مرفوض · ` + d.db.all<{ reason: string }>(`SELECT reason FROM sync_rejects LIMIT 3`).map((x) => x.reason).join(' | '));
      check(d, 'المزامنة النهائية');
    }
    if (deviceState(A.db) !== deviceState(B.db)) throw new Error('الجهازان لا يتطابقان بعد المزامنة');
    return { seed: seedNo, ok: true, log };
  } catch (e) {
    return { seed: seedNo, ok: false, log, failure: e instanceof Error ? e.message : String(e) };
  } finally {
    for (const d of devices) {
      try { d.db.close(); } catch { /* أُغلقت */ }
      for (const f of [d.file, d.backup].filter(Boolean) as string[]) {
        for (const s of ['', '-wal', '-shm']) try { fs.rmSync(f + s, { force: true }); } catch { /* التالي */ }
      }
    }
  }
}

export const FAILURES_FILE = path.join(__dirname, '..', 'fuzz-failures.json');

/** تسلسل فشل يُحفظ بذرةً دائمة · يُعاد في fuzzRegressions.test.ts في كل تشغيل */
export function saveFailure(res: FuzzResult): void {
  let list: Array<{ seed: number; failure: string }> = [];
  try { list = JSON.parse(fs.readFileSync(FAILURES_FILE, 'utf8')); } catch { list = []; }
  if (!list.some((x) => x.seed === res.seed)) list.push({ seed: res.seed, failure: res.failure ?? '' });
  fs.writeFileSync(FAILURES_FILE, JSON.stringify(list, null, 1) + '\n');
}
