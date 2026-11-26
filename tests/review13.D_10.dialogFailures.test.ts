/**
 * المراجعة الشاملة 2026-11-13 · D-10 · متوسط · app/purchases.tsx و src/ui/AppDialog.tsx · بيانات مصطنعة كلها.
 *
 * السيناريو: فاتورة شراء حُوّلت بنودها إلى أصول ← شرط «حذف» في البطاقة لا يشمل التحويل فيظهر الزر ← الحوار يستدعي
 *   deletePurchase بلا التقاط فيرمي failPurchaseLocked متزامناً قبل Promise.resolve ← يفلت إلى المعالج العام
 *   ← «حدث خطأ غير متوقع» وتقرير عطلٍ زائف · ومثله «التراجع عن السداد» و«حذف المسودة» في القيود ·
 *   وعكسه: إجراءٌ غير متزامن يرفض يُبتلع بصمت (.catch(() => {})).
 * الصحيح: شرط «حذف» من دالة دومين واحدة (purchaseDeleteBlock) يرفض بها الحذف نفسه، وزرّ الحوار يلتقط الرمي
 *   المتزامن والرفض غير المتزامن ويعرضهما بحوار الفشل الموحَّد.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit } from './helpers/fixtures';
import { savePurchase, deletePurchase, purchaseDeleteBlock, markVatFiled, TS_DEDUCTIBLE, type PurchaseInput } from '@/domain/purchases';
import { convertPurchase } from '@/domain/assets/convert';
import { ownerCashIn } from '@/domain/cashOps';
import { t } from '@/i18n';

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');

const pur = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد مصطنع D10', date: '2026-05-10', due: '2026-06-10', category: 'صيانة', incorpItem: '', amortize: false,
  amortizeMonths: null, exempt: false, excludeFromVat: false, taxStatus: TS_DEDUCTIBLE,
  subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000, ...over,
} as PurchaseInput);

test('D-10 «حذف» فاتورة الشراء من شرطٍ واحد يرفض به الحذف نفسه · والمحوّلة إلى أصل لا يُعرض لها', () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
  db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S-D10', 'مورد مصطنع D10', '300000000000010', '2026-01-01')`);
  ownerCashIn(db, { amountHalalas: 1_000_000, date: '2026-05-01' });
  const unit = addUnit(db, addProperty(db, { name: 'عقار مصطنع D10' }), { unit_no: 'D10-1' });
  const plain = savePurchase(db, pur());
  expect(purchaseDeleteBlock(db, plain)).toBeNull();

  const conv = savePurchase(db, pur());
  convertPurchase(db, conv, [{ descr: 'مكيف مصطنع', qty: 1, amountHalalas: 100000, isAsset: true, category: '1410', unitId: unit }], '2026-05-20');
  expect(purchaseDeleteBlock(db, conv)).toBe(t('assets.err.purchaseLocked'));
  expect(() => deletePurchase(db, conv)).toThrow(t('assets.err.purchaseLocked'));

  const filed = savePurchase(db, pur());
  markVatFiled(db, filed);
  expect(purchaseDeleteBlock(db, filed)).toBe(t('purchase.filedLocked'));
  expect(() => deletePurchase(db, filed)).toThrow(t('purchase.filedLocked'));

  deletePurchase(db, plain);
  expect(db.get<{ d: string | null }>(`SELECT deleted_at AS d FROM purchases WHERE id = ?`, [plain])!.d).toBeTruthy();
  db.close();
});

test('D-10 بطاقة الشراء تعرض «حذف» بـ purchaseDeleteBlock · والحوارات تلتقط رفض الدومين', () => {
  const src = read('app', 'purchases.tsx');
  expect(src).toMatch(/deleteLocked=\{!!purchaseDeleteBlock\(db,\s*item\.id\)\}/);
  expect(src).toMatch(/canManage && !deleteLocked \? \{\s*icon: 'trash'/);
  // الحذف والتراجع عن السداد يلتقطان رفضهما بعنوانٍ يقول ما تعذّر
  const del = src.slice(src.indexOf('const doDelete'), src.indexOf('const vatFiled'));
  expect(del).toMatch(/try \{\s*deletePurchase\(/);
  expect(del).toMatch(/reportFailure\(/);
  const undo = src.slice(src.indexOf('const undoPay'), src.indexOf('const doDelete'));
  expect(undo).toMatch(/try \{\s*unmarkPurchasePaid\(/);
  expect(undo).toMatch(/reportFailure\(/);
  const journal = read('app', 'journal.tsx');
  const drop = journal.slice(journal.indexOf('const deleteDraft'), journal.indexOf('const postDraft'));
  expect(drop).toMatch(/try \{\s*voidEntryById\(/);
  expect(drop).toMatch(/reportFailure\(/);
});

test('D-10 زرّ الحوار يلتقط الرمي المتزامن والرفض غير المتزامن بحوار الفشل الموحَّد', () => {
  const src = read('src', 'ui', 'AppDialog.tsx');
  const btn = src.slice(src.indexOf('function DialogButton'), src.indexOf('function DialogActions'));
  // الاستدعاء داخل then فيصير رميُه رفضاً يُلتقط
  expect(btn).toMatch(/Promise\.resolve\(\)\.then\(\(\) => a\.onPress\?\.\(\)\)/);
  expect(btn).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  expect(btn).toMatch(/\.catch\(reportActionFailure\)/);
  const helper = src.slice(src.indexOf('function reportActionFailure'), src.indexOf('function DialogButton'));
  expect(helper).toMatch(/reportFailure\(\{\s*title:\s*t\('common\.failed'\),\s*e\s*\}\)/);
});
