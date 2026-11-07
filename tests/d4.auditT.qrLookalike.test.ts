/**
 * المدقق الخارجي T · الجولة العاشرة · «الشبيهة» (purchaseLookalike · إصلاح R٣ في 7e3b492) بين فاتورة الرمز وما سُجّل بلا مفتاح ·
 * منطق المجال وحده (ما تفحصه شاشة القراءة قبل التعبئة وما تفحصه الاستعادة) · كل حالةٍ تفشل على 7e3b492 وتمرّ حين يُصلح · بياناتٌ مصطنعة.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditT.qrLookalike.test.ts
 */
import { decodeZatcaQr, zatcaQrKey, type ZatcaQr } from '@/domain/zatcaQr';
import { purchaseDraftFromQr } from '@/domain/purchaseQr';
import { savePurchase, purchaseByQrKey, purchaseLookalike, deletePurchase, restorePurchase, TS_EXCLUDED, type PurchaseInput } from '@/domain/purchases';
import { saveSupplier } from '@/domain/suppliers';
import { restoreAllFromTrash } from '@/domain/trash';
import { memDb } from './helpers/testDb';

const u8 = (v: string) => Array.from(new TextEncoder().encode(v));
const tlv = (pairs: Array<[number, string]>) =>
  Buffer.from(Uint8Array.from(pairs.flatMap(([t, v]) => { const b = u8(v); return [t, b.length, ...b]; }))).toString('base64');
const ok = (r: ReturnType<typeof decodeZatcaQr>): ZatcaQr => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r.qr; };
const sup = (name: string, vat: string) => ({ name, vat, phone: '', category: '', amountHalalas: null, utility: '' });
const input = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد مصطنع', date: '2026-11-01', due: '', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: true, taxStatus: TS_EXCLUDED, subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000, ...over,
});
/** ما يفحصه fillFromQr قبل التعبئة (purchases.tsx:413-414 و465) · null = تُعبَّأ بلا سؤال */
const uiCheck = (db: ReturnType<typeof memDb>, qr: ZatcaQr) => {
  const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
  return purchaseByQrKey(db, zatcaQrKey(qr))
    ?? purchaseLookalike(db, { vat: qr.vatNo, seller: qr.sellerName, date: d.date, total: d.totalHalalas, tax: d.taxHalalas });
};
const live = (db: ReturnType<typeof memDb>) => db.all<{ no: string; supplier_name: string; qr_key: string }>(
  `SELECT no, supplier_name, qr_key FROM purchases WHERE deleted_at IS NULL ORDER BY created_at`);
const log = (...a: unknown[]) => { /* eslint-disable-next-line no-console */ console.log(...a); };

// فاتورةٌ واحدة من بائعٍ اسمه النظامي في الرمز غير الاسم التجاري الذي يعرفه به المحاسب
const QR = () => ok(decodeZatcaQr(tlv([[1, 'شركة الأسواق المتحدة المصطنعة'], [2, '300000000000003'], [3, '2026-11-01T19:42:10+03:00'], [4, '1150.00'], [5, '150.00']])));

describe('T٢ · الشبيهة تشترط رقم البائع في بطاقة المورد أو اسمه حرفاً: الفاتورة اليدوية باسمٍ تجاري وبطاقةٍ بلا رقم لا تُرى، فتُسجَّل مرتين بلا سؤال', () => {
  test('بطاقة «أسواق النخلة المصطنعة» بلا رقم ضريبي (الفاتورة اليدوية «غير قابلة للخصم» لا تطلبه) ثم يُقرأ رمز الفاتورة نفسها', () => {
    const db = memDb();
    saveSupplier(db, null, sup('أسواق النخلة المصطنعة', ''));
    // سجّلها المحاسب يدوياً: اليوم نفسه والإجمالي والضريبة نفسهما
    savePurchase(db, input({ supplier: 'أسواق النخلة المصطنعة', date: '2026-11-01' }));
    const qr = QR();
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    const seen = uiCheck(db, qr);
    // ثم «إضافة المورد» فالحفظ (ما تفعله الشاشة حين لا سؤال)
    if (!d.supplierId) saveSupplier(db, null, sup(d.supplier, d.newSupplierVat ?? ''));
    savePurchase(db, input({ supplier: d.supplier, date: d.date, qrKey: zatcaQrKey(qr) }));
    log('T2 · المسودة:', JSON.stringify({ supplier: d.supplier, supplierId: d.supplierId, newSupplierVat: d.newSupplierVat }),
      '· فحص الشاشة قبل التعبئة:', JSON.stringify(seen), '· الحيّة:', JSON.stringify(live(db)));
    // المتوقع: فاتورةٌ بلا مفتاح في اليوم نفسه بالإجمالي والضريبة نفسيهما لموردٍ لا رقم في بطاقته (فلا يُعرف أهو البائع أم لا) يُسأل عنها
    // «قد تكون مسجّلةً من قبل» · السؤال نقرةٌ واحدة، وغيابه تسجيلٌ مكرَّر صامت للمصروف والضريبة
    expect(seen).not.toBeNull();
  });
});

describe('T٣ · الاستعادة من السلة لا ترى الشبيهة: rejectDuplicateQr يمرّر غير التامة، ولا شاشة تسأل في الاستعادة', () => {
  test('أ · فاتورةٌ يدوية حُذفت ليُعاد تسجيلها من رمزها (مع صورتها ومفتاحها)، ثم «استعادة الكل» من السلة: نسختان حيّتان', async () => {
    const db = memDb();
    saveSupplier(db, null, sup('شركة الأسواق المتحدة المصطنعة', '300000000000003'));
    const manual = savePurchase(db, input({ supplier: 'شركة الأسواق المتحدة المصطنعة' }));
    deletePurchase(db, manual);
    const qr = QR();
    // الشاشة لا تجد شبيهة (اليدوية في السلة) فتُعبّأ وتُحفظ بمفتاحها
    const before = uiCheck(db, qr);
    savePurchase(db, input({ supplier: 'شركة الأسواق المتحدة المصطنعة', qrKey: zatcaQrKey(qr) }));
    const restored = await restoreAllFromTrash(db);
    log('T3أ · فحص الشاشة (اليدوية في السلة):', JSON.stringify(before), '· المستعاد:', restored, '· الحيّة:', JSON.stringify(live(db)));
    // المتوقع: لا تعود اليدوية فوق فاتورة الرمز الشبيهة بها بلا كلمة (تُرفض كما تُرفض المطابقة التامة، أو تُسأل)
    expect(live(db)).toHaveLength(1);
  });

  test('ب · والعكس: فاتورة الرمز في السلة تعود فوق نسختها اليدوية الحيّة (rejectDuplicateQr: «if (dup && !dup.exact) return»)', () => {
    const db = memDb();
    saveSupplier(db, null, sup('شركة الأسواق المتحدة المصطنعة', '300000000000003'));
    const qr = QR();
    const fromQr = savePurchase(db, input({ supplier: 'شركة الأسواق المتحدة المصطنعة', qrKey: zatcaQrKey(qr) }));
    deletePurchase(db, fromQr);
    savePurchase(db, input({ supplier: 'شركة الأسواق المتحدة المصطنعة' }));
    let r = 'استُعيدت';
    try { restorePurchase(db, fromQr); } catch (e) { r = 'رُفضت: ' + (e as Error).message; }
    const like = purchaseByQrKey(db, zatcaQrKey(qr), fromQr);
    log('T3ب · الشبيهة التي يجدها purchaseByQrKey:', JSON.stringify(like), '· الاستعادة:', r, '· الحيّة:', JSON.stringify(live(db)));
    expect(like?.exact).toBe(false);
    // المتوقع: الشبيهة التي تُسأل عنها الشاشة قبل التعبئة لا تمرّ صامتةً في الاستعادة
    expect(r).toMatch(/^رُفضت/);
  });
});
