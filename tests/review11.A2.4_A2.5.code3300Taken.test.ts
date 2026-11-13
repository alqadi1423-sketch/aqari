/**
 * مدقق مستقل على إصلاح A2.4 (المراجعة الشاملة 2026-11-13 · قرار المالك س٢) · بيانات مصطنعة كلها.
 * العيب: الهجرة ٦٢ تُدرج 3300 «أرصدة افتتاحية» بـ INSERT OR IGNORE، والاشتقاق (ledger.ts: ledgerBankOpenings وwithBankOpening) يقيّد
 * افتتاحيات البنوك على أي صفٍّ رمزه 3300 بطبيعته هو، نظامياً كان أو لا. ودليل الحسابات يقبل من المستخدم أي رمز، و3300 هو الرمز التالي
 * الطبيعي لحساب حقوق ملكية بعد 3100 و3200 (كالاحتياطي النظامي). فمن أنشأ 3300 قبل الترقية:
 *  - حسابه «احتياطي نظامي» يزيد بافتتاحيات البنوك ولا يظهر سطر «أرصدة افتتاحية» أبداً (رصيدٌ خاطئ في حسابٍ للمستخدم).
 *  - وإن كان نوعه «أصل» نقص به مجموع الأصول بقدر ما زاد في 1100: النقدية ٦٬٥٠٠ وإجمالي الأصول ٦٬٠٠٠، وتنبيه الفرق الافتتاحي (٥٠٠ قبل
 *    الترقية) يختفي فيُخفي أن البنك خارج المجموع.
 *  - ومن أنشأه ثم حذفه (حذفٌ ناعم يبقى صفّه) لا يُدرج له 3300 أصلاً، فلا يُشتق شيء أبداً ولا يقدر أن ينشئه (الرمز «مستخدم»): A2.4 لا يُصلَح له.
 * السلوك الصحيح:
 *  - حساب المستخدم ذو الرمز 3300 لا يُمسّ: رصيده افتتاحيّه المزروع وحده.
 *  - وافتتاحي البنك لا يُخفى: إمّا في الدفتر مقابل سطرٍ نظامي «أرصدة افتتاحية» في حقوق الملكية بالمبلغ (والفرق صفر)، وإمّا خارجه ظاهراً في
 *    الفرق الافتتاحي كما كان قبل الهجرة.
 *  - والصف المحذوف ناعماً لا يحجب الإصلاح: افتتاحي البنك في 1100 مقابل «أرصدة افتتاحية» كما لغيره.
 * الأرقام بالهللة: fill() يضع بنكاً افتتاحيه ٥٠٠٫٠٠ (50000) ومقبوضاتٍ نقدية ٦٬٠٠٠٫٠٠ (تأمين ٢٬٠٠٠ وإيجار ٣٬٠٠٠ و١٬٠٠٠).
 */
import { openingDifference } from '@/domain/accounting/chart';
import { financialStatementBlock } from '@/domain/finStatements';
import { accountBalance } from '@/domain/accounting/ledger';
import { schemaAt, fill, ins } from './helpers/oldSchema';
import { migrate } from '@/db/migrations';
import { seed } from '@/db/seed';
import type { DB } from '@/db/adapter';

const T = '2026-01-01T00:00:00.000Z';
const money = (c: unknown) => (c as { money: number }).money;

function upgradedWith(row: { name: string; type: string; opening: number; deleted?: boolean }): DB {
  const db = schemaAt(':memory:', 61);
  fill(db);
  // حساب المستخدم برمز 3300 أنشأه من دليل الحسابات قبل الإصدار ٦٢ (saveAccount: غير نظامي)
  ins(db, 'accounts', { code: '3300', name: row.name, type: row.type, grp: null, opening_halalas: row.opening, is_system: 0, created_at: T,
    deleted_at: row.deleted ? '2026-02-01T00:00:00.000Z' : null });
  migrate(db);
  seed(db);
  return db;
}

function sheet(db: DB) {
  const bs = financialStatementBlock(db, 'balance', null, '2026-12-31');
  const total = (label: string) => money(bs.totals.find((r) => r[0] === label)?.[1]);
  const row = (si: number, name: string) => {
    const r = bs.sections[si].rows.find((x) => x[0] === name);
    return r ? money(r[1]) : undefined;
  };
  return { assets: total('إجمالي الأصول'), le: total('إجمالي الخصوم وحقوق الملكية'), row };
}

test('حساب «احتياطي نظامي» للمستخدم برمز 3300 (حقوق ملكية، افتتاحيه ١٬٠٠٠٫٠٠): لا تُقيَّد عليه افتتاحيات البنوك', () => {
  const db = upgradedWith({ name: 'احتياطي نظامي مصطنع', type: 'حقوق ملكية', opening: 100000 });
  // رصيده افتتاحيّه وحده ١٬٠٠٠٫٠٠ · وكان يصير ١٬٥٠٠٫٠٠ بافتتاحي البنك ٥٠٠٫٠٠
  expect(accountBalance(db, '3300')).toBe(100000);
  const s = sheet(db);
  expect(s.row(2, 'احتياطي نظامي مصطنع')).toBe(100000);
  // وافتتاحي البنك (٥٠٠٫٠٠) إمّا في الدفتر مقابل «أرصدة افتتاحية» وإمّا ظاهرٌ في الفرق الافتتاحي · لا يُخفى ولا يُحمَّل على حسابٍ آخر
  // (الفرق الافتتاحي فيه افتتاحي الاحتياطي الدائن ١٬٠٠٠٫٠٠ أصلاً، فيُضاف قبل المقارنة)
  const inLedger = accountBalance(db, '1100') - 600000;
  expect(inLedger + openingDifference(db) + 100000).toBe(50000);
  expect(s.row(2, 'أرصدة افتتاحية') ?? 0).toBe(inLedger);
  db.close();
});

test('حساب «عهدة» للمستخدم برمز 3300 (أصل): لا يُخصم منه افتتاحي البنك، ومجموع الأصول يشمل البنك كما تُظهره النقدية', () => {
  const db = upgradedWith({ name: 'عهدة نقدية مصطنعة', type: 'أصل', opening: 0 });
  // قبل الترقية كان الفرق الافتتاحي ٥٠٠٫٠٠ ظاهراً · وبعدها لا يُمسّ حساب العهدة (صفر لا سالب ٥٠٠)
  expect(accountBalance(db, '3300')).toBe(0);
  const s = sheet(db);
  expect(s.row(0, 'عهدة نقدية مصطنعة')).toBe(0);
  // الأصول كلها = النقدية 1100 (لا أصل آخر في البيانات)، فلا يُطرح البنك من الأصول بعد أن أُضيف إلى النقدية
  expect(s.assets).toBe(accountBalance(db, '1100'));
  const inLedger = accountBalance(db, '1100') - 600000;
  expect(inLedger + openingDifference(db)).toBe(50000);
  expect(s.row(2, 'أرصدة افتتاحية') ?? 0).toBe(inLedger);
  db.close();
});

test('رمز 3300 أنشأه المستخدم ثم حذفه قبل الترقية: يُصلَح A2.4 له كغيره (1100 = ٦٬٥٠٠ و«أرصدة افتتاحية» ٥٠٠ والفرق صفر)', () => {
  const db = upgradedWith({ name: 'حساب محذوف مصطنع', type: 'مصروف', opening: 0, deleted: true });
  // ٦٬٠٠٠ مقبوضات + ٥٠٠ افتتاحي البنك
  expect(accountBalance(db, '1100')).toBe(650000);
  expect(openingDifference(db)).toBe(0);
  const s = sheet(db);
  expect(s.row(2, 'أرصدة افتتاحية')).toBe(50000);
  // الأصول ٦٬٥٠٠ = الخصوم (تأمين) ٢٬٠٠٠ + حقوق الملكية (أرصدة افتتاحية ٥٠٠ + أرباح غير مقفلة ٤٬٠٠٠)
  expect([s.assets, s.le]).toEqual([650000, 650000]);
  db.close();
});
