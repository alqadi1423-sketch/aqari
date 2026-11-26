/**
 * التوجيه الرابع ٤ · ٥ · المنطق المحاسبي النقي بالأرقام الذهبية (بلا تغيير في المخطط): src/domain/ledgerCore.ts دوالٌ خالصة، وأرقامها
 * محسوبة يدوياً في tests/golden/ledger.golden.json · والدوال المرتبطة بالقاعدة تستدعيها فتعطي الأرقام نفسها · وحارسٌ أن النواة لا تستورد
 * قاعدةً ولا وحدات جهاز فتعمل على أي خادم · بيانات مصطنعة.
 */
import fs from 'fs';
import path from 'path';
import * as core from '@/domain/ledgerCore';
import { splitVatInclusive } from '@/domain/taxCode';
import { pctOf } from '@/domain/money';
import { monthlyAmounts, expectedThrough } from '@/domain/assets/depreciation';
import { keyMoneyLines, purchaseLedgerLines, invoiceLedgerLines, contractDepositLines } from '@/domain/accounting/post';
import { rentSplit } from '@/domain/accounting/rentSplit';
import { confirmContract } from '@/domain/contracts/service';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'ledger.golden.json'), 'utf8'));
type L = { account: string; debit: number; credit: number };
const flat = (ls: L[] | null) => (ls ? ls.map((l) => [l.account, l.debit, l.credit]) : null);

describe('الأرقام الذهبية · النواة النقية والدوال المرتبطة بالقاعدة معاً', () => {
  test('فصل الضريبة من المبلغ الشامل · والمجموع المبلغ نفسه', () => {
    for (const c of G.vatInclusive) {
      expect([c.gross, core.vatInclusiveSplit(c.gross)]).toEqual([c.gross, { net: c.net, tax: c.tax }]);
      expect([c.gross, splitVatInclusive(c.gross)]).toEqual([c.gross, { net: c.net, tax: c.tax }]);
      expect(c.net + c.tax).toBe(c.gross);
    }
  });

  test('النسبة المئوية لأقرب هللة', () => {
    for (const c of G.pct) {
      expect([c.amount, core.pct(c.amount, c.percent)]).toEqual([c.amount, c.result]);
      expect([c.amount, pctOf(c.amount, c.percent)]).toEqual([c.amount, c.result]);
    }
  });

  test('نصيب الإيجار والخدمات والمواقف · تراكمياً، والمجموع المبلغ نفسه', () => {
    for (const c of G.rentShares) {
      const got = core.rentShares(c.contract, c.before, c.amount, c.side);
      expect(got).toEqual({ rent: c.rent, services: c.services, parking: c.parking });
      expect(got.rent + got.services + got.parking).toBe(c.amount);
    }
  });

  test('rentSplit على القاعدة يطابق النواة للعقد بلا دفعاتٍ قبله', () => {
    const db = memDb();
    const p = addProperty(db, { name: 'عقار ذهبي مصطنع' });
    for (const c of G.rentShares.filter((x: any) => x.before === 0 && x.side === 'credit')) {
      const u = addUnit(db, p, { unit_no: 'G-' + c.contract.value + '-' + c.contract.services });
      const id = confirmContract(db, { ...contractInput(u, { valueHalalas: c.contract.value, idNumber: '1000000' + String(c.contract.services).padStart(3, '0').slice(-3) }),
        servicesHalalas: c.contract.services, parkingHalalas: c.contract.parking } as never);
      expect(rentSplit(db, id, c.amount, 'credit')).toEqual({ rent: c.rent, services: c.services, parking: c.parking });
    }
  });

  test('الإهلاك بالقسط الثابت: القسط والأخير والمستحق حتى تواريخ', () => {
    for (const c of G.depreciation) {
      const m = core.straightLine(c.asset);
      expect([m?.per, m?.last]).toEqual([c.per, c.last]);
      const wrapped = { id: 'A', cost_halalas: c.asset.cost, salvage_halalas: c.asset.salvage, life_months: c.asset.lifeMonths, purchase_date: c.asset.purchaseDate };
      expect([monthlyAmounts(wrapped)?.per, monthlyAmounts(wrapped)?.last]).toEqual([c.per, c.last]);
      for (const [d, v] of Object.entries(c.through)) {
        expect([d, core.depreciationThrough(c.asset, d)]).toEqual([d, v]);
        expect([d, expectedThrough(wrapped, d)]).toEqual([d, v]);
      }
    }
  });

  test('عمولة التقبيل بالتسجيل وبدونه', () => {
    for (const c of G.keyMoney) {
      expect(flat(core.keyMoneyLinesOf(c.commission, c.registered))).toEqual(c.lines);
      const db = memDb();
      db.run(`UPDATE company SET vat_enabled = ? WHERE id = 1`, [c.registered ? 1 : 0]);
      expect(flat(keyMoneyLines(db, c.commission))).toEqual(c.lines);
    }
  });

  test('فاتورة الشراء بوضعها الضريبي وفئتها وفرق التقريب', () => {
    for (const c of G.purchase) {
      expect(flat(purchaseLedgerLines(c.p))).toEqual(c.lines);
      const t = core.totals(purchaseLedgerLines(c.p));
      expect(t.debit).toBe(t.credit);
    }
  });

  test('فاتورة المبيعات وقبض التأمين بجهة قبضه', () => {
    for (const c of G.invoice) {
      expect(flat(core.invoiceLinesOf(c.v))).toEqual(c.lines);
      expect(flat(invoiceLedgerLines(c.v))).toEqual(c.lines);
    }
    for (const c of G.deposit) {
      expect(flat(core.depositLinesOf(c.deposit, c.holder))).toEqual(c.lines);
      expect(flat(contractDepositLines(c.deposit, c.holder))).toEqual(c.lines);
    }
  });

  test('النواة نقية: لا تستورد شيئاً، فتعمل كما هي على أي خادم', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/domain/ledgerCore.ts'), 'utf8');
    expect(src).not.toMatch(/^import /m);
    expect(src).not.toMatch(/require\(/);
  });
});
