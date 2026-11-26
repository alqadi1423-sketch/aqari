/**
 * المراجعة الشاملة 2026-11-13 · A2.11 · منخفض · src/domain/finStatements.ts (ASSET_ENTRY_TYPES) · بيانات مصطنعة.
 *
 * ما كان: قيد التراجع عن تحويل الأصول (asset_dep_undo · undoConversion) ليس في قيود الأصول غير النقدية، فيدخل دائن 5600 صافي الربح
 * التشغيلي، ومدين 1490 الاستثماري · المجموع صفر فلا «فرق غير مفسَّر»، لكن التدفق التشغيلي والاستثماري يُظهران حركةً لا نقد فيها.
 * الأرقام الذهبية: فاتورة صيانة 2025-01-10 بـ٢٬٤٠٠٫٠٠ حُوّل منها مكيفان بـ١٬٦٨٠٫٠٠ في 2026-03-10، ورُحّل إهلاك مارس وأبريل
 * (٢ × ٢ × ١٠٫٠٠ = ٤٠٫٠٠)، ثم تُراجع عن التحويل في 2026-05-02 · قيد التراجع (سطران لكل مكيف): مدين 1490 ٤٠٫٠٠ / دائن 5600 ٤٠٫٠٠.
 * تدفقات مايو: لا نقد تحرّك فيه، فالتشغيلي والاستثماري والتمويلي صفر.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit } from './helpers/fixtures';
import { savePurchase, type PurchaseInput } from '@/domain/purchases';
import { convertPurchase, undoConversion } from '@/domain/assets/convert';
import { runDepreciation } from '@/domain/assets/depreciation';
import { cashFlowFigures } from '@/domain/finStatements';
import { integrityChecks } from '@/domain/accounting/integrity';
import { initI18n } from '@/i18n';

beforeAll(() => { initI18n('ar'); });

const purchase = (o: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد أصول مصطنع', date: '2025-01-10', due: '2025-02-10', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: true, subtotalHalalas: 240000, taxHalalas: 0, totalHalalas: 240000, ...o,
});

test('A2.11 قيد التراجع عن التحويل غير نقدي: لا تشغيلي ولا استثماري ولا تمويلي في شهره', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار تراجع مصطنع' }), { unit_no: 'UD-1' });
  const pid = savePurchase(db, purchase());
  convertPurchase(db, pid, [
    { descr: 'مكيف مصطنع', qty: 2, amountHalalas: 168000, isAsset: true, category: '1410', unitId: u },
    { descr: 'أجور تركيب مصطنعة', qty: 1, amountHalalas: 72000, isAsset: false },
  ], '2026-03-10');
  runDepreciation(db, '2026-05-01');
  undoConversion(db, pid, '2026-05-02');
  const undo = db.all<{ a: string; d: number; c: number }>(
    `SELECT l.account_code AS a, SUM(l.debit_halalas) AS d, SUM(l.credit_halalas) AS c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.src_type = 'asset_dep_undo' GROUP BY l.account_code ORDER BY l.account_code`);
  expect(undo).toEqual([{ a: '1490', d: 4000, c: 0 }, { a: '5600', d: 0, c: 4000 }]);
  const net = Number(db.get<{ v: number }>(
    `SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.code = l.account_code WHERE e.deleted_at IS NULL AND e.date >= '2026-05-01' AND e.date <= '2026-05-31'
       AND a.type IN ('إيراد', 'مصروف')`)!.v);
  const cf = cashFlowFigures(db, '2026-05-01', '2026-05-31', net);
  expect([cf.cashChange, cf.opCash, cf.investing, cf.financing, cf.unexplained]).toEqual([0, 0, 0, 0, 0]);
  expect(integrityChecks(db).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  db.close();
});
