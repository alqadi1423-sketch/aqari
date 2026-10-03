/**
 * الفحص الدلالي لما يرد من خارج الجهاز · دالة واحدة تخدم الاستعادة (القاعدة كلها)
 * والمزامنة (الصف الوارد وما يمسّه). integrity_check يثبت أن الملف سليم البنية لا أن
 * الدفتر سليم المعنى، والقواعد السحابية لا تجمع القوائم ولا تقرأ مستندات أخرى، فهنا
 * قواعد القاعدة نفسها تُطبَّق على ما كُتب قبل وجودها أو خارجها:
 *  ١) لا قيد مرحّل غير متوازن ولا قيد مرحّل بلا سطور.
 *  ٢) لا قسط مسدَّده مع مجموع خصومه يتجاوز مبلغه، ولا مسدَّد سالب.
 *  ٣) لا دفعة على قسط بصافٍ أو خصم سالب، ولا دفعة تتجاوز وحدها مبلغ قسطها.
 *  ٤) كل مبلغ بالهللات عدد صحيح (لا كسر ولا نص) في كل عمود مالي.
 * كل بند جملة عربية تسمّي موضعه · وأي بند يرفض ما ورد كاملاً.
 */
import type { DB, SqlValue } from '../../db/adapter';
import { fmt } from '../money';

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

  /* ٢) سقف القسط · الخصوم مجمَّعة مرة واحدة لا استعلاماً لكل قسط، ومحصورة في النطاق
     فلا يُجمع دفتر الدفعات كله لكل صف وارد */
  const ids = scope ? scope.installmentIds ?? [] : undefined;
  const inst = within('i.id', ids);
  const dIn = within('installment_id', ids);
  const over = db.all<{ tenant: string | null; contract_no: string | null; due: string; amount: number; paid: number; disc: number }>(
    `WITH d AS (
       SELECT installment_id, SUM(discount_halalas) AS s FROM contract_payments
       WHERE installment_id IS NOT NULL AND ${dIn.sql} GROUP BY installment_id
     )
     SELECT c.tenant_name AS tenant, c.contract_no, i.due_date AS due,
            i.amount_halalas AS amount, i.paid_halalas AS paid, COALESCE(d.s, 0) AS disc
     FROM contract_installments i
     LEFT JOIN d ON d.installment_id = i.id
     LEFT JOIN contracts c ON c.id = i.contract_id
     WHERE (i.paid_halalas < 0 OR i.paid_halalas + COALESCE(d.s, 0) > i.amount_halalas) AND ${inst.sql}
     ORDER BY i.due_date`, [...dIn.params, ...inst.params]
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
     WHERE p.installment_id IS NOT NULL AND (p.net_halalas < 0 OR p.discount_halalas < 0) AND ${pay.sql}
     ORDER BY p.date`, pay.params
  );
  if (negative.length) {
    out.push('دفعة على قسط بصافٍ أو خصم سالب: ' + listOf(
      negative.slice(0, SHOW).map((r) => `${r.tenant || 'بلا مستأجر'} · ${r.date}`), negative.length));
  }

  /* ٣ب) دفعة تتجاوز وحدها مبلغ قسطها · وهو أول ما يفحصه محفّز إدراج الدفعة، فلا تمرّ الاستعادة
     بما ترفضه المزامنة */
  const big = db.all<{ tenant: string | null; date: string; total: number; amount: number }>(
    `SELECT c.tenant_name AS tenant, p.date, p.net_halalas + p.discount_halalas AS total, i.amount_halalas AS amount
     FROM contract_payments p
     JOIN contract_installments i ON i.id = p.installment_id
     LEFT JOIN contracts c ON c.id = p.contract_id
     WHERE p.net_halalas + p.discount_halalas > i.amount_halalas AND ${pay.sql}
     ORDER BY p.date`, pay.params
  );
  if (big.length) {
    out.push('دفعة تتجاوز وحدها مبلغ قسطها: ' + listOf(
      big.slice(0, SHOW).map((r) => `${r.tenant || 'بلا مستأجر'} · ${r.date} (${fmt(Number(r.total))} من ${fmt(Number(r.amount))})`),
      big.length));
  }

  return out;
}
