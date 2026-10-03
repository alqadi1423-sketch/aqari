/**
 * الفحص الدلالي لما يرد من خارج الجهاز · دالة واحدة تخدم الاستعادة (القاعدة كلها)
 * والمزامنة (الصف الوارد وما يمسّه). integrity_check يثبت أن الملف سليم البنية لا أن
 * الدفتر سليم المعنى، والقواعد السحابية لا تجمع القوائم ولا تقرأ مستندات أخرى، فهنا
 * قواعد القاعدة نفسها تُطبَّق على ما كُتب قبل وجودها أو خارجها:
 *  ١) لا قيد مرحّل غير متوازن ولا قيد مرحّل بلا سطور.
 *  ٢) لا قسط مسدَّده مع خصمه في الدفتر يتجاوز مبلغه، ولا مسدَّد سالب.
 *  ٣) لا دفعة على قسط بصافٍ أو خصم سالب، ولا دفعة بنوع خصم تتجاوز وحدها مبلغ قسطها
 *     (ودفعات ما قبل نوع الخصم تُحكم على مستوى القسط بخصم الدفتر).
 *  ٥) نوع الخصم معروف ولا يكون بلا خصم · وخصم «بعد الاستحقاق» له في الدفتر سطر 4900 بقيمته.
 *  ٤) كل مبلغ بالهللات عدد صحيح (لا كسر ولا نص) في كل عمود مالي.
 * والدفعة الملغاة (الهجرة ٢١) خارج فحوص الدفعات: قيدها وخصمها معكوسان ومسدَّدها خارج القسط.
 * كل بند جملة عربية تسمّي موضعه · وأي بند يرفض ما ورد كاملاً.
 */
import type { DB, SqlValue } from '../../db/adapter';
import { fmt } from '../money';
import { INSTALLMENT_DISCOUNT_SQL, DISCOUNT_AFTER_DUE, DISCOUNT_KINDS } from '../contracts/installments';

const SHOW = 5;

/** نطاق الفحص · غيابه يعني القاعدة كلها (الاستعادة) */
export interface SemanticScope {
  /** قيود يُفحص توازنها وسطورها */
  entryIds?: string[];
  /** أقساط يُفحص سقفها */
  installmentIds?: string[];
  /** دفعات يُفحص صافيها وخصمها */
  paymentIds?: string[];
  /** صفوف تُفحص أعمدتها المالية · الشرط يحدّد الصف بمفتاحه */
  rows?: { table: string; where: string; params: SqlValue[] }[];
}

const TABLE_AR: Record<string, string> = {
  accounts: 'الحسابات', bank_tx: 'حركات البنك', banks: 'البنوك', claims: 'المطالبات',
  contract_installments: 'أقساط العقود', contract_payments: 'دفعات العقود', contracts: 'العقود',
  deposit_settlements: 'تسويات التأمين', invoice_lines: 'بنود الفواتير', invoices: 'الفواتير',
  journal_lines: 'سطور القيود', key_money_deals: 'صفقات التقبيل', meter_readings: 'قراءات العدادات',
  payment_allocations: 'توزيع الدفعات', payment_lines: 'سطور الدفعات', properties: 'العقارات',
  purchases: 'المشتريات', reservations: 'الحجوزات', suppliers: 'الموردون', tenants: 'المستأجرون',
  units: 'الوحدات',
};
const COLUMN_AR: Record<string, string> = {
  opening_halalas: 'الرصيد الافتتاحي', amount_halalas: 'المبلغ', paid_halalas: 'المسدَّد',
  gross_halalas: 'المبلغ قبل الخصم', discount_halalas: 'الخصم', net_halalas: 'الصافي',
  value_halalas: 'قيمة العقد', deposit_halalas: 'التأمين', cancel_deduction_halalas: 'المخصوم عند الإلغاء',
  cancel_refund_halalas: 'المردود عند الإلغاء', deduction_halalas: 'المخصوم', refund_halalas: 'المردود',
  price_halalas: 'السعر', subtotal_halalas: 'قبل الضريبة', tax_halalas: 'الضريبة', total_halalas: 'الإجمالي',
  debit_halalas: 'مدين', credit_halalas: 'دائن', commission_halalas: 'العمولة',
  lease_value_halalas: 'قيمة الاستئجار', default_amount_halalas: 'المبلغ الافتراضي',
  rent_monthly_halalas: 'الإيجار الشهري',
};
export const tableLabel = (t: string) => TABLE_AR[t] ?? 'جدول مالي';
export const columnLabel = (c: string) => COLUMN_AR[c] ?? 'عمود مالي';

function listOf(items: string[], total: number): string {
  return items.join('، ') + (total > items.length ? ` و${total - items.length} غيرها` : '');
}

/** شرط «ضمن النطاق» لعمود · بلا نطاق: الكل */
function within(col: string, ids: string[] | undefined): { sql: string; params: SqlValue[] } {
  if (!ids) return { sql: '1', params: [] };
  if (!ids.length) return { sql: '0', params: [] };
  return { sql: `${col} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

/** الأعمدة المالية في القاعدة: كل عمود ينتهي بـ _halalas */
export function moneyColumns(db: DB): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const tables = db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  for (const { name } of tables) {
    const cols = db.all<{ name: string }>(`PRAGMA table_info("${name}")`)
      .map((c) => c.name).filter((c) => c.endsWith('_halalas'));
    if (cols.length) out.set(name, cols);
  }
  return out;
}

/** عدد الخانات غير الصحيحة في كل عمود مالي · NULL مقبول هنا والقيود NOT NULL تتولاه */
function nonIntegers(db: DB, table: string, cols: string[], where: string, params: SqlValue[]): { col: string; n: number }[] {
  const sel = cols.map((c, i) => `COALESCE(SUM(typeof("${c}") NOT IN ('integer', 'null')), 0) AS c${i}`).join(', ');
  const r = db.get<Record<string, number>>(`SELECT ${sel} FROM "${table}" WHERE ${where}`, params);
  return cols.map((col, i) => ({ col, n: Number(r?.['c' + i] ?? 0) })).filter((x) => x.n > 0);
}

export function semanticIssues(db: DB, scope?: SemanticScope, money = moneyColumns(db)): string[] {
  const out: string[] = [];

  /* ٤) الأعداد الصحيحة أولاً · فالجمع بعدها على أعداد لا على كسور */
  const bad: string[] = [];
  if (!scope) {
    for (const [table, cols] of money) {
      for (const x of nonIntegers(db, table, cols, '1', [])) bad.push(`${tableLabel(table)} · ${columnLabel(x.col)} (${x.n} سجل)`);
    }
  } else {
    for (const r of scope.rows ?? []) {
      const cols = money.get(r.table);
      if (!cols) continue;
      for (const x of nonIntegers(db, r.table, cols, r.where, r.params)) bad.push(`${tableLabel(r.table)} · ${columnLabel(x.col)}`);
    }
    if (scope.entryIds?.length) {
      const w = within('entry_id', scope.entryIds);
      for (const x of nonIntegers(db, 'journal_lines', money.get('journal_lines') ?? [], w.sql, w.params)) {
        bad.push(`${tableLabel('journal_lines')} · ${columnLabel(x.col)} (${x.n} سطر)`);
      }
    }
  }
  if (bad.length) out.push('مبلغ بالهللات ليس عدداً صحيحاً: ' + listOf(bad.slice(0, SHOW), bad.length));

  /* ١) القيود المرحّلة */
  const e = within('e.id', scope ? scope.entryIds ?? [] : undefined);
  const unbalanced = db.all<{ no: string; diff: number }>(
    `SELECT e.no, SUM(l.debit_halalas - l.credit_halalas) AS diff
     FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.status = 'مرحّل' AND ${e.sql}
     GROUP BY e.id HAVING diff != 0 ORDER BY e.no`, e.params
  );
  if (unbalanced.length) {
    out.push('قيد مرحّل غير متوازن: ' + listOf(
      unbalanced.slice(0, SHOW).map((r) => `${r.no} (الفرق ${fmt(Math.abs(Number(r.diff)))})`),
      unbalanced.length));
  }

  const lineless = db.all<{ no: string }>(
    `SELECT e.no FROM journal_entries e
     WHERE e.status = 'مرحّل' AND ${e.sql}
       AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id)
     ORDER BY e.no`, e.params
  );
  if (lineless.length) {
    out.push('قيد مرحّل بلا سطور: ' + listOf(lineless.slice(0, SHOW).map((r) => r.no), lineless.length));
  }

  /* ٢) سقف القسط بخصم الدفتر · النص نفسه الذي تقرأ به الشاشات ومحفّزات السقف، ومحصور في النطاق */
  const ids = scope ? scope.installmentIds ?? [] : undefined;
  const inst = within('i.id', ids);
  const over = db.all<{ tenant: string | null; contract_no: string | null; due: string; amount: number; paid: number; disc: number }>(
    `SELECT tenant, contract_no, due, amount, paid, disc FROM (
       SELECT c.tenant_name AS tenant, c.contract_no, i.due_date AS due,
              i.amount_halalas AS amount, i.paid_halalas AS paid, ${INSTALLMENT_DISCOUNT_SQL} AS disc
       FROM contract_installments i
       LEFT JOIN contracts c ON c.id = i.contract_id
       WHERE ${inst.sql}
     ) WHERE paid < 0 OR paid + disc > amount
     ORDER BY due`, inst.params
  );
  if (over.length) {
    out.push('قسط يتجاوز المسدَّدُ مع الخصم مبلغَه أو مسدَّده سالب: ' + listOf(
      over.slice(0, SHOW).map((r) =>
        `${r.tenant || 'بلا مستأجر'} · ${r.contract_no || 'بلا رقم عقد'} · ${r.due} (${fmt(Number(r.paid) + Number(r.disc))} من ${fmt(Number(r.amount))})`),
      over.length));
  }

  /* ٣) دفعات سالبة */
  const pay = within('p.id', scope ? scope.paymentIds ?? [] : undefined);
  const negative = db.all<{ tenant: string | null; date: string }>(
    `SELECT c.tenant_name AS tenant, p.date FROM contract_payments p
     LEFT JOIN contracts c ON c.id = p.contract_id
     WHERE p.installment_id IS NOT NULL AND p.cancelled_at IS NULL AND (p.net_halalas < 0 OR p.discount_halalas < 0) AND ${pay.sql}
     ORDER BY p.date`, pay.params
  );
  if (negative.length) {
    out.push('دفعة على قسط بصافٍ أو خصم سالب: ' + listOf(
      negative.slice(0, SHOW).map((r) => `${r.tenant || 'بلا مستأجر'} · ${r.date}`), negative.length));
  }

  /* ٣ب) دفعة بنوع خصم تتجاوز وحدها مبلغ قسطها · وهو أول ما يفحصه محفّز إدراج الدفعة، فلا تمرّ
     الاستعادة بما ترفضه المزامنة · و«تنزيل من القسط» نزل من المبلغ فلا يُضاف خصمه ثانية */
  const big = db.all<{ tenant: string | null; date: string; total: number; amount: number }>(
    `SELECT c.tenant_name AS tenant, p.date,
            p.net_halalas + (CASE WHEN p.discount_kind = '${DISCOUNT_AFTER_DUE}' THEN p.discount_halalas ELSE 0 END) AS total,
            i.amount_halalas AS amount
     FROM contract_payments p
     JOIN contract_installments i ON i.id = p.installment_id
     LEFT JOIN contracts c ON c.id = p.contract_id
     WHERE p.discount_kind IS NOT NULL AND p.cancelled_at IS NULL
       AND p.net_halalas + (CASE WHEN p.discount_kind = '${DISCOUNT_AFTER_DUE}' THEN p.discount_halalas ELSE 0 END) > i.amount_halalas
       AND ${pay.sql}
     ORDER BY p.date`, pay.params
  );
  if (big.length) {
    out.push('دفعة تتجاوز وحدها مبلغ قسطها: ' + listOf(
      big.slice(0, SHOW).map((r) => `${r.tenant || 'بلا مستأجر'} · ${r.date} (${fmt(Number(r.total))} من ${fmt(Number(r.amount))})`),
      big.length));
  }

  /* ٥) نوع الخصم · معروف ولا يكون بلا خصم، وخصم «بعد الاستحقاق» له سطر 4900 بقيمته في الدفتر:
     في قيد الدفعة نفسه أو في قيد خصم مربوط بها · كما يشترط الحارس عند الحفظ */
  const kinds = DISCOUNT_KINDS.map(() => '?').join(',');
  const badKind = db.all<{ tenant: string | null; date: string }>(
    `SELECT c.tenant_name AS tenant, p.date FROM contract_payments p
     LEFT JOIN contracts c ON c.id = p.contract_id
     WHERE p.discount_kind IS NOT NULL AND p.cancelled_at IS NULL AND (p.discount_kind NOT IN (${kinds}) OR p.discount_halalas <= 0) AND ${pay.sql}
     ORDER BY p.date`, [...DISCOUNT_KINDS, ...pay.params]
  );
  if (badKind.length) {
    out.push('دفعة بنوع خصم غير معروف أو بلا خصم: ' + listOf(
      badKind.slice(0, SHOW).map((r) => `${r.tenant || 'بلا مستأجر'} · ${r.date}`), badKind.length));
  }
  const unbooked = db.all<{ tenant: string | null; date: string; disc: number; booked: number }>(
    `SELECT tenant, date, disc, booked FROM (
       SELECT c.tenant_name AS tenant, p.date, p.discount_halalas AS disc,
              COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                        FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                        WHERE (e.id = p.journal_entry_id OR (e.src_type = 'discount' AND e.src_id = p.id))
                          AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0) AS booked
       FROM contract_payments p
       LEFT JOIN contracts c ON c.id = p.contract_id
       WHERE p.discount_kind = '${DISCOUNT_AFTER_DUE}' AND p.cancelled_at IS NULL AND ${pay.sql}
     ) WHERE booked != disc
     ORDER BY date`, pay.params
  );
  if (unbooked.length) {
    out.push('خصم بعد الاستحقاق بلا سطر خصم مساوٍ له في الدفتر: ' + listOf(
      unbooked.slice(0, SHOW).map((r) => `${r.tenant || 'بلا مستأجر'} · ${r.date} (${fmt(Number(r.booked))} من ${fmt(Number(r.disc))})`),
      unbooked.length));
  }

  return out;
}
