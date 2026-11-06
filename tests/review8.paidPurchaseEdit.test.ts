/**
 * المراجعة الشاملة · البند ٤: تعديل فاتورة شراء مسدَّدة كان يعكس قيد التسجيل ويعيد ترحيله بالقيمة الجديدة،
 * ويُبقي قيد السداد وحركته البنكية بالقيمة القديمة، فيختل 2100 (مستحقٌ ظاهر على فاتورةٍ paid=1).
 * القرار (أ): المسدَّدة لا تُعدَّل ما دام سدادها قائماً · يُتراجع عن السداد أولاً ثم تُعدَّل وتُسدَّد · بيانات مصطنعة.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit } from './helpers/fixtures';
import {
  savePurchase, payPurchase, unmarkPurchasePaid, deletePurchase, restorePurchase, markVatFiled, markVatRefunded,
  purchaseEditBlock, TS_DEDUCTIBLE, type PurchaseInput,
} from '@/domain/purchases';
import { convertPurchase } from '@/domain/assets/convert';
import { ownerCashIn } from '@/domain/cashOps';
import { accountBalance, walletCashBalance, bankBalance } from '@/domain/accounting/ledger';
import { t } from '@/i18n';
import type { DB } from '@/db/adapter';

const pur = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد صيانة مصطنع', date: '2026-05-10', due: '2026-06-10', category: 'صيانة', incorpItem: '', amortize: false,
  amortizeMonths: null, exempt: false, excludeFromVat: false, taxStatus: TS_DEDUCTIBLE,
  subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000, ...over,
} as PurchaseInput);
// ١٬١٥٠ تصير ٢٬٣٠٠
const EDITED = { subtotalHalalas: 200000, taxHalalas: 30000, totalHalalas: 230000 };

/** كل ما قد يكتبه الحفظ: القيود وسطورها وحركات البنوك وصف الفاتورة وبنودها وسجل العمليات */
const snapshot = (db: DB) => JSON.stringify([
  db.all(`SELECT * FROM journal_entries ORDER BY id`),
  db.all(`SELECT * FROM journal_lines ORDER BY entry_id, account_code, debit_halalas, credit_halalas`),
  db.all(`SELECT * FROM bank_tx ORDER BY id`),
  db.all(`SELECT * FROM purchases ORDER BY id`),
  db.all(`SELECT * FROM purchase_lines ORDER BY id`),
  db.all(`SELECT * FROM audit_log ORDER BY id`),
  db.all(`SELECT * FROM assets ORDER BY id`),
  db.all(`SELECT * FROM asset_events ORDER BY id`),
]);

function world() {
  const db = memDb();
  db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S4', 'مورد صيانة مصطنع', '300000000000004', '2026-01-01')`);
  ownerCashIn(db, { amountHalalas: 1_000_000, date: '2026-05-01' });
  const bank = addBank(db, 'بنك مصطنع', 1_000_000);
  const unit = addUnit(db, addProperty(db, { name: 'عقار مصطنع للبند ٤' }), { unit_no: 'M-4' });
  return { db, bank, unit };
}
/** بند أصلٍ بأساس الفاتورة كله (١٬٠٠٠) في وحدة مصطنعة */
const assetLine = (unitId: string) => ({ descr: 'مكيف مصطنع', qty: 1, amountHalalas: 100000, isAsset: true, category: '1410', unitId });
/** رسالة رفض الحفظ أو null إن حُفظ */
const saveError = (db: DB, id: string, input: PurchaseInput = pur(EDITED)): string | null => {
  try { savePurchase(db, input, id); return null; } catch (e) { return (e as Error).message; }
};

test('٤ مشتريات ١٬١٥٠ مسدَّدة نقداً لا تُعدَّل إلى ٢٬٣٠٠: يُرفض الحفظ بسببه وما يُفعل، ولا يُكتب شيء، و2100 صفر', () => {
  const { db } = world();
  const id = savePurchase(db, pur());
  payPurchase(db, id, 'cash', null, '2026-05-12');
  expect(accountBalance(db, '2100')).toBe(0);
  const cash = walletCashBalance(db);
  const before = snapshot(db);
  let err: unknown = null;
  try { savePurchase(db, pur(EDITED), id); } catch (e) { err = e; }
  // العيب: قبل الإصلاح يظهر ١٬١٥٠ مستحقاً في 2100 على فاتورةٍ paid=1
  expect(accountBalance(db, '2100')).toBe(0);
  expect((err as Error | null)?.message).toBe(t('purchase.paidLocked'));
  expect(snapshot(db)).toBe(before);
  expect(walletCashBalance(db)).toBe(cash);
  const row = db.get<{ paid: number; total_halalas: number }>(`SELECT paid, total_halalas FROM purchases WHERE id = ?`, [id])!;
  expect([Number(row.paid), Number(row.total_halalas)]).toEqual([1, 115000]);
  db.close();
});

test('٤ والمسدَّدة بتحويل بنكي كذلك: حركة البنك وقيد السداد يبقيان كما هما، و2100 صفر', () => {
  const { db, bank } = world();
  const id = savePurchase(db, pur());
  payPurchase(db, id, 'bank', bank, '2026-05-12');
  const bal = bankBalance(db, bank);
  const before = snapshot(db);
  // تعديلٌ لا يمسّ المبلغ يُرفض أيضاً: السداد القائم يُتراجع عنه أولاً
  expect(() => savePurchase(db, pur({ due: '2026-07-10' }), id)).toThrow(t('purchase.paidLocked'));
  expect(() => savePurchase(db, pur(EDITED), id)).toThrow(t('purchase.paidLocked'));
  expect(snapshot(db)).toBe(before);
  expect(accountBalance(db, '2100')).toBe(0);
  expect(bankBalance(db, bank)).toBe(bal);
  db.close();
});

test('٤ والمسار القائم يبقى: تراجعٌ عن السداد ثم تعديلٌ ثم سدادٌ بالقيمة الجديدة · 2100 صفر والنقد ناقص ٢٬٣٠٠ وحدها', () => {
  const { db } = world();
  const cash0 = walletCashBalance(db);
  const id = savePurchase(db, pur());
  payPurchase(db, id, 'cash', null, '2026-05-12');
  unmarkPurchasePaid(db, id);
  expect(accountBalance(db, '2100')).toBe(115000);
  savePurchase(db, pur(EDITED), id);
  expect(accountBalance(db, '2100')).toBe(230000);
  payPurchase(db, id, 'cash', null, '2026-05-13');
  expect(accountBalance(db, '2100')).toBe(0);
  expect(walletCashBalance(db)).toBe(cash0 - 230000);
  db.close();
});

test('٤ وفي الشاشة: زر «تعديل» لا يظهر للمسدَّدة في قائمة البطاقة ولا في ورقة العرض · و«التراجع عن السداد» باقٍ', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'purchases.tsx'), 'utf8');
  // يُذكر النمط الغائب وحده لا نص الشاشة كله
  const missing = [
    /canManage && paid \? \{ icon: 'undo'/,
    // البطاقة والورقة تُخفيان «تعديل» بما يرفضه الحفظ نفسه (purchaseEditBlock يشمل المسدَّدة)
    /canManage && !editLocked \? \{ icon: 'edit'/,
    /editLocked=\{!!purchaseEditBlock\(db, item\.id\)\}/,
    /editBlock: purchaseEditBlock\(db, purchaseId\)/,
    /!canManage \|\| editBlock \? null : <BtnGhost small icon="edit"/,
  ].filter((re) => !re.test(src)).map((re) => re.source);
  expect(missing).toEqual([]);
});

test('٤ والمحذوفة إلى السلة لا تُعدَّل: ١٬١٥٠ غير مسدَّدة حُذفت ثم عُدّلت إلى ٢٬٣٠٠ · يُرفض الحفظ بأنها في السلة، ولا يُكتب شيء، و2100 صفر', () => {
  const { db } = world();
  const id = savePurchase(db, pur());
  deletePurchase(db, id);
  expect(accountBalance(db, '2100')).toBe(0);
  const before = snapshot(db);
  const err = saveError(db, id);
  // العيب: قبل الإصلاح يُحفظ التعديل ويُرحَّل قيد تسجيلٍ جديد لفاتورةٍ في السلة فيصير 2100 = 230000
  expect(accountBalance(db, '2100')).toBe(0);
  expect(err).toBe(t('purchase.inTrash'));
  expect(snapshot(db)).toBe(before);
  expect(db.get<{ d: string | null }>(`SELECT deleted_at AS d FROM purchases WHERE id = ?`, [id])!.d).toBeTruthy();
  // وما يُفعل: الاستعادة ثم التعديل · 2100 بالقيمة الجديدة وحدها
  restorePurchase(db, id);
  expect(accountBalance(db, '2100')).toBe(115000);
  savePurchase(db, pur(EDITED), id);
  expect(accountBalance(db, '2100')).toBe(230000);
  db.close();
});

test('٤ والمحذوفة المسدَّدة تُرفض بأنها في السلة لا بالسداد · ومن تراجع عن سدادها ثم حفظ يُرفض كذلك، و2100 صفر', () => {
  const { db } = world();
  const id = savePurchase(db, pur());
  payPurchase(db, id, 'cash', null, '2026-05-12');
  deletePurchase(db, id);
  expect(accountBalance(db, '2100')).toBe(0);
  // كانت تُرفض بـ«تراجع عن السداد أولاً»، والصحيح لفاتورةٍ في السلة استعادتها
  expect(saveError(db, id)).toBe(t('purchase.inTrash'));
  unmarkPurchasePaid(db, id);
  const before = snapshot(db);
  const err = saveError(db, id);
  expect(accountBalance(db, '2100')).toBe(0);
  expect(err).toBe(t('purchase.inTrash'));
  expect(snapshot(db)).toBe(before);
  db.close();
});

test('٤ والمحوّلة إلى أصل أو التي بدأ إهلاك أصلها وهي مسدَّدة: يُرفض الحفظ بقفل الأصل أولاً لا بالسداد، فلا يُعكس سدادٌ بلا فائدة', () => {
  const { db, unit } = world();
  // محوّلة إلى أصل ثم سُدّدت نقداً
  const conv = savePurchase(db, pur());
  convertPurchase(db, conv, [assetLine(unit)], '2026-05-20');
  payPurchase(db, conv, 'cash', null, '2026-05-21');
  let before = snapshot(db);
  expect(saveError(db, conv)).toBe(t('assets.err.purchaseLocked'));
  expect(snapshot(db)).toBe(before);
  // بأصلٍ بدأ إهلاكه: فاتورةٌ بتاريخٍ مضى يُهلك ما فات لأصلها عند حفظها
  const dep = savePurchase(db, pur({ date: '2025-11-03', due: '2025-12-03', lines: [assetLine(unit)] }));
  payPurchase(db, dep, 'cash', null, '2026-05-12');
  before = snapshot(db);
  expect(saveError(db, dep, pur({ date: '2025-11-03', due: '2025-12-03', ...EDITED, lines: [{ ...assetLine(unit), amountHalalas: 200000 }] })))
    .toBe(t('assets.err.purchaseLocked'));
  expect(snapshot(db)).toBe(before);
  expect(accountBalance(db, '2100')).toBe(0);
  db.close();
});

test('٤ وزر «تعديل» يتبع ما يرفضه الحفظ نفسه: purchaseEditBlock يساوي رسالة رفض الحفظ لكل حالة، وnull حيث يُحفظ', () => {
  const { db, unit } = world();
  const cases: Array<[string, (id: string) => void, string | null]> = [
    ['غير مسدَّدة', () => undefined, null],
    ['مسدَّدة', (id) => payPurchase(db, id, 'cash', null, '2026-05-12'), t('purchase.paidLocked')],
    ['مقدَّمة في إقرار', (id) => markVatFiled(db, id), t('purchase.filedLocked')],
    ['مسترَدة ضريبتها', (id) => markVatRefunded(db, id, '2026-05-15'), t('purchase.vatSettled')],
    ['محوّلة إلى أصل', (id) => convertPurchase(db, id, [assetLine(unit)], '2026-05-20'), t('assets.err.purchaseLocked')],
    ['في السلة', (id) => deletePurchase(db, id), t('purchase.inTrash')],
  ];
  for (const [name, setup, expected] of cases) {
    const id = savePurchase(db, pur());
    setup(id);
    const block = purchaseEditBlock(db, id);
    expect([name, block]).toEqual([name, expected]);
    expect([name, saveError(db, id)]).toEqual([name, block]);
  }
  db.close();
});
