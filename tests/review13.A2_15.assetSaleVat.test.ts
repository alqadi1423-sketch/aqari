/**
 * A2.15 · متوسط · src/domain/assets/service.ts (sellAsset) · قرار المالك س٢١ (2026-11-13: نعم، ويؤكّده المحاسب)
 *
 * السيناريو (بيانات مصطنعة، منشأة مسجّلة): مكيف تكلفته ٨٤٠٫٠٠ (قسطه الشهري ١٠٫٠٠) اشتُري 2026-01-05، وبيع 2026-03-31 بمقبوضٍ
 * ١٬١٥٠٫٠٠ · كان القيد يرحّل النقد كله على الفئة والربح، بلا 2200 ولا البند ١.
 * القرار (س٢١): المقبوض شاملٌ ضريبة ١٥٪ كعمولة التقبيل: صافيه ١٬٠٠٠٫٠٠ وضريبته ١٥٠٫٠٠ (splitVatInclusive)، والربح على الصافي،
 * ويُقرأ في البند ١ من سطور القيد نفسه · والمنشأة غير المسجّلة كما كانت.
 * الأرقام الذهبية: المجمع حتى البيع ٢٠٫٠٠ (فبراير ومارس)، فالقيمة الدفترية ٨٢٠٫٠٠، والربح ١٬٠٠٠٫٠٠ − ٨٢٠٫٠٠ = ١٨٠٫٠٠ ·
 * القيد: مدين 1100 ١٬١٥٠٫٠٠ ومدين 1490 ٢٠٫٠٠ / دائن 1410 ٨٤٠٫٠٠ ودائن 2200 ١٥٠٫٠٠ ودائن 4400 ١٨٠٫٠٠.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit } from './helpers/fixtures';
import { createPendingAsset, setAssetCost, sellAsset } from '@/domain/assets/service';
import { vatReturnData } from '@/domain/vatReturn';
import { cashFlowFigures } from '@/domain/finStatements';
import { accountMovement } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { pair, sync, srcAsMember, asMember, has, reasonOf, net, type Lines } from './helpers/rederive';
import { initI18n } from '@/i18n';
import type { DB } from '@/db/adapter';

beforeAll(() => { initI18n('ar'); });

const bal = (db: DB, code: string) => { const m = accountMovement(db, code, null, null); return m.debit - m.credit; };
const red = (db: DB) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')');
function soldAc(registered: boolean) {
  const db = memDb();
  if (registered) db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
  const u = addUnit(db, addProperty(db, { name: 'عقار بيع مصطنع' }), { unit_no: 'S-1' });
  const a = createPendingAsset(db, { name: 'مكيف بيع مصطنع', category: '1410', unitId: u });
  setAssetCost(db, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  sellAsset(db, a, { date: '2026-03-31', amountHalalas: 115000, method: 'cash', today: '2026-04-02' });
  return db;
}
const item = (db: DB, no: string) => {
  const r = vatReturnData(db, 2026, 1).items.find((i) => i.no === no)!;
  return [r.amountHalalas, r.taxHalalas];
};

test('A2.15 منشأة مسجّلة: المقبوض شاملٌ الضريبة · 2200 بضريبته، والربح على الصافي، والبند ١ يطابق حركة 2200', () => {
  const db = soldAc(true);
  const e = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'asset_sell'`)!;
  const lines = db.all<{ a: string; d: number; c: number }>(
    `SELECT account_code AS a, debit_halalas AS d, credit_halalas AS c FROM journal_lines WHERE entry_id = ? ORDER BY account_code`, [e.id]);
  expect(lines).toEqual([
    { a: '1100', d: 115000, c: 0 }, { a: '1410', d: 0, c: 84000 }, { a: '1490', d: 2000, c: 0 }, { a: '2200', d: 0, c: 15000 }, { a: '4400', d: 0, c: 18000 },
  ]);
  expect([bal(db, '4400'), bal(db, '2200')]).toEqual([-18000, -15000]);
  expect(item(db, '1')).toEqual([100000, 15000]);
  expect(item(db, '6')).toEqual([100000, 15000]);
  expect(item(db, '13')).toEqual([0, 15000]);
  // التدفقات: متحصّل البيع صافيه استثماري، وضريبته في رأس المال العامل · بلا فرقٍ غير مفسَّر
  const cf = cashFlowFigures(db, '2026-03-01', '2026-03-31', 18000 - 1000);
  expect([cf.sold, cf.investing, cf.unexplained]).toEqual([100000, 100000, 0]);
  expect(cf.workingCapital.find((l) => l.code === '2200')?.v).toBe(15000);
  expect(red(db)).toEqual([]);
  db.close();
});

test('A2.15 منشأة غير مسجّلة: كما كان · النقد كله على الفئة والربح، ولا شيء في البند ١', () => {
  const db = soldAc(false);
  expect([bal(db, '4400'), bal(db, '2200')]).toEqual([-(115000 - 82000), 0]);
  expect(item(db, '1')).toEqual([0, 0]);
  db.close();
});

describe('A2.15 جهاز المالك على بيع العضو', () => {
  async function setup() {
    const p = await pair();
    for (const db of [p.owner, p.dev]) db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
    const ua = addUnit(p.owner, addProperty(p.owner, { name: 'عقار بيع عضو مصطنع' }), { unit_no: 'SM-1' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    const a = createPendingAsset(p.dev, { name: 'مكيف عضو مصطنع', category: '1410', unitId: ua });
    setAssetCost(p.dev, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
    await sync(p.dev, p.r);
    for (let i = 0; i < 3; i++) await sync(p.owner, p.r);
    sellAsset(p.dev, a, { date: '2026-04-16', amountHalalas: 115000, method: 'cash', today: '2026-04-20' });
    await sync(p.dev, p.r);
    srcAsMember(p.r, /^(depreciation|asset_dep)$/);
    return p;
  }
  /** بلا ضريبة المخرجات: 2200 يصير ربحاً (متوازن) */
  const noVat = (ls: Lines): Lines => ls.filter((l) => l.account_code !== '2200').map((l) => (l.account_code === '4400'
    ? { ...l, credit_halalas: Number(l.credit_halalas) + 15000 } : l));

  for (const forged of [false, true]) {
    test(forged ? 'سلبي · بيعٌ بلا ضريبة مخرجات والمنشأة مسجّلة: يُرفض ولا يدخل الدفتر' : 'إيجابي · ما يكتبه التطبيق بضريبته يُقبل', async () => {
      const s = await setup();
      const k = asMember(s.r, 'asset_sell', forged ? noVat : undefined);
      for (let i = 0; i < 3; i++) await sync(s.owner, s.r);
      expect(has(s.owner, k)).toBe(!forged);
      expect(net(s.owner, '2200')).toBe(forged ? 0 : -15000);
      if (forged) expect(reasonOf(s.owner, k)).toMatch(/2200|4400/);
      s.close();
    });
  }
});
