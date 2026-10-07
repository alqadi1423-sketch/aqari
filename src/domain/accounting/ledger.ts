import type { DB } from '../../db/adapter';

/** الحسابات ذات الطبيعة المدينة · كما في النموذج */
export const DEBIT_NORMAL_TYPES = new Set(['أصل', 'مصروف']);

export interface AccountRow {
  code: string;
  name: string;
  type: string;
  grp: string | null;
  opening_halalas: number;
  is_system: number;
}

export function getAccount(db: DB, code: string): AccountRow | undefined {
  return db.get<AccountRow>(
    `SELECT code, name, type, grp, opening_halalas, is_system FROM accounts
     WHERE code = ? AND deleted_at IS NULL`,
    [code]
  );
}

export function allAccounts(db: DB): AccountRow[] {
  return db.all<AccountRow>(
    `SELECT code, name, type, grp, opening_halalas, is_system FROM accounts
     WHERE deleted_at IS NULL ORDER BY code`
  );
}

/** صافي حركة الدفتر (مدين - دائن) على حساب · للقيود المرحّلة الحية فقط */
export function ledgerNet(db: DB, code: string): number {
  const row = db.get<{ net: number }>(
    `SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas),0) AS net
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_code = ? AND e.status = 'مرحّل' AND e.deleted_at IS NULL`,
    [code]
  );
  return row ? Number(row.net) : 0;
}

/**
 * الرصيد المشتق · لا عمود balance في القاعدة إطلاقاً.
 * لحسابات الطبيعة المدينة: (مدين-دائن) + الافتتاحي، ولغيرها: (دائن-مدين) + الافتتاحي.
 */
export function accountBalance(db: DB, code: string): number {
  const acc = getAccount(db, code);
  if (!acc) return 0;
  const net = ledgerNet(db, code);
  const oriented = DEBIT_NORMAL_TYPES.has(acc.type) ? net : -net;
  return oriented + Number(acc.opening_halalas || 0);
}

/**
 * أرصدة كل الحسابات دفعة واحدة · استعلام تجميعي واحد بدل استعلام لكل حساب.
 * نفس معادلة accountBalance حرفياً.
 */
export function allAccountBalances(db: DB): Map<string, number> {
  const nets = new Map(
    db.all<{ code: string; net: number }>(
      `SELECT l.account_code AS code, COALESCE(SUM(l.debit_halalas - l.credit_halalas),0) AS net
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL GROUP BY l.account_code`
    ).map((r) => [r.code, Number(r.net)])
  );
  const out = new Map<string, number>();
  for (const a of allAccounts(db)) {
    const net = nets.get(a.code) ?? 0;
    const oriented = DEBIT_NORMAL_TYPES.has(a.type) ? net : -net;
    out.set(a.code, oriented + Number(a.opening_halalas || 0));
  }
  return out;
}

/**
 * تصفية الدفتر بأبعاده (قرار المالك ٢٠٢٦-١٠-٠٤: التقارير والقوائم المالية تقبل الفلترة بكل بُعد) ·
 * كل بُعدٍ مُعطى شرطٌ على سطر القيد · وبلا تصفية: الدفتر كله كما كان
 */
export interface DimFilter {
  propertyId?: string | null;
  unitId?: string | null;
  contractId?: string | null;
  costCenterId?: string | null;
  assetId?: string | null;
}
const DIM_COL: Record<keyof DimFilter, string> = {
  propertyId: 'l.property_id', unitId: 'l.unit_id', contractId: 'l.contract_id', costCenterId: 'l.cost_center_id', assetId: 'l.asset_id',
};
/** شروط التصفية وقيمها · تُضاف إلى استعلامٍ على journal_lines l */
export function dimConds(f: DimFilter | null | undefined): { sql: string[]; params: string[] } {
  const sql: string[] = []; const params: string[] = [];
  for (const k of Object.keys(DIM_COL) as Array<keyof DimFilter>) {
    const v = f?.[k];
    if (v) { sql.push(`${DIM_COL[k]} = ?`); params.push(v); }
  }
  return { sql, params };
}
export const hasDimFilter = (f: DimFilter | null | undefined): boolean => dimConds(f).sql.length > 0;

/** حركات كل الحسابات خلال فترة دفعة واحدة · بدل استعلامين لكل حساب */
export function allAccountMovements(
  db: DB,
  from: string | null,
  to: string | null,
  dims?: DimFilter | null,
): Map<string, { debit: number; credit: number }> {
  const dc = dimConds(dims);
  const conds = [`e.status = 'مرحّل'`, `e.deleted_at IS NULL`, ...dc.sql];
  const params: string[] = [...dc.params];
  if (from) { conds.push(`e.date >= ?`); params.push(from); }
  if (to) { conds.push(`e.date <= ?`); params.push(to); }
  return new Map(
    db.all<{ code: string; d: number; c: number }>(
      `SELECT l.account_code AS code, COALESCE(SUM(l.debit_halalas),0) AS d, COALESCE(SUM(l.credit_halalas),0) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE ${conds.join(' AND ')} GROUP BY l.account_code`,
      params
    ).map((r) => [r.code, { debit: Number(r.d), credit: Number(r.c) }])
  );
}

/** حركة حساب خلال فترة */
export function accountMovement(
  db: DB,
  code: string,
  from: string | null,
  to: string | null,
  dims?: DimFilter | null,
): { debit: number; credit: number } {
  const dc = dimConds(dims);
  const conds = [`l.account_code = ?`, `e.status = 'مرحّل'`, `e.deleted_at IS NULL`, ...dc.sql];
  const params: (string | number)[] = [code, ...dc.params];
  if (from) { conds.push(`e.date >= ?`); params.push(from); }
  if (to) { conds.push(`e.date <= ?`); params.push(to); }
  const row = db.get<{ d: number; c: number }>(
    `SELECT COALESCE(SUM(l.debit_halalas),0) AS d, COALESCE(SUM(l.credit_halalas),0) AS c
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE ${conds.join(' AND ')}`,
    params
  );
  return { debit: row ? Number(row.d) : 0, credit: row ? Number(row.c) : 0 };
}

/** صافي تغيّر حساب خلال فترة باتجاه طبيعته (تغذي قائمة التدفقات) */
export function accountPeriodChange(db: DB, code: string, from: string | null, to: string | null, dims?: DimFilter | null): number {
  const acc = getAccount(db, code);
  if (!acc) return 0;
  const m = accountMovement(db, code, from, to, dims);
  return DEBIT_NORMAL_TYPES.has(acc.type) ? m.debit - m.credit : m.credit - m.debit;
}

/** إيراد ومصروف كل شهر دفعة واحدة · لرسم الأعمدة المتجاورة وخط الصافي */
export function monthlyRevenueExpense(
  db: DB,
  fromMonth: string,
  toMonth: string
): Map<string, { revenue: number; expense: number }> {
  const rows = db.all<{ m: string; type: string; net: number }>(
    `SELECT substr(e.date, 1, 7) AS m, a.type AS type,
            COALESCE(SUM(CASE WHEN a.type = 'إيراد' THEN l.credit_halalas - l.debit_halalas
                              ELSE l.debit_halalas - l.credit_halalas END), 0) AS net
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.code = l.account_code
     WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL
       AND a.type IN ('إيراد','مصروف')
       AND substr(e.date, 1, 7) >= ? AND substr(e.date, 1, 7) <= ?
     GROUP BY m, a.type`,
    [fromMonth, toMonth]
  );
  const out = new Map<string, { revenue: number; expense: number }>();
  for (const r of rows) {
    const cur = out.get(r.m) ?? { revenue: 0, expense: 0 };
    if (r.type === 'إيراد') cur.revenue += Number(r.net);
    else cur.expense += Number(r.net);
    out.set(r.m, cur);
  }
  return out;
}

/** إيرادات ومصروفات فترة · استعلام تجميعي واحد */
export function periodRevenueExpense(
  db: DB,
  from: string | null,
  to: string | null
): { revenue: number; expense: number } {
  const conds = [`e.status = 'مرحّل'`, `e.deleted_at IS NULL`, `a.type IN ('إيراد','مصروف')`];
  const params: (string | number)[] = [];
  if (from) { conds.push(`e.date >= ?`); params.push(from); }
  if (to) { conds.push(`e.date <= ?`); params.push(to); }
  const rows = db.all<{ type: string; net: number }>(
    `SELECT a.type AS type,
            SUM(CASE WHEN a.type='إيراد' THEN l.credit_halalas - l.debit_halalas
                     ELSE l.debit_halalas - l.credit_halalas END) AS net
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.code = l.account_code
     WHERE ${conds.join(' AND ')}
     GROUP BY a.type`,
    params
  );
  let revenue = 0, expense = 0;
  for (const r of rows) {
    if (r.type === 'إيراد') revenue = Number(r.net);
    else expense = Number(r.net);
  }
  return { revenue, expense };
}

/** الاتجاه الشهري للإيرادات · استعلام واحد مجمَّع بالشهر */
export function monthlyRevenue(db: DB, fromMonth: string, toMonth: string): Map<string, number> {
  const rows = db.all<{ month: string; net: number }>(
    `SELECT substr(e.date, 1, 7) AS month,
            SUM(l.credit_halalas - l.debit_halalas) AS net
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.code = l.account_code
     WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL AND a.type = 'إيراد'
       AND substr(e.date,1,7) >= ? AND substr(e.date,1,7) <= ?
     GROUP BY 1`,
    [fromMonth, toMonth]
  );
  return new Map(rows.map((r) => [r.month, Number(r.net)]));
}

/** النقد المتاح الآن · مجموع أرصدة مجموعة النقدية */
/**
 * المحفظة النقدية: ما في اليد فعلاً = رصيد النقدية 1100 - ما استقر في البنوك.
 * حسابياً: 1100 يستقبل كل المقبوضات ويصرف كل المدفوعات، والبنوك تتتبع حركاتها
 * في bank_tx · ففرقهما هو الكاش الحاضر (الافتتاحيات البنكية ليست في 1100).
 */
export function walletCashBalance(db: DB): number {
  const cash = accountBalance(db, '1100');
  const bankFlow = Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(amount_halalas),0) AS s FROM bank_tx WHERE deleted_at IS NULL`
  )!.s);
  return cash - bankFlow;
}

export function cashOnHand(db: DB): number {
  let total = 0;
  for (const a of allAccounts(db)) {
    if (a.grp === 'النقدية وما في حكمها') total += accountBalance(db, a.code);
  }
  return total;
}

/** رصيد بنك مشتق: الافتتاحي + مجموع حركاته الحية */
export function bankBalance(db: DB, bankId: string): number {
  const row = db.get<{ opening: number; tx: number }>(
    `SELECT b.opening_halalas AS opening,
            COALESCE((SELECT SUM(t.amount_halalas) FROM bank_tx t
                      WHERE t.bank_id = b.id AND t.deleted_at IS NULL),0) AS tx
     FROM banks b WHERE b.id = ?`,
    [bankId]
  );
  return row ? Number(row.opening) + Number(row.tx) : 0;
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  /** رصيد أول المدة موقَّعاً: موجب مدين، سالب دائن */
  openingHalalas: number;
  debitHalalas: number;
  creditHalalas: number;
  /** رصيد آخر المدة موقَّعاً: موجب مدين، سالب دائن */
  closingHalalas: number;
}

/**
 * ميزان المراجعة · لكل حساب: رصيد أول المدة، إجمالي الحركة المدينة والدائنة خلالها،
 * ورصيد آخر المدة · والافتتاحي المزروع يدخل أول المدة بطبيعة الحساب.
 * استعلام تجميعي واحد للحركات فلا يثقل بكثرة الحسابات.
 */
export function trialBalance(db: DB, from: string | null, to: string | null, dims?: DimFilter | null): TrialBalanceRow[] {
  const accounts = allAccounts(db);
  const dc = dimConds(dims);
  const agg = (cond: string, params: (string | number)[]) => {
    const map = new Map<string, { d: number; c: number }>();
    for (const r of db.all<{ account_code: string; d: number; c: number }>(
      `SELECT l.account_code, COALESCE(SUM(l.debit_halalas),0) AS d, COALESCE(SUM(l.credit_halalas),0) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL${cond}${dc.sql.map((x) => ' AND ' + x).join('')}
       GROUP BY l.account_code`, [...params, ...dc.params]
    )) map.set(r.account_code, { d: Number(r.d), c: Number(r.c) });
    return map;
  };
  const before = from ? agg(` AND e.date < ?`, [from]) : new Map<string, { d: number; c: number }>();
  const during = agg(
    (from ? ` AND e.date >= ?` : '') + (to ? ` AND e.date <= ?` : ''),
    [...(from ? [from] : []), ...(to ? [to] : [])]
  );
  return accounts.map((a) => {
    // الافتتاحي المزروع بلا أبعاد · فلا يدخل ميزاناً مصفّى ببُعد
    const seeded = hasDimFilter(dims) ? 0 : Number(a.opening_halalas || 0) * (DEBIT_NORMAL_TYPES.has(a.type) ? 1 : -1);
    const b = before.get(a.code) ?? { d: 0, c: 0 };
    const m = during.get(a.code) ?? { d: 0, c: 0 };
    const opening = seeded + b.d - b.c;
    return {
      code: a.code, name: a.name, type: a.type,
      openingHalalas: opening,
      debitHalalas: m.d,
      creditHalalas: m.c,
      closingHalalas: opening + m.d - m.c,
    };
  });
}

export interface CostCenterRow {
  id: string;
  name: string;
  revenue: number;
  expense: number;
  net: number;
}

/**
 * الإيرادات والمصروفات حسب مركز التكلفة خلال فترة (قرار المالك ٢٠٢٦-١٠-٠٤) · كل مركز بسطوره، وما لا مركز
 * لسطره (قيود قديمة لم تُملأ) صفٌّ «بلا مركز» · ويقبل تصفية العقار والوحدة والعقد فوقه
 */
export function costCenterReport(db: DB, from: string | null, to: string | null, dims?: DimFilter | null): CostCenterRow[] {
  const dc = dimConds({ ...(dims ?? {}), costCenterId: null });
  const conds = [`e.status = 'مرحّل'`, `e.deleted_at IS NULL`, `a.type IN ('إيراد', 'مصروف')`, ...dc.sql];
  const params: string[] = [...dc.params];
  if (from) { conds.push(`e.date >= ?`); params.push(from); }
  if (to) { conds.push(`e.date <= ?`); params.push(to); }
  const rows = db.all<{ cc: string | null; name: string | null; gone: string | null; rev: number; exp: number }>(
    `SELECT l.cost_center_id AS cc, c.name AS name, c.deleted_at AS gone,
            COALESCE(SUM(CASE WHEN a.type = 'إيراد' THEN l.credit_halalas - l.debit_halalas ELSE 0 END), 0) AS rev,
            COALESCE(SUM(CASE WHEN a.type = 'مصروف' THEN l.debit_halalas - l.credit_halalas ELSE 0 END), 0) AS exp
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.code = l.account_code
     LEFT JOIN cost_centers c ON c.id = l.cost_center_id
     WHERE ${conds.join(' AND ')}
     GROUP BY l.cost_center_id ORDER BY (l.cost_center_id IS NULL), c.is_default DESC, c.name`, params);
  return rows.map((r) => ({
    id: r.cc ?? '', name: r.cc ? (r.name ? r.name + (r.gone ? ' (محذوف)' : '') : 'مركز محذوف') : 'بلا مركز', revenue: Number(r.rev), expense: Number(r.exp),
    net: Number(r.rev) - Number(r.exp),
  }));
}
