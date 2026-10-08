import type { DB } from '../../db/adapter';
import { requireCash } from '../cashGuard';
import { uid } from '../ids';
import { today } from '../dates';
import { correctionDate } from '../vatFilings';
import { fmt } from '../money';
import { DISCOUNT_ACCOUNT, DISCOUNT_AFTER_DUE, DISCOUNT_ENTRY_SRC, type DiscountKind } from '../contracts/installments';
import { deviceLetter, ownNumbersSql, withLetter, takeNumber, peekNumber } from '../numbering';
import { rentRevenueLines } from './rentSplit';
import { dimsFromSource, hasDimColumns, lineDims, ambientCostCenter, inheritedCostCenter, GENERAL_COST_CENTER, type Dims } from './dimensions';

export interface EntryLine {
  account: string;
  descr?: string;
  debit: number; // هللات
  credit: number; // هللات
  /** أبعاد هذا السطر وحده · تغلب أبعاد القيد (الإهلاك لكل أصل، والعاكس بأبعاد أصله) */
  dims?: Dims;
}

export interface PostedEntry {
  id: string;
  no: string;
}

export class UnbalancedEntryError extends Error {
  constructor() {
    super('تعذّر الترحيل · قيد غير متوازن');
    this.name = 'UnbalancedEntryError';
  }
}
export class MissingAccountsError extends Error {
  constructor(public missing: string[]) {
    super('حسابات ناقصة: ' + missing.join('، '));
    this.name = 'MissingAccountsError';
  }
}

/** آخر رقم قيد لهذا الجهاز بالترقيم القديم · من أرقامه وحده (numbering.ts) */
function lastJournalSeq(db: DB): number {
  const own = ownNumbersSql('no', 'JE-[0-9]*', deviceLetter(db));
  return Number(db.get<{ mx: number }>(
    `SELECT COALESCE(MAX(CAST(substr(no, 4) AS INTEGER)), 0) AS mx FROM journal_entries WHERE ${own.sql}`, own.params)?.mx ?? 0);
}

const journalNo = (n: number) => 'JE-' + String(n).padStart(4, '0');

/** الرقم التالي للقيد JE-#### من كتلة هذا الجهاز · وبلا كتلة بالترقيم القديم (numbering.ts) · يُستهلك مع معاملته */
export function nextJournalNo(db: DB): string {
  const n = takeNumber(db, 'JE');
  return n !== null ? journalNo(n) : withLetter(journalNo(lastJournalSeq(db) + 1), deviceLetter(db));
}

/** الرقم الذي سيأخذه القيد التالي · للعرض قبل الحفظ ولا يُستهلك */
export function peekJournalNo(db: DB): string {
  const n = peekNumber(db, 'JE');
  return n !== null ? journalNo(n) : withLetter(journalNo(lastJournalSeq(db) + 1), deviceLetter(db));
}

/**
 * مسار الترحيل الواحد: يُدرج القيد «قيد الإنشاء»، يضيف سطوره،
 * ثم يرقّيه «مرحّل» · والمحفّز في القاعدة يرفض غير المتوازن.
 */
export function postEntry(
  db: DB,
  args: {
    date: string;
    memo: string;
    lines: EntryLine[];
    auto?: boolean;
    srcType?: string;
    srcId?: string;
    /** أبعاد القيد الصريحة · تغلب المشتقة من مصدره (dimensions.ts) */
    dims?: Dims;
  }
): PostedEntry | null {
  const rows = args.lines.filter((l) => Math.abs(l.debit || 0) > 0 || Math.abs(l.credit || 0) > 0);
  if (!rows.length) return null;
  const D = rows.reduce((s, r) => s + (r.debit || 0), 0);
  const C = rows.reduce((s, r) => s + (r.credit || 0), 0);
  if (D !== C) throw new UnbalancedEntryError();
  const missing = rows
    .map((r) => r.account)
    .filter(
      (c) => !db.get(`SELECT code FROM accounts WHERE code = ? AND deleted_at IS NULL`, [c])
    );
  if (missing.length) throw new MissingAccountsError([...new Set(missing)]);

  return db.transaction(() => {
    const id = uid();
    const no = nextJournalNo(db);
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO journal_entries (id, no, date, memo, status, auto, src_type, src_id, created_at)
       VALUES (?,?,?,?,'قيد الإنشاء',?,?,?,?)`,
      [id, no, args.date, args.memo, args.auto === false ? 0 : 1, args.srcType ?? null, args.srcId ?? null, now]
    );
    // أبعاد كل سطر: من مصدر القيد، والصريح يغلب، ومركز التكلفة من العملية الجارية (قرار المالك ٢٠٢٦-١٠-٠٤) ·
    // وقاعدةٌ قبل الهجرة ٢٨ (نسخة تُصحَّح قبل ترقيتها) تُرحَّل سطورها بلا أبعاد كما كانت
    if (!hasDimColumns(db)) {
      for (const l of rows) {
        db.run(
          `INSERT INTO journal_lines (id, entry_id, account_code, descr, debit_halalas, credit_halalas) VALUES (?,?,?,?,?,?)`,
          [uid(), id, l.account, l.descr ?? '', l.debit || 0, l.credit || 0]);
      }
      db.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = ?`, [id]);
      return { id, no };
    }
    const derived = dimsFromSource(db, args.srcType, args.srcId);
    // مركز التكلفة: الصريح، ثم ما اختارته الشاشة، ثم مركز المستند الأصلي (العملية بضغطة بلا نموذج)، ثم «عام»
    const cc = args.dims?.costCenterId ?? ambientCostCenter() ?? inheritedCostCenter(db, args.srcType, args.srcId) ?? GENERAL_COST_CENTER;
    const explicit = { ...(args.dims ?? {}), costCenterId: cc };
    for (const l of rows) {
      const d = lineDims(derived, explicit, l.dims);
      db.run(
        `INSERT INTO journal_lines (id, entry_id, account_code, descr, debit_halalas, credit_halalas,
           property_id, unit_id, contract_id, cost_center_id, asset_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [uid(), id, l.account, l.descr ?? '', l.debit || 0, l.credit || 0,
         d.propertyId, d.unitId, d.contractId, d.costCenterId, d.assetId]
      );
    }
    // الترقية · المحفّز trg_je_post_balanced يتحقق هنا داخل القاعدة
    db.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = ?`, [id]);
    return { id, no };
  });
}

/**
 * القيد اليدوي من شاشة الدفتر · لا حركة بنك معه، فصافي دائن النقدية 1100 فيه صرفٌ من المحفظة
 * يتحقق من كفاية النقد (قرار المالك ٢٠٢٦-١٠-٠٥).
 */
export function manualCashOut(lines: EntryLine[]): number {
  const net = lines.filter((l) => l.account === CASH).reduce((s, l) => s + (l.credit || 0) - (l.debit || 0), 0);
  return Math.max(0, net);
}
export function postManualEntry(db: DB, args: { date: string; memo: string; lines: EntryLine[] }): PostedEntry | null {
  requireCash(db, manualCashOut(args.lines), 'القيد اليدوي');
  return postEntry(db, { ...args, auto: false });
}

/** عكس قيد مصدره معروف (للحذف من السلة ونحوه) */
export function reverseEntryBySource(db: DB, srcType: string, srcId: string, memo?: string): PostedEntry | null {
  const e = db.get<{ id: string }>(
    `SELECT id FROM journal_entries
     WHERE src_type = ? AND src_id = ? AND reversed_by IS NULL AND deleted_at IS NULL AND status='مرحّل'
     ORDER BY created_at DESC LIMIT 1`,
    [srcType, srcId]
  );
  // عكسٌ واحد لكل قيد: بأبعاد أصله سطراً بسطر (#34: كانت تُشتق من المصدر الحالي ومركز الشاشة) وبتاريخ التصحيح (#29)
  return e ? reverseEntryById(db, e.id, memo) : null;
}

/**
 * «قيد مرحّل لا يُحذف أبداً · يُعكَس»: يرحَّل قيد مرآة ويُختم الأصل بـ reversed_by · الأصل والعاكس يبقيان معاً في
 * الدفتر فالتاريخ لا يُمحى. تاريخه ما اختاره المستخدم لحدثه (إلغاء دفعة بتاريخها)، وإلا فتاريخ التصحيح: تاريخ الأصل،
 * إلا إن قُدِّم إقرار فترته فاليوم (قرار المالك على #29 · vatFilings.correctionDate).
 */
export function reverseEntryById(db: DB, entryId: string, memo?: string, date?: string): PostedEntry | null {
  const e = db.get<{ id: string; no: string; date: string; src_type: string | null; src_id: string | null }>(
    `SELECT id, no, date, src_type, src_id FROM journal_entries
     WHERE id = ? AND reversed_by IS NULL AND deleted_at IS NULL AND status = 'مرحّل'`,
    [entryId]
  );
  if (!e) return null;
  const lines = db.all<{
    account_code: string; descr: string; debit_halalas: number; credit_halalas: number;
    property_id: string | null; unit_id: string | null; contract_id: string | null; cost_center_id: string | null; asset_id: string | null;
  }>(
    `SELECT account_code, descr, debit_halalas, credit_halalas${hasDimColumns(db) ? ', property_id, unit_id, contract_id, cost_center_id, asset_id' : ''}
     FROM journal_lines WHERE entry_id = ?`,
    [e.id]
  );
  return db.transaction(() => {
    const posted = postEntry(db, {
      date: date ?? correctionDate(db, e.date),
      memo: memo ?? 'عكس قيد ' + e.no,
      // العاكس بأبعاد أصله سطراً بسطر
      lines: lines.map((l) => ({
        account: l.account_code,
        descr: l.descr,
        debit: Number(l.credit_halalas),
        credit: Number(l.debit_halalas),
        dims: { propertyId: l.property_id, unitId: l.unit_id, contractId: l.contract_id, costCenterId: l.cost_center_id, assetId: l.asset_id },
      })),
      srcType: (e.src_type ?? 'manual') + '_rev',
      srcId: e.src_id ?? e.id,
    });
    if (posted) db.run(`UPDATE journal_entries SET reversed_by = ? WHERE id = ?`, [posted.id, e.id]);
    return posted;
  });
}

/** حذف قيد آلي (بمصدره) حذفاً ناعماً · لإعادة الترحيل عند تعديل فاتورة ونحوه */
export function voidEntryById(db: DB, entryId: string): void {
  // القيد المرحّل لا يُخفى ولا يُحذف · إلغاؤه بقيد عكسي فقط، والمعكوس من قبل أثره صفر فلا يُمسّ ·
  // فما يدخل السلة هنا هو المسودة وحدها
  db.transaction(() => {
    db.run(`UPDATE journal_entries SET deleted_at = ? WHERE id = ? AND status != 'مرحّل'`,
      [new Date().toISOString(), entryId]);
  });
}

/**
 * عكس كل قيد مرحّل قائم أثره · لمسح كل البيانات: الدفتر لا يُمحى ولا يدخل السلة،
 * بل يُلغى كل قيد بمرآته فتصير الأرصدة صفراً ويبقى التاريخ كاملاً.
 * القيد المعكوس من قبل ومرآته يُتركان (أثرهما صفر)، والمرآة نفسها لا تُعكس.
 * تُرقَّم المرايا دفعة واحدة لا باستعلام لكل قيد · فآلاف القيود في ثوانٍ.
 */
export function reverseAllPostedEntries(db: DB, reason: string, date: string = today()): number {
  return db.transaction(() => {
    const targets = db.all<{ id: string; no: string; src_type: string | null; src_id: string | null }>(
      `SELECT e.id, e.no, e.src_type, e.src_id FROM journal_entries e
       WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL AND e.reversed_by IS NULL
         AND NOT EXISTS (SELECT 1 FROM journal_entries o WHERE o.reversed_by = e.id)
       ORDER BY e.created_at, e.id`
    );
    const now = new Date().toISOString();
    for (const t of targets) {
      const id = uid();
      db.run(
        `INSERT INTO journal_entries (id, no, date, memo, status, auto, src_type, src_id, created_at)
         VALUES (?,?,?,?,'قيد الإنشاء',1,?,?,?)`,
        [id, nextJournalNo(db), date, 'عكس قيد ' + t.no + ' · ' + reason,
         (t.src_type ?? 'manual') + '_rev', t.src_id ?? t.id, now]
      );
      // المرآة بأبعاد أصلها · وقاعدةٌ قبل الهجرة ٢٨ بلا أبعاد
      const dc = hasDimColumns(db) ? ', property_id, unit_id, contract_id, cost_center_id, asset_id' : '';
      db.run(
        `INSERT INTO journal_lines (id, entry_id, account_code, descr, debit_halalas, credit_halalas${dc})
         SELECT lower(hex(randomblob(10))), ?, account_code, descr, credit_halalas, debit_halalas${dc}
         FROM journal_lines WHERE entry_id = ?`,
        [id, t.id]
      );
      // الترقية تمرّ بمحفّز التوازن كأي قيد
      db.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = ?`, [id]);
      db.run(`UPDATE journal_entries SET reversed_by = ? WHERE id = ?`, [id, t.id]);
    }
    return targets.length;
  });
}

/* ═══════════ أحداث الترحيل الأحد عشر · الجدول الملزم ═══════════ */

const CASH = '1100';

/** حساب التأمينات المحتجزة لدى الغير (منصة إيجار) */
const HELD_BY_OTHERS = '1260';

/**
 * قيد قبض التأمين حسب الجهة القابضة:
 * المكتب: مدين النقدية · منصة إيجار: مدين محتجزات لدى الغير · طرف آخر: لا قيد (بيان فقط)
 */
export const postContractDeposit = (
  db: DB,
  c: { id: string; contract_no: string; tenant: string; start: string; deposit: number; holder?: string }
) => {
  if (c.deposit <= 0) return null;
  const holder = c.holder || 'المكتب';
  if (holder === 'طرف آخر') return null;
  const debitAccount = holder === 'منصة إيجار' ? HELD_BY_OTHERS : CASH;
  return postEntry(db, {
    date: c.start,
    memo: 'استلام تأمين · عقد ' + c.contract_no + ' · ' + c.tenant
      + (holder === 'منصة إيجار' ? ' (محتجز لدى منصة إيجار)' : ''),
    lines: [
      { account: debitAccount, descr: 'تأمين مستلم', debit: c.deposit, credit: 0 },
      { account: '2400', descr: 'التزام تأمين المستأجر', debit: 0, credit: c.deposit },
    ],
    srcType: 'contract_deposit',
    srcId: c.id,
  });
};

/**
 * الخصم من التأمين · ولدى «طرف آخر» (لم يدخل 2400): لا قيد عند الخصم، ويُسجَّل قبضاً إن وصل المال للمكتب
 * (قرار المالك على مراجعة التثبيت #26)
 */
export const postDepositDeduct = (db: DB, c: { id: string; contract_no: string; holder?: string; received?: boolean }, deduction: number, date: string) =>
  deduction > 0 && (c.holder || 'المكتب') === 'طرف آخر' // i18n-exempt: جهة مخزّنة
    ? (c.received
      ? postEntry(db, {
          date,
          memo: 'قبض المخصوم من تأمين لدى طرف آخر · عقد ' + c.contract_no, // i18n-exempt: نص قيد مخزَّن
          lines: [
            { account: CASH, descr: 'المخصوم من التأمين وصل للمكتب', debit: deduction, credit: 0 }, // i18n-exempt: نص قيد مخزَّن
            { account: '4300', descr: 'إيراد من خصم التأمين', debit: 0, credit: deduction }, // i18n-exempt: نص قيد مخزَّن
          ],
          srcType: 'deposit_deduct',
          srcId: c.id,
        })
      : null)
    : deduction > 0
    ? postEntry(db, {
        date,
        memo: 'خصم من التأمين · عقد ' + c.contract_no,
        lines: [
          { account: '2400', descr: 'إطفاء التزام التأمين', debit: deduction, credit: 0 },
          { account: '4300', descr: 'إيراد من خصم التأمين', debit: 0, credit: deduction },
        ],
        srcType: 'deposit_deduct',
        srcId: c.id,
      })
    : null;

/**
 * نقل المخصوم من محتجزات المنصة بعد التسوية: يُقفل 1260 بمقداره،
 * ويستقر في محفظة إيجار (1265) إن بقي هناك، أو في النقدية (1100) إن حُوّل لنا.
 */
export const postDepositDeductMove = (
  db: DB,
  c: { id: string; contract_no: string },
  deduction: number,
  date: string,
  destination: 'محفظة إيجار' | 'حسابنا'
) =>
  deduction > 0
    ? postEntry(db, {
        date,
        memo: 'استقرار المخصوم من التأمين · عقد ' + c.contract_no + ' · ' + (destination === 'محفظة إيجار' ? 'في محفظة إيجار' : 'حُوّل لحسابنا'),
        lines: [
          { account: destination === 'محفظة إيجار' ? '1265' : CASH, descr: 'المخصوم من التأمين', debit: deduction, credit: 0 },
          { account: HELD_BY_OTHERS, descr: 'إقفال محتجزات المنصة بالمخصوم', debit: 0, credit: deduction },
        ],
        srcType: 'deposit_deduct_move',
        srcId: c.id,
      })
    : null;

/** رد التأمين: من النقدية إن كان لدى المكتب، ومن المحتجزات إن كان لدى المنصة (المنصة ترده مباشرة) */
export const postDepositRefund = (
  db: DB,
  c: { id: string; contract_no: string; holder?: string },
  refund: number,
  date: string
) => {
  if (refund <= 0) return null;
  const holder = c.holder || 'المكتب';
  if (holder === 'طرف آخر') return null;
  const creditAccount = holder === 'منصة إيجار' ? HELD_BY_OTHERS : CASH;
  return postEntry(db, {
    date,
    memo: 'رد تأمين · عقد ' + c.contract_no + (holder === 'منصة إيجار' ? ' (رُدَّ عبر المنصة)' : ''),
    lines: [
      { account: '2400', descr: 'رد التزام التأمين', debit: refund, credit: 0 },
      { account: creditAccount, descr: 'مبلغ مردود', debit: 0, credit: refund },
    ],
    srcType: 'deposit_refund',
    srcId: c.id,
  });
};

/** ترحيل التأمين عند التجديد: 2400/2400 · لا يزيد الرصيد */
export const postDepositCarry = (
  db: DB,
  args: { fromNo: string; toNo: string; toId: string; deposit: number; date: string }
) =>
  args.deposit > 0
    ? postEntry(db, {
        date: args.date,
        memo: 'ترحيل تأمين من عقد ' + args.fromNo + ' إلى ' + args.toNo,
        lines: [
          { account: '2400', descr: 'إقفال التزام العقد السابق', debit: args.deposit, credit: 0 },
          { account: '2400', descr: 'التزام تأمين العقد الجديد', debit: 0, credit: args.deposit },
        ],
        srcType: 'deposit_carry',
        srcId: args.toId,
      })
    : null;

export const postReservationDeposit = (db: DB, rv: { id: string; name: string; deposit: number; date?: string }) =>
  rv.deposit > 0
    ? postEntry(db, {
        date: rv.date ?? today(),
        memo: 'عربون حجز · ' + rv.name,
        lines: [
          { account: CASH, descr: 'عربون مستلم', debit: rv.deposit, credit: 0 },
          { account: '2450', descr: 'التزام عربون', debit: 0, credit: rv.deposit },
        ],
        srcType: 'reservation',
        srcId: rv.id,
      })
    : null;

export const postReservationForfeit = (db: DB, rv: { id: string; name: string; deposit: number; date?: string }) =>
  rv.deposit > 0
    ? postEntry(db, {
        date: rv.date ?? today(),
        memo: 'مصادرة عربون · ' + rv.name,
        lines: [
          { account: '2450', descr: 'إطفاء التزام العربون', debit: rv.deposit, credit: 0 },
          { account: '4300', descr: 'إيراد من مصادرة عربون', debit: 0, credit: rv.deposit },
        ],
        srcType: 'reservation_forfeit',
        srcId: rv.id,
      })
    : null;

/**
 * تحويل العربون إلى عقد (المراجعة ٤.٤) · العربون إيجارٌ مقبوض مقدَّماً يُسدَّد به القسط: مدين 2450 / دائن إيراد الإيجار،
 * بتاريخ العقد · قيدٌ لكل قسط يغطيه ومعه دفعته. (كان دائنه 1200 والإيجار لا يمر على الذمم، فبقي رصيدها سالباً)
 */
export const postReservationConvert = (
  db: DB,
  rv: { id: string; amount: number; tenant: string; date: string; period?: string; contractId?: string },
  contractNo: string
) =>
  rv.amount > 0
    ? postEntry(db, {
        date: rv.date,
        memo: 'تحويل عربون إلى عقد ' + contractNo + ' · ' + rv.tenant + (rv.period ? ' · ' + rv.period : ''),
        lines: [
          { account: '2450', descr: 'إطفاء التزام العربون', debit: rv.amount, credit: 0 },
          ...rentRevenueLines(db, rv.contractId, rv.amount, 'إيراد إيجار من العربون', 'credit'),
        ],
        srcType: 'reservation_convert',
        srcId: rv.id,
      })
    : null;

/** ردّ العربون لصاحبه عند إلغاء الحجز (المراجعة ٤.٥): مدين 2450 / دائن النقد · كان الإلغاء بلا قيد */
export const postReservationRefund = (db: DB, rv: { id: string; name: string; deposit: number; date: string }) =>
  rv.deposit > 0
    ? postEntry(db, {
        date: rv.date,
        memo: 'ردّ عربون حجز · ' + rv.name,
        lines: [
          { account: '2450', descr: 'إطفاء التزام العربون', debit: rv.deposit, credit: 0 },
          { account: CASH, descr: 'عربون مردود', debit: 0, credit: rv.deposit },
        ],
        srcType: 'reservation_refund',
        srcId: rv.id,
      })
    : null;

export const postClaim = (db: DB, cl: { id: string; amount: number; reason: string; date?: string }) =>
  cl.amount > 0
    ? postEntry(db, {
        date: cl.date ?? today(),
        memo: 'مطالبة · ' + (cl.reason || ''),
        lines: [
          { account: '1250', descr: 'ذمة مطالبة على المستأجر', debit: cl.amount, credit: 0 },
          { account: '4300', descr: 'إيراد مطالبة', debit: 0, credit: cl.amount },
        ],
        srcType: 'claim',
        srcId: cl.id,
      })
    : null;

export const postClaimCollection = (db: DB, cl: { id: string; amount: number; reason: string }, date?: string) =>
  cl.amount > 0
    ? postEntry(db, {
        date: date ?? today(),
        memo: 'تحصيل مطالبة · ' + (cl.reason || ''),
        lines: [
          { account: CASH, descr: 'مبلغ محصَّل', debit: cl.amount, credit: 0 },
          { account: '1250', descr: 'إقفال ذمة المطالبة', debit: 0, credit: cl.amount },
        ],
        srcType: 'claim_collect',
        srcId: cl.id,
      })
    : null;

/**
 * قيد تحصيل الإيجار · النقد بالمقبوض فعلاً، وخصم «بعد الاستحقاق» في القيد نفسه:
 * مدين النقد بالمقبوض · مدين 4900 بالخصم · دائن الإيراد بالمقبوض مع الخصم (قيمة ما غطّته الدفعة من القسط).
 * و«تنزيل من القسط» لا سطر له: القسط نفسه خُفِّض والإيراد بالمقبوض وحده.
 */
export const postRentCollection = (
  db: DB,
  args: {
    contractId: string;
    contractNo: string;
    tenant: string;
    net: number;
    date: string;
    period?: string;
    discount?: number;
    discountKind?: DiscountKind | null;
    srcId: string;
  }
) => {
  const booked = args.discountKind === DISCOUNT_AFTER_DUE ? (args.discount || 0) : 0;
  const revenue = args.net + booked;
  return revenue > 0
    ? postEntry(db, {
        date: args.date,
        memo:
          'تحصيل إيجار · ' + args.tenant + ' (عقد ' + args.contractNo + ')' +
          (args.period ? ' · ' + args.period : '') +
          (args.discount && args.discountKind ? ' · ' + args.discountKind + ' ' + fmt(args.discount) : ''),
        lines: [
          { account: CASH, descr: 'إيجار محصَّل', debit: args.net, credit: 0 },
          { account: DISCOUNT_ACCOUNT, descr: 'خصم ممنوح بعد الاستحقاق', debit: booked, credit: 0 },
          ...rentRevenueLines(db, args.contractId, revenue, 'إيراد إيجار', 'credit'),
        ],
        srcType: 'rent',
        srcId: args.srcId,
      })
    : null;
};

/**
 * خصم «بعد الاستحقاق» لدفعة سُجّلت قبل أن يكون للخصم سطر · قيد جديد مربوط بالدفعة لا تعديل لقيدها المرحّل:
 * مدين 4900 بالخصم · دائن الإيراد به (فيبلغ إيراد الدفعة قيمة ما غطّته من القسط).
 */
export const postBookedDiscount = (
  db: DB,
  d: { paymentId: string; tenant: string; contractNo: string; amount: number; date: string; paymentDate: string }
) =>
  postEntry(db, {
    date: d.date,
    memo: 'خصم ممنوح بعد الاستحقاق · ' + d.tenant + ' (عقد ' + d.contractNo + ') · دفعة ' + d.paymentDate,
    lines: [
      { account: DISCOUNT_ACCOUNT, descr: 'خصم ممنوح بعد الاستحقاق', debit: d.amount, credit: 0 },
      ...rentRevenueLines(db, db.get<{ c: string }>(`SELECT contract_id AS c FROM contract_payments WHERE id = ?`, [d.paymentId])?.c, d.amount, 'إيراد إيجار يقابل الخصم', 'credit'),
    ],
    srcType: DISCOUNT_ENTRY_SRC,
    srcId: d.paymentId,
  });

export const postKeyMoneyCommission = (
  db: DB,
  k: { id: string; unitLabel: string; outgoing: string; incoming: string; commission: number; date?: string }
) =>
  k.commission > 0
    ? postEntry(db, {
        date: k.date ?? today(),
        memo: 'عمولة تقبيل · وحدة ' + k.unitLabel + ' (' + k.outgoing + ' ← ' + k.incoming + ')',
        lines: [
          { account: CASH, descr: 'عمولة مستلمة', debit: k.commission, credit: 0 },
          { account: '4300', descr: 'إيراد عمولة تقبيل', debit: 0, credit: k.commission },
        ],
        srcType: 'key_money',
        srcId: k.id,
      })
    : null;

/* ─── قيود الفواتير والمشتريات (كما في النموذج حرفياً) ─── */

export const PURCHASE_CATEGORY_ACCOUNT: Record<string, string> = {
  'رواتب': '5200',
  'رواتب وأجور': '5200',
  'تكلفة مبيعات': '5100',
  'مواد خام': '5100',
  'بضاعة': '5100',
  'مصروفات أخرى': '5400',
  'مصروفات تأسيس': '5500',
};

export function purchaseExpenseAccount(category: string | null | undefined): string {
  return PURCHASE_CATEGORY_ACCOUNT[(category || '').trim()] || '5300';
}

/** فاتورة مبيعات: مدين 1200 بالإجمالي / دائن 4100 بالصافي + دائن 2200 بالضريبة */
export const postInvoiceToLedger = (
  db: DB,
  v: { id: string; no: string; customer: string; issue: string; subtotal: number; tax: number; total: number }
) =>
  postEntry(db, {
    date: v.issue,
    memo: 'فاتورة مبيعات ' + v.no + ' · ' + v.customer,
    lines: [
      { account: '1200', debit: v.total, credit: 0 },
      ...(v.subtotal ? [{ account: '4100', debit: 0, credit: v.subtotal }] : []),
      ...(v.tax ? [{ account: '2200', debit: 0, credit: v.tax }] : []),
    ],
    srcType: 'invoice',
    srcId: v.id,
  });

/**
 * إشعار دائن على فاتورة مبيعات (قرار المالك على #30): عكس جزءٍ منها أو كلها بتاريخه · مدين 4100 بالصافي ومدين 2200
 * بالضريبة / دائن 1200 بالإجمالي. مصدره صفّ الإشعار نفسه في الفواتير، فأبعاده من عقار الفاتورة ووحدتها.
 */
export const postCreditNoteToLedger = (
  db: DB,
  v: { id: string; no: string; refNo: string; customer: string; date: string; subtotal: number; tax: number; total: number }
) =>
  postEntry(db, {
    date: v.date,
    memo: 'إشعار دائن ' + v.no + ' على الفاتورة ' + v.refNo + ' · ' + v.customer, // i18n-exempt: بيان القيد المخزَّن
    lines: [
      ...(v.subtotal ? [{ account: '4100', debit: v.subtotal, credit: 0 }] : []),
      ...(v.tax ? [{ account: '2200', debit: v.tax, credit: 0 }] : []),
      { account: '1200', debit: 0, credit: v.total },
    ],
    srcType: 'invoice',
    srcId: v.id,
  });

/**
 * فاتورة شراء: دائن 2100 بالإجمالي، ومدينها:
 *  - الفاتورة القابلة للخصم (deductible): مصروف الفئة بالأساس، وضريبتها في 1270 «ضريبة مدخلات قابلة للاسترداد».
 *  - غيرها (غير قابلة للخصم، معفاة، صفرية): مصروف الفئة بالأساس والضريبة معاً، بالتكلفة الكاملة.
 *  - فرق التقريب الذي قبله المستخدم في 5900، مديناً أو دائناً بإشارته.
 * ولا سطر على 2200 (ضريبة المخرجات) في الشراء.
 */
export const postPurchaseToLedger = (
  db: DB,
  p: { id: string; no: string; supplier: string; date: string; category: string; subtotal: number; tax: number; total: number; roundingDiff?: number; deductible?: boolean },
  /** بنود الفاتورة التي صارت أصولاً (الهجرة ٢٩): مدين حسابات الفئات بأبعاد كل أصل، فيقلّ المصروف بقدرها */
  assetLines: EntryLine[] = [],
) => {
  const diff = p.roundingDiff ?? 0;
  const assetSum = assetLines.reduce((s, l) => s + (l.debit || 0), 0);
  // «خاضعة باسمنا» وحدها تفصل ضريبتها أصلاً قابلاً للاسترداد (1270) · الباقي بالتكلفة الكاملة
  const dedTax = p.deductible ? p.tax : 0;
  return postEntry(db, {
    date: p.date,
    memo: 'فاتورة شراء ' + p.no + ' · ' + p.supplier,
    lines: [
      { account: purchaseExpenseAccount(p.category), debit: p.subtotal + p.tax - dedTax - assetSum, credit: 0 },
      ...assetLines,
      ...(dedTax ? [{ account: '1270', descr: 'ضريبة مدخلات قابلة للاسترداد', debit: dedTax, credit: 0 }] : []),
      ...(diff > 0 ? [{ account: '5900', descr: 'فرق تقريب مقبول', debit: diff, credit: 0 }] : []),
      { account: '2100', debit: 0, credit: p.total },
      ...(diff < 0 ? [{ account: '5900', descr: 'فرق تقريب مقبول', debit: 0, credit: -diff }] : []),
    ],
    srcType: 'purchase',
    srcId: p.id,
  });
};

/** تحصيل فاتورة مبيعات (المراجعة ٤.٢): مدين 1100 / دائن 1200 بالإجمالي */
export const postInvoicePayment = (
  db: DB,
  v: { id: string; no: string; customer: string; total: number },
  payDate: string,
  cash: boolean
) =>
  postEntry(db, {
    date: payDate,
    memo: 'تحصيل فاتورة ' + v.no + ' · ' + v.customer + (cash ? ' (نقداً)' : ''),
    lines: [
      { account: CASH, debit: v.total, credit: 0 },
      { account: '1200', debit: 0, credit: v.total },
    ],
    srcType: 'invoice_pay',
    srcId: v.id,
  });

/** سداد فاتورة شراء: مدين 2100 / دائن 1100 */
export const postPurchasePayment = (
  db: DB,
  p: { id: string; no: string; supplier: string; total: number },
  payDate: string,
  cash: boolean
) =>
  postEntry(db, {
    date: payDate,
    memo: 'سداد فاتورة ' + p.no + ' · ' + p.supplier + (cash ? ' (نقداً)' : ''),
    lines: [
      { account: '2100', debit: p.total, credit: 0 },
      { account: CASH, debit: 0, credit: p.total },
    ],
    srcType: 'purchase_pay',
    srcId: p.id,
  });
