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
 * ودفعة القسط «من التأمين» مستندها تسويته: فلا تُحمل إلا وصفّ التسوية في النسخة (المراجعة الشاملة 2026-11-13 · A1-2)، وهو التسوية التي
 * سُدّدت بها، ولا أخت لها من قيود التسوية تُراجَع · فتعديل التسوية بعد النسخة يُحمل كله أو يُراجَع كله (المراجعة ١٢ · R12-BAK-2) ·
 *   إلا إلغاء دفعةٍ في النسخة بعاكس قيدها: يُحمل ويُراجَع العاكس مع أخواته، فالدفعة التي عُكس قيدها ملغاةٌ بعاكسه كما في المزامنة ·
 *   وتسويتها تسوية العقد صاحب التأمين مصدر قيدها لا عقد الدفعة (R12-DEP-2: قسط عقدٍ رُحِّل تأمينه).
 * ورقمٌ مستعمل في النسخة لقيد آخر يأخذ القيدُ المضموم رقماً جديداً من تسلسل الجهاز ويُذكر القديم في بيانه.
 * وحسابٌ في سطوره ليس في دليل النسخة (أُضيف بعدها) يُحمل صفّه من المصدر قبل القيد، وإلا رفض مفتاح الحساب السطر وفشلت الاستعادة كلها ·
 * وحسابٌ لا صفّ له في أي مصدر يُسمّى برسالة عربية قبل أي كتابة (المراجعة ١٢ · R12-BAK-1) · وحسابٌ في سلة النسخة حيٌّ في المصدر
 * يعود حيّاً بصفّه هناك، وفي السلة في كل مصدر يُسمّى أنه في السلة، فلا يبقى قيدٌ مرحّل على حسابٍ محذوف خارج الميزان.
 * ومسودةٌ في النسخة رُحّلت بعدها (الترحيل يرقّي المسودة في مكانها بمعرّفها) تُستبدل بالمرحّل ولا تعود مسودة
 * (المراجعة الشاملة 2026-11-13 · C-1).
 * ومع القيود المضمومة تُحمل حركات نقل النقد بلا قيد بين المحفظة والبنوك (إيداع وسحب وتحويل · cashOps.ts) بحالها في المصدر: ما ليس في
 * النسخة يُدرج، وما في السلة هناك يُنقل إلى السلة هنا · فالقيد المضموم الذي صرف من بنكٍ لا يجده بلا الإيداع الذي موّله · وما بقي
 * يُنزل بنكاً أو المحفظة تحت الصفر بعد الضمّ يُسمّى ويمنع الاستعادة (keepShortages · القرار ٥٥ · المراجعة ١٢ · R12-BAK-3).
 */
import type { DB, SqlValue } from '../../db/adapter';
import type { RemoteDoc, RowData } from '../../sync/types';
import { nextJournalNo } from '../accounting/post';
import { recomputeInstallments } from '../contracts/paid';
import { DISCOUNT_REDUCES_INSTALLMENT, DEPOSIT_RENT_METHOD } from '../contracts/installments';
import { fmt } from '../money';
import { logAudit } from '../audit';
import { SOURCE_DOC, markForReview } from '../accounting/orphans';
import { t } from '../../i18n';
import { RestoreError } from './types';
import { CASH_DEPOSIT_SOURCE, CASH_WITHDRAW_SOURCE, TRANSFER_OUT_SOURCE, TRANSFER_IN_SOURCE } from '../cashOps';
import { bankBalance, walletCashBalance, ACC_CASH_BANKS } from '../accounting/ledger';

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
  /** كان مسودةً في النسخة بمعرّفه ورُحّل بعدها · فتُستبدل المسودة به (C-1) */
  wasDraft: boolean;
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
    /** حسابات سطور القيود المضمومة وليست في دليل النسخة · تُدرج قبل القيود (R12-BAK-1) */
    accounts: RowData[];
    /** حركات نقل النقد في النسخة ونُقلت إلى السلة في المصدر بعدها · معرّفها ووقت حذفها هناك (R12-BAK-3) */
    trashedMoves: Array<{ id: string; deletedAt: string }>;
  };
  /** حركات نقل النقد بين المحفظة والبنوك بعد النسخة (إيداع وسحب وتحويل) · تُحمل مع القيود وتُعرض بعددها (R12-BAK-3) */
  cashMoves: number;
}

/** مصدر القيود: القاعدة الحالية على الجهاز و/أو لقطة السحابة */
export interface KeepSources {
  device?: DB;
  cloud?: RemoteDoc[];
}

/** قيدٌ هو مستند نفسه · لا مستند يُحمل ولا مراجعة */
const SELF_CONTAINED = new Set(['cash_op', 'manual']);
/** قيود التسوية التي لا يُحمل مستندها (صفّ التسوية) · أخوات دفعة «من التأمين» في التسوية الواحدة (R12-BAK-2) */
const SETTLEMENT_ENTRIES = new Set(['deposit_deduct', 'deposit_refund', 'deposit_deduct_move']);
/** ما تُعرف به التسوية التي سُدّدت بها دفعة «من التأمين» · صفّها في النسخة وفي المصدر */
const SETTLEMENT_KEY = ['date', 'deduction_halalas', 'refund_halalas', 'deduct_destination'];
/** مصادر حركة البنك بلا قيد: نقل النقد بين المحفظة والبنوك (cashOps.ts) · تُحمل مع القيود المضمومة (R12-BAK-3) */
const CASH_MOVE_SOURCES = [CASH_DEPOSIT_SOURCE, CASH_WITHDRAW_SOURCE, TRANSFER_OUT_SOURCE, TRANSFER_IN_SOURCE];
const TRANSFER_SOURCES = new Set([TRANSFER_OUT_SOURCE, TRANSFER_IN_SOURCE]);

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
  // ما في النسخة مرحّلاً يُتخطّى وحده · ومسودتها بمعرّف قيدٍ مرحّل في المصدر تُرقّى إليه، وإلا عادت مسودةً واختفى أثره
  // من الدفتر (المراجعة الشاملة 2026-11-13 · C-1)
  const targetRows = target.all<{ id: string; no: string; posted: number }>(
    `SELECT id, no, status = 'مرحّل' AS posted FROM journal_entries`); // i18n-exempt: حالة القيد المخزّنة
  const targetIds = new Set(targetRows.filter((r) => Number(r.posted) === 1).map((r) => r.id));
  const drafts = new Set(targetRows.filter((r) => Number(r.posted) !== 1).map((r) => r.id));
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
  const empty: KeepPlan = { entries: [], cashMoves: 0, docs: { entries: [], payments: [], paymentLines: [], allocations: [], bankTx: [], installments: [], links: [], accounts: [], trashedMoves: [] } };
  if (!byId.size) return empty;

  const docs = [...byId.values()].sort((a, b) => String(a.row.date).localeCompare(String(b.row.date)) || String(a.row.no).localeCompare(String(b.row.no)));
  const keptIds = new Set(byId.keys());
  const keptNos = new Map(docs.map((d) => [String(d.row.no), String(d.row.id)]));
  const carried = new Map<string, Set<string>>();
  const review = new Map<string, string>();
  const mark = (id: string, what: string) => { if (!carried.has(id)) carried.set(id, new Set()); carried.get(id)!.add(what); };

  // ٠) حسابات السطور: ما ليس في دليل النسخة يُحمل صفّه من الجهاز ثم من السحابة · ولا صفّ له في أي مصدر يوقف الضمّ برسالة تسمّيه
  //    قبل أي كتابة، لا بخطأ مفتاحٍ إنجليزي في منتصف التطبيق (المراجعة ١٢ · R12-BAK-1)
  const outAccounts = carryAccounts(target, src, docs, mark);

  // ٣) القيد العكسي وأصله: أصلٌ في النسخة يُربط به · وزوجٌ مضموم كله أثره صفر ·
  //    قبل الدفعات: حمل دفعة «من التأمين» يتوقف على أن أخواتها من قيود التسوية لا تُراجَع (R12-BAK-2)، وحمل إلغائها على ربط عاكسها ·
  //    والعاكس يُربط بأصله ولو رُوجع (عاكس دفعة «من التأمين» في تعديل تسويةٍ يُراجَع كله): الربط حال الدفتر، وبلا ربطٍ تحمرّ «مرآة واحدة
  //    لكل أصل» ولا «عكس القيد» لمرآة · والدفعة التي عُكس قيدها يُحمل إلغاؤها معه (١)، فلا تفترق الاستعادة والمزامنة (Z١-١ وY١)
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

  // دفعات «من التأمين» لعقدٍ تُحمل معاً أو لا تُحمل (R12-BAK-2): صفّ تسويته في النسخة هو التسوية التي سُدّدت بها (تاريخها وخصمها وردّها
  // ووجهة المخصوم كما في المصدر) · ولا قيد تسويةٍ مضموم لعقدها (خصم أو ردّ أو استقرار مخصوم، أو عكسها) يُراجَع، وإلا حُمل جزء التعديل
  // وروجع باقيه فصرفت المستندات التأمين مرتين واحمرّ فحص التأمينات
  const blockedRent = new Map<string, boolean>();
  const depositRentBlocked = (cid: string): boolean => {
    if (blockedRent.has(cid)) return blockedRent.get(cid)!;
    const mine = target.get<RowData>(`SELECT * FROM deposit_settlements WHERE contract_id = ?`, [cid]);
    let blocked = !mine;
    for (const which of ['device', 'cloud'] as const) {
      const theirs = blocked ? undefined : rowsFrom(src, which, 'deposit_settlements', 'contract_id', [cid])[0];
      if (theirs && SETTLEMENT_KEY.some((k) => String(theirs[k] ?? '') !== String(mine![k] ?? ''))) blocked = true;
    }
    if (!blocked) {
      blocked = docs.some((d) => String(d.row.src_id ?? '') === cid && Number(d.row.auto) === 1 && !paired.has(String(d.row.id))
        && SETTLEMENT_ENTRIES.has(String(d.row.src_type ?? '').replace(/_rev$/, '')));
    }
    blockedRent.set(cid, blocked);
    return blocked;
  };

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
  // العقد صاحب التأمين لدفعةٍ «من التأمين»: مصدر قيدها، من القيد المضموم أو من النسخة، وإلا عقد الدفعة (R12-DEP-2)
  const depositHolderOf = (p: RowData): string => {
    const je = String(p.journal_entry_id ?? '');
    const kept = je ? byId.get(je)?.row.src_id : null;
    const held = kept ?? (je ? target.get<{ s: string | null }>(`SELECT src_id AS s FROM journal_entries WHERE id = ?`, [je])?.s : null);
    return String(held || p.contract_id || '');
  };
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
    // دفعة القسط من التأمين مستندها تسويتها: لا تُحمل إلا والتسوية التي سُدّدت بها في النسخة، فيُراجَع قيدها كقيد الخصم «مستنده في النسخة
    // بحاله قبل هذا القيد» ويخرج أثره من مطابقة 2400 (المراجعة الشاملة 2026-11-13 · A1-2) · وتعديل التسوية بعد النسخة يُحمل كله أو
    // يُراجَع كله (المراجعة ١٢ · R12-BAK-2) · وتسويتها تسوية العقد صاحب التأمين، مصدر قيدها، لا عقد الدفعة: قسط عقدٍ رُحِّل تأمينه
    // دفعته على عقده وقيدها مصدره المجدَّد (R12-DEP-2)، والسابق لا تسوية له
    // إلا إلغاء دفعةٍ في النسخة قيدُها فيها ربطه الضمّ بعاكسه (٣): الدفعة التي عُكس قيدها ملغاةٌ بعاكسه، قاعدة المزامنة نفسها (Z١-١ وZ٢-٢)،
    // والإلغاء لا رجعة فيه (Y١) · فيُحمل إلغاؤها ويبقى عاكسها في المراجعة مع أخواته من قيود التعديل، فلا تفترق الاستعادة والمزامنة
    // ولا يحمرّ فحص التأمينات: صفّ التسوية في النسخة يطابقه أصل القيد، والعاكس وأخواته خارج المطابقة حتى تُحفظ التسوية ثانيةً
    // (المراجع المعاكس الثاني على تعارض R12-DEP-2 مع R12-BAK-2)
    if (p.method_label === DEPOSIT_RENT_METHOD && depositRentBlocked(depositHolderOf(p))) {
      const je = String(p.journal_entry_id ?? '');
      const ce = String(p.cancel_entry_id ?? '');
      if (!p.cancelled_at || !keptIds.has(ce) || keptIds.has(je) || !links.some((l) => l.id === je && l.reversedBy === ce)) continue;
      review.set(ce, t('backup.keptDepositRentCancel'));
    }
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
  const moves = planCashMoves(target, src, seenTx);
  outBank.push(...moves.add);

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
    const label = doc?.[0] ?? 'آلي'; // نوعٌ غير معروف لا يُعرض اسمه التقني
    const inBackup = doc ? doc[1].some((t) => exists(target, t, d.row.src_id as string)) : false;
    review.set(id, type.endsWith('_rev')
      ? `عكس قيد ${label} · ${inBackup ? 'مستنده في النسخة بحاله قبل العكس' : 'مستنده ليس في النسخة'}`
      : `قيد ${label} · ${inBackup ? 'مستنده في النسخة بحاله قبل هذا القيد' : 'مستنده ليس في النسخة'}`);
  }

  // ٥) رقمٌ مستعمل في النسخة لقيد آخر · يُعلَّم هنا ويُرقَّم عند التطبيق ·
  //    ورقم المسودة المرقّاة لا يُعدّ تصادماً: التطبيق يستبدل رؤوس المسودات قبل أي قيدٍ آخر، فيخلو رقمها القديم قبل أن
  //    يُدرج غيرها وإن تغيّر رقمها بعد النسخة (ترقيم الانضمام) · فلا يتوقف هذا على ترتيب التاريخ (المراجعة الشاملة 2026-11-13 · C-1)
  const takenNos = new Set(targetRows.filter((r) => !(drafts.has(r.id) && keptIds.has(r.id))).map((r) => r.no));
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
      wasDraft: drafts.has(String(d.row.id)),
    };
  });
  return {
    entries, cashMoves: moves.add.length + moves.trashed.length,
    docs: { entries: docs, payments: outPayments, paymentLines: outLines, allocations: outAllocs, bankTx: outBank, installments: outInsts, links,
      accounts: outAccounts, trashedMoves: moves.trashed },
  };
}

/**
 * حركات نقل النقد بلا قيد بين المحفظة والبنوك (R12-BAK-3) بحالها في المصدر: ما ليس في الهدف وبنكه فيه يُدرج كما هو (حيّاً أو في
 * السلة)، وما في الهدف حيّاً وفي سلة المصدر يُنقل إليها · وساقا التحويل معاً: ساقٌ بنكها ليس في الهدف تُسقط أختها (التاريخ والبيان
 * والمبلغ، ببنكٍ آخر)، وإلا خرج من بنكٍ ولم يدخل غيره فصار في المحفظة نقدٌ ليس في اليد
 */
function planCashMoves(target: DB, src: KeepSources, seen: Set<string>): { add: RowData[]; trashed: Array<{ id: string; deletedAt: string }> } {
  const rows: RowData[] = [];
  const byId = new Set<string>();
  const take = (r: RowData) => { const id = String(r.id); if (byId.has(id)) return; byId.add(id); rows.push(r); };
  if (src.device) {
    for (const r of src.device.all<RowData>(`SELECT * FROM bank_tx WHERE journal_no = '' AND ${sqlIn('source')}`, [JSON.stringify(CASH_MOVE_SOURCES)])) take(r);
  }
  for (const d of src.cloud ?? []) {
    if (d.del || d.t !== 'bank_tx' || !d.d || d.d.journal_no || !CASH_MOVE_SOURCES.includes(String(d.d.source ?? ''))) continue;
    take({ ...d.d, id: d.k });
  }
  const add: RowData[] = [];
  const trashed: Array<{ id: string; deletedAt: string }> = [];
  const lost: RowData[] = [];
  for (const r of rows) {
    const id = String(r.id);
    if (seen.has(id)) continue;
    const mine = target.get<{ del: string | null }>(`SELECT deleted_at AS del FROM bank_tx WHERE id = ?`, [id]);
    if (mine) {
      if (!mine.del && r.deleted_at) trashed.push({ id, deletedAt: String(r.deleted_at) });
      continue;
    }
    if (!exists(target, 'banks', r.bank_id as string)) { if (TRANSFER_SOURCES.has(String(r.source))) lost.push(r); continue; }
    add.push(r);
  }
  // ساق تحويلٍ بنكها ليس في الهدف: تُسقط أختها المقابلة مرةً واحدة
  const key = (r: RowData) => String(r.date) + '|' + String(r.descr) + '|' + Math.abs(Number(r.amount_halalas));
  for (const l of lost) {
    const other = l.source === TRANSFER_OUT_SOURCE ? TRANSFER_IN_SOURCE : TRANSFER_OUT_SOURCE;
    const i = add.findIndex((r) => r.source === other && r.bank_id !== l.bank_id && key(r) === key(l));
    if (i >= 0) add.splice(i, 1);
  }
  for (const r of add) seen.add(String(r.id));
  return { add, trashed };
}

/**
 * ما يُنزله الضمّ تحت الصفر قبل أي كتابة (القرار ٥٥ · R12-BAK-3): رصيد كل بنكٍ بعد حركاته المحمولة، والنقد في المحفظة بعد سطور 1100
 * في القيود المضمومة ناقصاً ما حُمل إلى البنوك · وبنكٌ أو محفظةٌ كان سالباً في النسخة ولم يزده الضمّ نقصاً لا يمنع (حال النسخة نفسها) ·
 * رسالةٌ عربية لكلٍّ تسمّيه ورصيده بعد الضمّ وما ينقصه
 */
export function keepShortages(target: DB, plan: KeepPlan): string[] {
  if (!plan.entries.length && !plan.cashMoves) return [];
  const bankDelta = new Map<string, number>();
  const live = (r: RowData) => !r.deleted_at;
  for (const tx of plan.docs.bankTx) if (live(tx)) bankDelta.set(String(tx.bank_id), (bankDelta.get(String(tx.bank_id)) ?? 0) + Number(tx.amount_halalas));
  for (const m of plan.docs.trashedMoves) {
    const r = target.get<{ b: string; a: number }>(`SELECT bank_id AS b, amount_halalas AS a FROM bank_tx WHERE id = ?`, [m.id]);
    if (r) bankDelta.set(r.b, (bankDelta.get(r.b) ?? 0) - Number(r.a));
  }
  let cashDelta = 0;
  for (const d of plan.docs.entries) {
    // مسودة النسخة لا رصيد لها قبل الضمّ · فسطور مرحّلها كلها أثر
    for (const l of d.lines) if (String(l.account_code) === ACC_CASH_BANKS) cashDelta += Number(l.debit_halalas ?? 0) - Number(l.credit_halalas ?? 0);
  }
  const out: string[] = [];
  let banksFlow = 0;
  for (const [bank, delta] of bankDelta) {
    banksFlow += delta;
    if (delta >= 0) continue;
    const after = bankBalance(target, bank) + delta;
    if (after >= 0) continue;
    const name = target.get<{ n: string }>(`SELECT name AS n FROM banks WHERE id = ?`, [bank])?.n ?? '';
    out.push(t('restore.keptBankShort', { bank: name, balance: fmt(after), short: fmt(-after) }));
  }
  const walletDelta = cashDelta - banksFlow;
  const wallet = walletCashBalance(target) + walletDelta;
  if (walletDelta < 0 && wallet < 0) out.push(t('restore.keptWalletShort', { balance: fmt(wallet), short: fmt(-wallet) }));
  return out;
}

/**
 * صفوف الحسابات التي تحتاجها سطور القيود المضمومة وليست حيّةً في الهدف · من الجهاز أولاً ثم من لقطة السحابة، والحيّ منها وحده ·
 * فحسابٌ في سلة النسخة استُعيد من السلة بعدها ورُحّل عليه يعود حيّاً بصفّه في المصدر، وإلا بقي القيد على حسابٍ محذوف فخرج من الدليل
 * والميزان واحمرّ فحص التوازن (مراجعة R12-BAK-1) · والتطبيق يكتب صفّ المصدر فوق صفّ السلة
 */
function carryAccounts(target: DB, src: KeepSources, docs: EntryDoc[], mark: (id: string, what: string) => void): RowData[] {
  const usedBy = new Map<string, string[]>();
  for (const d of docs) {
    for (const l of d.lines) {
      const code = String(l.account_code ?? '');
      if (!code) continue;
      if (!usedBy.has(code)) usedBy.set(code, []);
      usedBy.get(code)!.push(String(d.row.id));
    }
  }
  if (!usedBy.size) return [];
  const codes = JSON.stringify([...usedBy.keys()]);
  const have = new Set(target.all<{ code: string }>(`SELECT code FROM accounts WHERE ${sqlIn('code')} AND deleted_at IS NULL`, [codes]).map((r) => r.code));
  const missing = [...usedBy.keys()].filter((c) => !have.has(c)).sort();
  if (!missing.length) return [];
  const found = new Map<string, RowData>();
  if (src.device) {
    for (const r of src.device.all<RowData>(`SELECT * FROM accounts WHERE ${sqlIn('code')} AND deleted_at IS NULL`, [JSON.stringify(missing)])) found.set(String(r.code), r);
  }
  for (const d of src.cloud ?? []) {
    if (d.del || d.t !== 'accounts' || !d.d || d.d.deleted_at || found.has(d.k) || !missing.includes(d.k)) continue;
    found.set(d.k, { ...d.d, code: d.k });
  }
  const lost = missing.find((c) => !found.has(c));
  if (lost) {
    const entry = docs.find((d) => d.lines.some((l) => String(l.account_code) === lost))!;
    const amount = entry.lines.reduce((s, l) => s + Number(l.debit_halalas ?? 0), 0);
    // له صفٌّ في سلة النسخة أو المصدر ولا صفّ حيّاً له: يُسمّى أنه في السلة، فاستعادته من السلة على هذا الجهاز تحلّه
    const trashed = !!target.get(`SELECT 1 FROM accounts WHERE code = ?`, [lost])
      || !!src.device?.get(`SELECT 1 FROM accounts WHERE code = ?`, [lost])
      || (src.cloud ?? []).some((d) => !d.del && d.t === 'accounts' && d.k === lost);
    throw new RestoreError(t(trashed ? 'restore.keptAccountTrashed' : 'restore.keptAccountMissing', { no: String(entry.row.no), amount: fmt(amount), code: lost }));
  }
  return missing.map((code) => {
    const row = found.get(code)!;
    for (const id of usedBy.get(code)!) mark(id, t('backup.keptAccount', { code, name: String(row.name ?? '') }).trim());
    return row;
  });
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
 * الضمّ ذرّياً · القيد مسودةً بسطوره ثم يُرحَّل فيمرّ بمحفّز التوازن كأي قيد (ومسودة النسخة بمعرّفه تُحذف سطورها
 * ويأخذ رأسها رأسَ المرحّل قبل ذلك، والمسودات قبل غيرها · C-1)، ثم الدفعات وتوزيعها
 * وحركات البنك، ثم روابط العكس، ثم المسدَّد من الدفعات · وما يحتاج مراجعة يُحفظ لأداة المراجعة.
 * يُعيد الخطة بأرقامها الجديدة إن رُقّم شيء.
 */
export function applyKeepPosted(target: DB, plan: KeepPlan): KeepPlan {
  if (!plan.entries.length) return plan;
  const ec = columnsOf(target, 'journal_entries');
  const lc = columnsOf(target, 'journal_lines');
  const entries = plan.entries.map((e) => ({ ...e }));
  const accCols = columnsOf(target, 'accounts');
  target.transaction(() => {
    // حسابات السطور قبل القيود: مفتاح journal_lines.account_code يرفض سطراً على حسابٍ ليس في الدليل (R12-BAK-1) · وحسابٌ في سلة
    // النسخة يأخذ صفّه الحيّ من المصدر فيخرج من السلة (مراجعة R12-BAK-1) · والحيّ في النسخة لا يُحمل أصلاً فلا يُمسّ
    for (const a of plan.docs.accounts ?? []) {
      const keys = Object.keys(a).filter((c) => accCols.has(c));
      const rest = keys.filter((c) => c !== 'code');
      target.run(`INSERT INTO accounts (${keys.map((c) => `"${c}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`
        + ` ON CONFLICT(code) DO ${rest.length ? `UPDATE SET ${rest.map((c) => `"${c}" = excluded."${c}"`).join(', ')} WHERE accounts.deleted_at IS NOT NULL` : 'NOTHING'}`,
        keys.map((c) => (a[c] ?? null) as SqlValue));
    }
    const applyingBefore = Number(target.get<{ v: number }>(`SELECT v FROM sync_ctl WHERE k = 'applying'`)?.v ?? 0);
    // الوارد لا يُقاس بسقف القسط قبل أن يكتمل · ثم يُحسب المسدَّد منه (كما في تطبيق المزامنة)
    target.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'applying'`);
    try {
      // مسودات النسخة أولاً: رقمها القديم خارج فحص التصادم (planKeepPosted ٥)، ومرحّلها قد يحمل رقماً غيره، فلا يُدرج قبلها
      // قيدٌ برقمها وهي بعدُ تحمله فيرفضه قيد التفرّد وتفشل الاستعادة كلها (المراجعة الشاملة 2026-11-13 · C-1)
      const draftIds = new Set(entries.filter((e) => e.wasDraft).map((e) => e.id));
      const ordered = [...plan.docs.entries.filter((d) => draftIds.has(String(d.row.id))),
        ...plan.docs.entries.filter((d) => !draftIds.has(String(d.row.id)))];
      for (const d of ordered) {
        const info = entries.find((e) => e.id === d.row.id)!;
        const row: RowData = { ...d.row, status: 'قيد الإنشاء', reversed_by: null };
        if (info.newNo !== null) {
          info.newNo = nextJournalNo(target);
          row.no = info.newNo;
          row.memo = String(d.row.memo ?? '') + ' (رقمه قبل الاستعادة ' + info.no + ')';
        }
        // مسودة النسخة تُستبدل بالمرحّل كما رُحّل: سطورها تُحذف ورأسها يأخذ رأسه وهو بعدُ مسودة (C-1)
        if (info.wasDraft) target.run(`DELETE FROM journal_lines WHERE entry_id = ?`, [d.row.id as string]);
        insertRow(target, 'journal_entries', row, ec, info.wasDraft);
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
      // ونقل النقد الذي حُذف في المصدر بعد النسخة يُنقل إلى السلة هنا (R12-BAK-3)
      for (const m of plan.docs.trashedMoves ?? []) target.run(`UPDATE bank_tx SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, [m.deletedAt, m.id]);
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
