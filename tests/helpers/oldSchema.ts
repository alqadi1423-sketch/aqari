/**
 * قاعدة ببنية إصدار قديم وبياناتٍ اصطناعية · لاختبارات الترقية ونسخة ما قبلها.
 * الصف نفسه يُكتب في كل إصدار بالأعمدة التي يعرفها ذلك الإصدار.
 */
import { openNodeDb } from '@/db/nodeAdapter';
import { MIGRATIONS } from '@/db/schema';
import { SEED_ACCOUNTS } from '@/db/seed';
import type { DB, SqlValue } from '@/db/adapter';

const T = '2026-01-01T00:00:00.000Z';

/** إدراج بأعمدة الإصدار القائم وحدها · فالصف نفسه يُكتب في كل إصدار بما يعرفه */
export function ins(db: DB, table: string, row: Record<string, SqlValue>): void {
  const cols = new Set(db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((c) => c.name));
  const keys = Object.keys(row).filter((k) => cols.has(k));
  db.run(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    keys.map((k) => row[k]));
}

/** قيد مرحّل يُنشأ مسودةً ثم يُرحَّل · الطريق الذي يقبله كل إصدار */
export function entry(db: DB, id: string, no: string, srcType: string | null, srcId: string | null,
  lines: [string, number, number][]): void {
  ins(db, 'journal_entries', { id, no, date: '2026-01-05', memo: 'اختبار', status: 'قيد الإنشاء', auto: 1, src_type: srcType, src_id: srcId, created_at: T });
  lines.forEach(([acc, d, c], i) => ins(db, 'journal_lines', { id: `${id}-L${i}`, entry_id: id, account_code: acc, descr: '', debit_halalas: d, credit_halalas: c }));
  db.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = ?`, [id]);
}

/** القاعدة ببنية الإصدار v · كما تركها تطبيق ذلك الإصدار */
export function schemaAt(file: string, v: number): DB {
  const db = openNodeDb(file);
  db.exec('PRAGMA foreign_keys = OFF');
  for (let i = 0; i < v; i++) db.exec(MIGRATIONS[i]);
  db.exec(`PRAGMA user_version = ${v}`);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** بيانات اصطناعية بقيود متوازنة ودفعات على أقساط · منها خصم قديم بلا نوع */
export function fill(db: DB): void {
  for (const a of SEED_ACCOUNTS) {
    if (!db.get(`SELECT 1 FROM accounts WHERE code = ?`, [a.code])) {
      ins(db, 'accounts', { code: a.code, name: a.name, type: a.type, grp: a.grp, opening_halalas: 0, is_system: 1, created_at: T });
    }
  }
  ins(db, 'properties', { id: 'P1', name: 'عقار المصفوفة', ownership: 'ملك', created_at: T });
  ins(db, 'units', { id: 'U1', property_id: 'P1', unit_no: '10', rent_monthly_halalas: 300000, created_at: T });
  ins(db, 'units', { id: 'U2', property_id: 'P1', unit_no: '2', rent_monthly_halalas: 250000, created_at: T });
  ins(db, 'tenants', { id: 'T1', name: 'مستأجر المصفوفة', phone: '0500000001', created_at: T });
  ins(db, 'contracts', {
    id: 'C1', contract_no: 'M-1', tenant_name: 'مستأجر المصفوفة', phone: '0500000001', id_number: '1000000009',
    unit_id: 'U1', value_halalas: 3600000, cycle: 'شهرية', start: '2026-01-01', end: '2026-12-31',
    deposit_halalas: 200000, furnished: 'مفروشة جزئياً', status: 'سارٍ', created_at: T,
  });
  ins(db, 'contract_installments', { id: 'I1', contract_id: 'C1', due_date: '2026-01-01', amount_halalas: 300000, paid_halalas: 300000, status: 'مدفوعة', sort: 1 });
  ins(db, 'contract_installments', { id: 'I2', contract_id: 'C1', due_date: '2026-02-01', amount_halalas: 300000, paid_halalas: 100000, status: 'مدفوعة جزئياً', sort: 2 });
  ins(db, 'contract_installments', { id: 'I3', contract_id: 'C1', due_date: '2026-03-01', amount_halalas: 300000, paid_halalas: 0, status: 'مستحقة', sort: 3 });
  ins(db, 'banks', { id: 'B1', name: 'بنك المصفوفة', opening_halalas: 50000, opening_date: '2026-01-01', created_at: T });

  // التأمين المقبوض · ثم دفعة كاملة · ثم دفعة جزئية بخصم قديم لا سطر له في الدفتر
  entry(db, 'JE0', 'JE-0001', 'deposit', 'C1', [['1100', 200000, 0], ['2400', 0, 200000]]);
  entry(db, 'JE1', 'JE-0002', 'rent', 'PAY1', [['1100', 300000, 0], ['4200', 0, 300000]]);
  entry(db, 'JE2', 'JE-0003', 'rent', 'PAY2', [['1100', 100000, 0], ['4200', 0, 100000]]);
  ins(db, 'contract_payments', { id: 'PAY1', contract_id: 'C1', installment_id: 'I1', period: 'يناير', date: '2026-01-05', gross_halalas: 300000, discount_halalas: 0, net_halalas: 300000, method_label: 'نقداً', journal_entry_id: 'JE1', created_at: T });
  ins(db, 'payment_lines', { id: 'PL1', payment_id: 'PAY1', method: 'cash', amount_halalas: 300000 });
  ins(db, 'contract_payments', { id: 'PAY2', contract_id: 'C1', installment_id: 'I2', period: 'فبراير', date: '2026-02-05', gross_halalas: 120000, discount_halalas: 20000, net_halalas: 100000, method_label: 'نقداً', journal_entry_id: 'JE2', created_at: T });
  ins(db, 'payment_lines', { id: 'PL2', payment_id: 'PAY2', method: 'cash', amount_halalas: 100000 });
  ins(db, 'contract_occupants', { id: 'OC1', contract_id: 'C1', name: 'ساكن المصفوفة', id_number: '1000000017', sort: 0 });
  ins(db, 'purchases', { id: 'PU1', no: 'PO-1', supplier_name: 'مورد', date: '2026-01-10', exempt: 1, subtotal_halalas: 1000, tax_halalas: 0, total_halalas: 1000, created_at: T });
}

/** ما يجب أن يبقى كما هو بعد أي ترقية */
export function snapshot(db: DB) {
  return {
    lines: db.all(`SELECT id, entry_id, account_code, debit_halalas, credit_halalas FROM journal_lines ORDER BY id`),
    entries: db.all(`SELECT id, no, status, src_type, src_id FROM journal_entries ORDER BY id`),
    inst: db.all(`SELECT id, amount_halalas, paid_halalas FROM contract_installments ORDER BY id`),
    pays: db.all(`SELECT id, installment_id, gross_halalas, discount_halalas, net_halalas, journal_entry_id FROM contract_payments ORDER BY id`),
    contracts: db.all(`SELECT id, tenant_name, value_halalas, deposit_halalas, status FROM contracts ORDER BY id`),
  };
}
