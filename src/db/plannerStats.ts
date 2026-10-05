/**
 * إحصاءات ثابتة لمخطِّط SQLite (أعطال ٢٠٢٦-١٠-٠٥: المزامنة والتحصيل والتذكيرات بطيئة).
 *
 * بلا إحصاءات يظنّ المخطِّط أن «account_code = '4900'» يطابق بضعة سطور كما يطابقها «entry_id = ?»،
 * فيبدأ خصمَ كل قسط بمسح سطور حساب الخصم كلها ثم يبحث عن قيدها · وهو في نصّ الخصم
 * (INSTALLMENT_DISCOUNT_SQL) وفي محفّزات سقف الدفعة معاً، فتتضاعف الكلفة مع حجم الدفتر.
 * والإحصاءات هنا شكلُ البيانات لا أرقامها: رمز الحساب يتكرر آلاف المرات، والقيد له سطور قليلة،
 * ومصدر القيد يشير إلى مستند واحد · فيختار المخطِّط فهرس القيد دائماً. وهو ما توصي به SQLite
 * لثبات الخطط («fixed stats» في sqlite_stat1)، ولا يمسّ النتائج، ويُكتب عند كل فتح إن نقص.
 */
import type { DB } from './adapter';

/** [الجدول، الفهرس، الإحصاء] · «عدد الصفوف ثم متوسط ما يطابقه كل عمود من أعمدة الفهرس تراكمياً» */
export const PLANNER_STATS: ReadonlyArray<readonly [string, string, string]> = [
  ['journal_lines', 'ix_jl_entry', '100000 3'],
  ['journal_lines', 'ix_jl_entry_account', '100000 3 2'],
  ['journal_lines', 'ix_jl_account', '100000 4000'],
  ['journal_entries', 'ix_je_src', '40000 8000 1'],
  ['journal_entries', 'ix_je_date', '40000 30'],
  ['contract_payments', 'ix_pay_installment', '20000 2'],
  ['contract_payments', 'ix_pay_journal', '20000 1'],
  ['contract_payments', 'ix_pay_contract', '20000 15'],
  ['contract_payments', 'ix_pay_date', '20000 10'],
  ['contract_installments', 'ix_inst_contract', '20000 12'],
  ['contract_installments', 'ix_inst_contract_due', '20000 12 1'],
  ['contract_installments', 'ix_inst_due', '20000 20'],
  ['payment_allocations', 'ix_alloc_payment', '5000 3'],
  ['payment_allocations', 'ix_alloc_installment', '5000 2'],
];

/** يكتب الإحصاءات الثابتة إن نقصت أو تغيّرت، ويعيد تحميلها · بعد الهجرة (الفهارس قائمة) */
export function applyPlannerStats(db: DB): void {
  const present = new Set(db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index'`).map((r) => r.name));
  const want = PLANNER_STATS.filter(([, idx]) => present.has(idx));
  if (!want.length) return;
  const hasStat = !!db.get(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'`);
  if (hasStat) {
    const have = new Map(db.all<{ idx: string; stat: string }>(`SELECT idx, stat FROM sqlite_stat1`).map((r) => [r.idx, r.stat]));
    if (want.every(([, idx, stat]) => have.get(idx) === stat)) return;
  }
  db.transaction(() => {
    // ينشئ sqlite_stat1 بلا مسح أي جدول
    if (!hasStat) db.exec('ANALYZE sqlite_master');
    for (const [tbl, idx, stat] of want) {
      db.run(`DELETE FROM sqlite_stat1 WHERE tbl = ? AND idx = ?`, [tbl, idx]);
      db.run(`INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?,?,?)`, [tbl, idx, stat]);
    }
  });
  // يُحمّل المخطِّط الإحصاءات من جديد
  db.exec('ANALYZE sqlite_master');
}
