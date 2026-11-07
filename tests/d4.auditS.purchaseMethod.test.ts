/**
 * المدقق الخارجي S · الجولة العاشرة · على 7e3b492 · بيانات مصطنعة كلها.
 * S٣: purchasePaidByBank (engine.ts) يحكم على حركة بنكٍ لقيد سداد فاتورة شراء بنصّ payment_method في صفّ الفاتورة وحده: يرفضها إن كان
 * «نقداً» تماماً أو فارغاً · والتوثيق (DESIGN.md §Q٣) يعدّ سداد المشتريات خارج حدّ «الربط المزوَّر خلال ساعة» · وفحص كفاية البنك صار
 * للربط المتأخر وحده، فيسقط الحارس في حالتين بلا تأخير «u» (S١):
 *  (أ) سدادٌ مقسَّم للمالك «نقداً + تحويل بنكي» (payPurchaseSplit): حركةٌ مزوَّرة بقدر الجزء النقدي من بنكٍ فارغ خلال الساعة تُطبَّق
 *      (مجموع الحركات لا يتجاوز نقد القيد).
 *  (ب) عضو المشتريات (كامل) يعدّل payment_method في صفّ فاتورةٍ سدّدها المالك نقداً إلى «تحويل بنكي» (لا يفحصه جهاز المالك ولا القاعدة)
 *      ثم يربط حركةً من بنكٍ فارغ خلال الساعة.
 * في الحالتين البنك سالب والمحفظة بنقدٍ لا وجود له · على e7c151c كانت الحركة تنتظر ما يكفيها.
 * السلوك الصحيح: حركة القيد التي لا يكتبها التطبيق مع قيده (الجزء النقدي أو سداد نقداً) لا تُطبَّق، أو تنتظر ما يكفيها.
 */
import { CASH_DEPOSIT_SOURCE, ownerCashIn } from '@/domain/cashOps';
import { walletCashBalance, bankBalance } from '@/domain/accounting/ledger';
import { savePurchase, payPurchase, payPurchaseSplit, type PurchaseInput } from '@/domain/purchases';
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { rejects, waiting } from './helpers/auditI';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';

let n = 0;
const tx = (s: { r: { inject: (d: RemoteDoc) => void } }, d: Record<string, unknown>): string => {
  const k = 's3-tx-' + (++n);
  const u = new Date().toISOString();
  s.r.inject({ id: 'bank_tx__' + k, t: 'bank_tx', k, u, dev: 'dev-member-s3', by: MEMBER, op: 'purchases', del: false,
    d: { id: k, date: '2026-10-02', descr: 'حركة مصطنعة S3', matched: 1, created_at: u, deleted_at: null, ...d } } as RemoteDoc);
  return k;
};
const applied = (db: DB, k: string) => !!db.get(`SELECT 1 FROM bank_tx WHERE id = ? AND deleted_at IS NULL`, [k]);

async function setup(kind: 'split' | 'cash') {
  const s = await pair();
  // بنك أ فيه هللة واحدة (للسداد المقسَّم)، وبنك ب فارغ، وبنك ج فارغ يُودَع فيه «النقد»
  const A = addBank(s.owner, 'بنك أ مصطنع S3', kind === 'split' ? 1 : 0);
  const B = addBank(s.owner, 'بنك ب مصطنع S3', 0);
  const C = addBank(s.owner, 'بنك ج مصطنع S3', 0);
  ownerCashIn(s.owner, { amountHalalas: 300000, date: '2026-10-01' });
  s.owner.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['SUP-S3', 'مورد مصطنع S3', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  const total = kind === 'split' ? 300001 : 300000;
  const pid = savePurchase(s.owner, {
    supplier: 'مورد مصطنع S3', date: '2026-10-02', due: '2026-11-02', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: null, propertyId: null, meterId: null, meterReading: null,
    subtotalHalalas: total, taxHalalas: 0, totalHalalas: total,
  } as PurchaseInput);
  if (kind === 'split') payPurchaseSplit(s.owner, pid, [{ method: 'cash', amountHalalas: 300000 }, { method: 'bank', bankId: A, amountHalalas: 1 }], '2026-10-02');
  else payPurchase(s.owner, pid, 'cash', null, '2026-10-02');
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const p = s.owner.get<{ no: string; m: string }>(`SELECT e.no, p.payment_method AS m FROM purchases p JOIN journal_entries e ON e.id = p.payment_journal_entry_id WHERE p.id = ?`, [pid])!;
  return { ...s, A, B, C, pid, no: p.no, method: p.m };
}

describe('S3 · حارس سداد المشتريات يقرأ نصّ طريقة السداد وحده', () => {
  test('S3a: سدادٌ مقسَّم «نقداً + تحويل بنكي»: حركةٌ مزوَّرة بالجزء النقدي من بنكٍ فارغ تُطبَّق', async () => {
    const s = await setup('split');
    expect(s.method).toBe('نقداً + تحويل بنكي');
    const base = [bankBalance(s.owner, s.B), bankBalance(s.owner, s.C), walletCashBalance(s.owner)];
    const fee = tx(s, { bank_id: s.B, amount_halalas: -300000, journal_no: s.no, source: 'سداد فاتورة · تحويل بنكي' });
    await ownerPulls(s.owner, s.r);
    const dep = tx(s, { bank_id: s.C, amount_halalas: 300000, journal_no: '', source: CASH_DEPOSIT_SOURCE });
    await ownerPulls(s.owner, s.r);
    const out = { base, owner: [bankBalance(s.owner, s.B), bankBalance(s.owner, s.C), walletCashBalance(s.owner)],
      feeApplied: applied(s.owner, fee), depApplied: applied(s.owner, dep),
      rejects: rejects(s.owner).map((r) => r.tbl + ': ' + r.reason), waiting: waiting(s.owner).map((w) => w.tbl + ': ' + w.last_error) };
    // eslint-disable-next-line no-console
    console.log('S3a', JSON.stringify(out));
    expect(base).toEqual([0, 0, 0]);
    expect(out.feeApplied).toBe(false);
    expect(out.owner).toEqual(base);
    s.close();
  });

  test('S3b: عضو المشتريات يجعل طريقة سداد فاتورةٍ نقدية «تحويل بنكي» ثم يربط حركةً من بنكٍ فارغ: تُطبَّق', async () => {
    const s = await setup('cash');
    expect(s.method).toBe('نقداً');
    const base = [bankBalance(s.owner, s.B), bankBalance(s.owner, s.C), walletCashBalance(s.owner)];
    // ١) صفّ الفاتورة كما في السحابة، بطريقة سدادٍ وبنكٍ آخرين (عضو المشتريات «كامل» يملك تعديل الفاتورة)
    const { ts: _ts, ...cloud } = s.r.docs.get('purchases__' + s.pid)!;
    s.r.inject({ ...cloud, by: cloud.by ?? MEMBER, op: 'purchases', dev: 'dev-member-s3', u: new Date().toISOString(),
      d: { ...cloud.d, payment_method: 'تحويل بنكي', payment_bank_id: s.B } } as RemoteDoc);
    // ٢) وحركةٌ برقم قيد السداد النقدي من بنك ب الفارغ
    const fee = tx(s, { bank_id: s.B, amount_halalas: -300000, journal_no: s.no, source: 'سداد فاتورة · تحويل بنكي' });
    await ownerPulls(s.owner, s.r);
    const dep = tx(s, { bank_id: s.C, amount_halalas: 300000, journal_no: '', source: CASH_DEPOSIT_SOURCE });
    await ownerPulls(s.owner, s.r);
    const out = { base, owner: [bankBalance(s.owner, s.B), bankBalance(s.owner, s.C), walletCashBalance(s.owner)],
      method: s.owner.get<{ m: string }>(`SELECT payment_method AS m FROM purchases WHERE id = ?`, [s.pid])!.m,
      feeApplied: applied(s.owner, fee), depApplied: applied(s.owner, dep),
      rejects: rejects(s.owner).map((r) => r.tbl + ': ' + r.reason), waiting: waiting(s.owner).map((w) => w.tbl + ': ' + w.last_error) };
    // eslint-disable-next-line no-console
    console.log('S3b', JSON.stringify(out));
    expect(base).toEqual([0, 0, 0]);
    expect(out.feeApplied).toBe(false);
    expect(out.owner).toEqual(base);
    s.close();
  });
});
