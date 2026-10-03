/**
 * القيد المرحّل لا يُحذف بالاستعادة (قرار المالك ٢٠٢٦-١٠-٠٣ · التصميم ٤).
 *
 * ما رُحّل بعد تاريخ النسخة — على هذا الجهاز أو في السحابة من غيره — يُضمّ إلى النسخة المستعادة
 * برقمه وسطوره، ويُعرض قبل التأكيد مع بيان أنه يبقى. ومعه ما يُحمل من مستنده:
 *  - دفعة الإيجار بسطورها وتوزيعها (وإلغاؤها إن أُلغيت) متى كان عقدها وأقساطها في النسخة،
 *    ثم يُحسب المسدَّد منها (paid.ts) فلا يفارق الدفتر.
 *  - مبلغ القسط حين نزّلته الدفعة («تنزيل من القسط») أو أعاده إلغاؤها.
 *  - حركات البنك المربوطة برقم القيد متى كان بنكها في النسخة.
 *  - ربط القيد العكسي بأصله (reversed_by).
 * وما لا يُحمل مستنده (فاتورة · مشتريات · تأمين · حجز · تقبيل …) يُضمّ قيده كما هو ويُدرج في أداة
 * المراجعة «قيد بلا مستند بعد الاستعادة» · إلا زوجاً عكَس أحدُه الآخر، فأثرهما صفر.
 * ورقمٌ مستعمل في النسخة لقيد آخر يأخذ القيدُ المضموم رقماً جديداً من تسلسل الجهاز ويُذكر القديم في بيانه.
 */
import type { DB, SqlValue } from '../../db/adapter';
import type { RemoteDoc, RowData } from '../../sync/types';
import { nextJournalNo } from '../accounting/post';
import { recomputeInstallments } from '../contracts/paid';
import { DISCOUNT_REDUCES_INSTALLMENT } from '../contracts/installments';
import { fmt } from '../money';
import { logAudit } from '../audit';
import { SOURCE_DOC, markForReview } from '../accounting/orphans';

export type KeptFrom = 'device' | 'cloud' | 'both';

export interface KeptEntry {
  id: string;
  no: string;
  /** رقمٌ جديد حين رقمه مستعمل في النسخة لقيد آخر */
  newNo: string | null;
  date: string;
  memo: string;
  /** مجموع مدينه */
  amount: number;
  from: KeptFrom;
  /** ما حُمل معه من مستنده · «دفعة» «حركة بنك» «ربط بأصله» */
  carried: string[];
  /** سبب إدراجه في المراجعة · null حين لا يحتاجها */
  review: string | null;
}

interface EntryDoc { row: RowData; lines: RowData[]; from: Set<'device' | 'cloud'> }

export interface KeepPlan {
  entries: KeptEntry[];
  /** للتطبيق · لا تُعرض */
  docs: {
    entries: EntryDoc[];
    payments: RowData[];
    paymentLines: RowData[];
    allocations: RowData[];
    bankTx: RowData[];
    /** مبلغ قسطٍ نزّلته دفعةٌ مضمومة أو أعاده إلغاؤها · كما في المصدر */
    installments: Array<{ id: string; amount: number }>;
    /** أصلٌ في النسخة يُربط بقيده العكسي المضموم */
    links: Array<{ id: string; reversedBy: string }>;
  };
}

/** مصدر القيود: القاعدة الحالية على الجهاز و/أو لقطة السحابة */
export interface KeepSources {
  device?: DB;
  cloud?: RemoteDoc[];
}

/** قيدٌ هو مستند نفسه · لا مستند يُحمل ولا مراجعة */
const SELF_CONTAINED = new Set(['cash_op', 'manual']);

const sqlIn = (col: string) => `${col} IN (SELECT value FROM json_each(?))`;

/** صفوف جدول من مصدر بقيمة عمود ضمن مجموعة */
function rowsFrom(src: KeepSources, which: 'device' | 'cloud', table: string, col: string, values: Iterable<string>): RowData[] {
  const set = [...new Set(values)].filter(Boolean);
  if (!set.length) return [];
  if (which === 'device') {
    if (!src.device) return [];
    return src.device.all<RowData>(`SELECT * FROM "${table}" WHERE ${sqlIn(`"${col}"`)}`, [JSON.stringify(set)]);
  }
  const want = new Set(set);
  return (src.cloud ?? []).filter((d) => !d.del && d.t === table && d.d && want.has(String(d.d[col] ?? ''))).map((d) => d.d!);
}

function exists(db: DB, table: string, id: string | null | undefined): boolean {
  if (!id) return false;
  return !!db.get(`SELECT 1 FROM "${table}" WHERE id = ?`, [id]);
}

/** القيود المرحّلة في المصادر وليست في القاعدة الهدف · وما يُحمل معها · قراءة فقط */
export function planKeepPosted(target: DB, src: KeepSources): KeepPlan {
  const targetIds = new Set(target.all<{ id: string }>(`SELECT id FROM journal_entries`).map((r) => r.id));
  const byId = new Map<string, EntryDoc>();
  if (src.device) {
    for (const row of src.device.all<RowData>(
      `SELECT * FROM journal_entries WHERE status = 'مرحّل' AND deleted_at IS NULL ORDER BY date, no`)) {
      if (targetIds.has(String(row.id))) continue;
      const lines = src.device.all<RowData>(`SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY id`, [row.id as string]);
      byId.set(String(row.id), { row, lines, from: new Set(['device']) });
    }
  }
  for (const d of src.cloud ?? []) {
    if (d.del || d.t !== 'journal_entries' || !d.d || d.d.status !== 'مرحّل' || d.d.deleted_at) continue;
    if (targetIds.has(d.k)) continue;
    const have = byId.get(d.k);
    if (have) { have.from.add('cloud'); if (!have.row.reversed_by && d.d.reversed_by) have.row = { ...have.row, reversed_by: d.d.reversed_by }; continue; }
    byId.set(d.k, { row: { ...d.d }, lines: d.lines ?? [], from: new Set(['cloud']) });
  }
  const empty: KeepPlan = { entries: [], docs: { entries: [], payments: [], paymentLines: [], allocations: [], bankTx: [], installments: [], links: [] } };
  if (!byId.size) return empty;

  const docs = [...byId.values()].sort((a, b) => String(a.row.date).localeCompare(String(b.row.date)) || String(a.row.no).localeCompare(String(b.row.no)));
  const keptIds = new Set(byId.keys());
  const keptNos = new Map(docs.map((d) => [String(d.row.no), String(d.row.id)]));
  const carried = new Map<string, Set<string>>();
  const review = new Map<string, string>();
  const mark = (id: string, what: string) => { if (!carried.has(id)) carried.set(id, new Set()); carried.get(id)!.add(what); };

  // ١) الدفعات: بقيدها أو بقيد إلغائها أو بقيد خصمها · الأحدث حالاً أولاً (الملغاة)، ثم نسخة الجهاز
  const discountSrc = docs.filter((d) => /^discount(_rev)?$/.test(String(d.row.src_type ?? ''))).map((d) => String(d.row.src_id ?? ''));
  const payments = new Map<string, { row: RowData; from: 'device' | 'cloud' }>();
  for (const which of ['device', 'cloud'] as const) {
    const found = [
      ...rowsFrom(src, which, 'contract_payments', 'journal_entry_id', keptIds),
      ...rowsFrom(src, which, 'contract_payments', 'cancel_entry_id', keptIds),
      ...rowsFrom(src, which, 'contract_payments', 'id', discountSrc),
    ];
    for (const p of found) {
      const have = payments.get(String(p.id));
      if (!have || (!have.row.cancelled_at && p.cancelled_at)) payments.set(String(p.id), { row: p, from: which });
    }
  }
  const outPayments: RowData[] = [];
  const outLines: RowData[] = [];
  const outAllocs: RowData[] = [];
  const outInsts: Array<{ id: string; amount: number }> = [];
  for (const { row: p, from } of payments.values()) {
    const entriesOf = [p.journal_entry_id, p.cancel_entry_id].map((x) => String(x ?? '')).filter((x) => keptIds.has(x));
    for (const d of docs) if (/^discount(_rev)?$/.test(String(d.row.src_type ?? '')) && d.row.src_id === p.id) entriesOf.push(String(d.row.id));
    const lines = rowsFrom(src, from, 'payment_lines', 'payment_id', [String(p.id)]);
    const allocs = rowsFrom(src, from, 'payment_allocations', 'payment_id', [String(p.id)]);
    const why = !exists(target, 'contracts', p.contract_id as string) ? 'دفعة إيجار · عقدها ليس في النسخة'
      : p.installment_id && !exists(target, 'contract_installments', p.installment_id as string) ? 'دفعة إيجار · قسطها ليس في النسخة'
      : allocs.some((a) => !exists(target, 'contract_installments', a.installment_id as string)) ? 'دفعة إيجار · بعض أقساطها ليست في النسخة'
      : lines.some((l) => l.bank_id && !exists(target, 'banks', l.bank_id as string)) ? 'دفعة إيجار · بنكها ليس في النسخة'
      : null;
    if (why) { for (const e of entriesOf) if (!review.has(e)) review.set(e, why); continue; }
    outPayments.push(p);
    if (p.discount_kind === DISCOUNT_REDUCES_INSTALLMENT && p.installment_id) {
      const srcInst = rowsFrom(src, from, 'contract_installments', 'id', [String(p.installment_id)])[0];
      const cur = target.get<{ a: number }>(`SELECT amount_halalas AS a FROM contract_installments WHERE id = ?`, [p.installment_id as string]);
      if (srcInst && cur && Number(srcInst.amount_halalas) !== Number(cur.a)) outInsts.push({ id: String(p.installment_id), amount: Number(srcInst.amount_halalas) });
    }
    // رصيد المستأجر الدائن رقمٌ على صفّه لا يُحمل · فإن اختلف بين المصدر والنسخة يُراجَع
    const tenant = target.get<{ id: string; c: number }>(
      `SELECT t.id, t.credit_halalas AS c FROM tenants t JOIN contracts k ON k.tenant_id = t.id WHERE k.id = ?`, [p.contract_id as string]);
    const srcTenant = tenant ? rowsFrom(src, from, 'tenants', 'id', [tenant.id])[0] : undefined;
    if (tenant && srcTenant && Number(srcTenant.credit_halalas ?? 0) !== Number(tenant.c)) {
      for (const e of entriesOf) if (!review.has(e)) review.set(e, 'الدفعة حُملت · ورصيد المستأجر الدائن لم يُحمل (في النسخة '
        + fmt(Number(tenant.c)) + ' وقبل الاستعادة ' + fmt(Number(srcTenant.credit_halalas ?? 0)) + ')');
    }
    outLines.push(...lines);
    outAllocs.push(...allocs);
    for (const e of entriesOf) mark(e, 'الدفعة');
  }

  // ٢) حركات البنك برقم القيد · ما ليس في النسخة وبنكه فيها
  const outBank: RowData[] = [];
  const seenTx = new Set<string>();
  for (const which of ['device', 'cloud'] as const) {
    for (const t of rowsFrom(src, which, 'bank_tx', 'journal_no', keptNos.keys())) {
      const id = String(t.id);
      if (seenTx.has(id) || exists(target, 'bank_tx', id)) continue;
      seenTx.add(id);
      const entry = keptNos.get(String(t.journal_no))!;
      if (!exists(target, 'banks', t.bank_id as string)) { if (!review.has(entry)) review.set(entry, 'حركة بنكه على بنك ليس في النسخة'); continue; }
      outBank.push(t);
      mark(entry, 'حركة البنك');
    }
  }

  // ٣) القيد العكسي وأصله: أصلٌ في النسخة يُربط به · وزوجٌ مضموم كله أثره صفر
  const links: Array<{ id: string; reversedBy: string }> = [];
  const paired = new Set<string>();
  const originals = new Map<string, string>(); // العكسي ← أصله
  if (src.device) {
    for (const o of src.device.all<{ id: string; rb: string }>(
      `SELECT id, reversed_by AS rb FROM journal_entries WHERE ${sqlIn('reversed_by')}`, [JSON.stringify([...keptIds])])) originals.set(o.rb, o.id);
  }
  for (const d of src.cloud ?? []) {
    const rb = d.t === 'journal_entries' && !d.del ? (d.d?.reversed_by as string | null) : null;
    if (rb && keptIds.has(rb) && !originals.has(rb)) originals.set(rb, d.k);
  }
  for (const [rev, orig] of originals) {
    if (keptIds.has(orig)) { paired.add(rev); paired.add(orig); continue; }
    const t = target.get<{ rb: string | null }>(`SELECT reversed_by AS rb FROM journal_entries WHERE id = ?`, [orig]);
    if (t && !t.rb) { links.push({ id: orig, reversedBy: rev }); mark(rev, 'ربطه بأصله'); }
  }

  // ٤) المراجعة: ما له مستند لم يُحمل · إلا الزوج المضموم، واليدوي، وعملية النقد
  for (const d of docs) {
    const id = String(d.row.id);
    if (paired.has(id) || Number(d.row.auto) !== 1) { review.delete(id); continue; }
    if (review.has(id) || carried.get(id)?.has('الدفعة')) continue;
    const type = String(d.row.src_type ?? '');
    const base = type.replace(/_rev$/, '');
    if (!type || SELF_CONTAINED.has(base)) continue;
    // عكسيٌّ رُبط بأصله في النسخة ومستندُ أصله بلا حالٍ تُحمل · يُراجَع مستنده
    const doc = SOURCE_DOC[base];
    const label = doc?.[0] ?? base;
    const inBackup = doc ? doc[1].some((t) => exists(target, t, d.row.src_id as string)) : false;
    review.set(id, type.endsWith('_rev')
      ? `عكس قيد ${label} · ${inBackup ? 'مستنده في النسخة بحاله قبل العكس' : 'مستنده ليس في النسخة'}`
      : `قيد ${label} · ${inBackup ? 'مستنده في النسخة بحاله قبل هذا القيد' : 'مستنده ليس في النسخة'}`);
  }

  // ٥) رقمٌ مستعمل في النسخة لقيد آخر · يُعلَّم هنا ويُرقَّم عند التطبيق
  const takenNos = new Set(target.all<{ no: string }>(`SELECT no FROM journal_entries`).map((r) => r.no));
  const seenNos = new Set<string>();
  const entries: KeptEntry[] = docs.map((d) => {
    const no = String(d.row.no);
    const clash = takenNos.has(no) || seenNos.has(no);
    seenNos.add(no);
    const from: KeptFrom = d.from.size === 2 ? 'both' : d.from.has('device') ? 'device' : 'cloud';
    return {
      id: String(d.row.id), no, newNo: clash ? '' : null, date: String(d.row.date), memo: String(d.row.memo ?? ''),
      amount: d.lines.reduce((s, l) => s + Number(l.debit_halalas ?? 0), 0), from,
      carried: [...(carried.get(String(d.row.id)) ?? [])], review: review.get(String(d.row.id)) ?? null,
    };
  });
  return { entries, docs: { entries: docs, payments: outPayments, paymentLines: outLines, allocations: outAllocs, bankTx: outBank, installments: outInsts, links } };
}

function columnsOf(db: DB, table: string): Set<string> {
  return new Set(db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((c) => c.name));
}
function insertRow(db: DB, table: string, data: RowData, cols: Set<string>, upsert: boolean): void {
  const keys = Object.keys(data).filter((c) => cols.has(c));
  const rest = keys.filter((c) => c !== 'id');
  db.run(`INSERT INTO "${table}" (${keys.map((c) => `"${c}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`
    + (upsert ? ` ON CONFLICT(id) DO UPDATE SET ${rest.map((c) => `"${c}" = excluded."${c}"`).join(', ')}` : ''),
    keys.map((c) => (data[c] ?? null) as SqlValue));
}

/**
 * الضمّ ذرّياً · القيد مسودةً بسطوره ثم يُرحَّل فيمرّ بمحفّز التوازن كأي قيد، ثم الدفعات وتوزيعها
 * وحركات البنك، ثم روابط العكس، ثم المسدَّد من الدفعات · وما يحتاج مراجعة يُحفظ لأداة المراجعة.
 * يُعيد الخطة بأرقامها الجديدة إن رُقّم شيء.
 */
export function applyKeepPosted(target: DB, plan: KeepPlan): KeepPlan {
  if (!plan.entries.length) return plan;
  const ec = columnsOf(target, 'journal_entries');
  const lc = columnsOf(target, 'journal_lines');
  const entries = plan.entries.map((e) => ({ ...e }));
  target.transaction(() => {
    const applyingBefore = Number(target.get<{ v: number }>(`SELECT v FROM sync_ctl WHERE k = 'applying'`)?.v ?? 0);
    // الوارد لا يُقاس بسقف القسط قبل أن يكتمل · ثم يُحسب المسدَّد منه (كما في تطبيق المزامنة)
    target.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'applying'`);
    try {
      for (const d of plan.docs.entries) {
        const info = entries.find((e) => e.id === d.row.id)!;
        const row: RowData = { ...d.row, status: 'قيد الإنشاء', reversed_by: null };
        if (info.newNo !== null) {
          info.newNo = nextJournalNo(target);
          row.no = info.newNo;
          row.memo = String(d.row.memo ?? '') + ' (رقمه قبل الاستعادة ' + info.no + ')';
        }
        insertRow(target, 'journal_entries', row, ec, false);
        for (const l of d.lines) insertRow(target, 'journal_lines', { ...l, entry_id: d.row.id }, lc, false);
        target.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = ?`, [d.row.id as string]);
      }
      const pc = columnsOf(target, 'contract_payments');
      for (const p of plan.docs.payments) insertRow(target, 'contract_payments', p, pc, true);
      const plc = columnsOf(target, 'payment_lines');
      const ac = columnsOf(target, 'payment_allocations');
      const payIds = JSON.stringify(plan.docs.payments.map((p) => p.id));
      // سطور الدفعة وتوزيعها من المصدر كما هي · فيرجع ما أعاده الإلغاء ولا يتكرر
      target.run(`DELETE FROM payment_lines WHERE ${sqlIn('payment_id')}`, [payIds]);
      target.run(`DELETE FROM payment_allocations WHERE ${sqlIn('payment_id')}`, [payIds]);
      for (const l of plan.docs.paymentLines) insertRow(target, 'payment_lines', l, plc, false);
      for (const a of plan.docs.allocations) insertRow(target, 'payment_allocations', a, ac, false);
      const bc = columnsOf(target, 'bank_tx');
      const renamed = new Map(entries.filter((e) => e.newNo).map((e) => [e.no, e.newNo!]));
      for (const t of plan.docs.bankTx) insertRow(target, 'bank_tx', { ...t, journal_no: renamed.get(String(t.journal_no)) ?? t.journal_no }, bc, false);
      // روابط العكس بعد وجود الطرفين
      for (const d of plan.docs.entries) {
        if (d.row.reversed_by) target.run(`UPDATE journal_entries SET reversed_by = ? WHERE id = ? AND reversed_by IS NULL
          AND EXISTS (SELECT 1 FROM journal_entries WHERE id = ?)`, [d.row.reversed_by as string, d.row.id as string, d.row.reversed_by as string]);
      }
      for (const i of plan.docs.installments) target.run(`UPDATE contract_installments SET amount_halalas = ? WHERE id = ?`, [i.amount, i.id]);
      for (const l of plan.docs.links) target.run(`UPDATE journal_entries SET reversed_by = ? WHERE id = ? AND reversed_by IS NULL`, [l.reversedBy, l.id]);
    } finally {
      target.run(`UPDATE sync_ctl SET v = ? WHERE k = 'applying'`, [applyingBefore]);
    }
    const insts = new Set<string>();
    for (const p of plan.docs.payments) if (p.installment_id) insts.add(String(p.installment_id));
    for (const a of plan.docs.allocations) insts.add(String(a.installment_id));
    if (insts.size) recomputeInstallments(target, [...insts]);

    const add = entries.filter((e) => e.review).map((e) => ({ id: e.id, no: e.newNo || e.no, reason: e.review! }));
    for (const x of add) markForReview(target, x, x.reason);
    logAudit(target, 'النسخ الاحتياطي', 'update', 'ضمّ قيود بعد النسخة',
      entries.length + ' قيد مرحّل بقي مع الاستعادة: ' + entries.map((e) => e.newNo ? e.no + '←' + e.newNo : e.no).join('، ').slice(0, 220)
      + (add.length ? ' · للمراجعة ' + add.length : ''));
  });
  return { ...plan, entries };
}
