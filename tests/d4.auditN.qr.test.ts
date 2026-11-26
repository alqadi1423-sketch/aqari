/**
 * المدقق الخارجي N · الجولة السابعة · قراءة فاتورة الشراء من رمزها كما هي في 2cf6151 (التوجيه الرابع ٦ · ١: «فواتير المشتريات: صورة أو PDF،
 * ورمز QR أولاً، وتُعرض معبأة للمراجعة ولا تُحفظ بلا تأكيد، والمكررة تُرفض»). منطق المجال وحده.
 * كل حالةٍ هنا تفشل على الكود الحالي وتمرّ حين يُصلح · البيانات مصطنعة كلها (أسماء وأرقام ضريبية ومبالغ ليست لأحد).
 *   TZ=Asia/Riyadh npx jest tests/auditN.qr.test.ts
 */
import fs from 'fs';
import path from 'path';
import { decodeZatcaQr, zatcaQrKey, type ZatcaQr } from '@/domain/zatcaQr';
import { purchaseDraftFromQr } from '@/domain/purchaseQr';
import { savePurchase, deletePurchase, TS_EXCLUDED, type PurchaseInput } from '@/domain/purchases';
import { saveSupplier } from '@/domain/suppliers';
import { restoreAllFromTrash, trashItems } from '@/domain/trash';
import { memDb } from './helpers/testDb';

const u8 = (v: string) => Array.from(new TextEncoder().encode(v));
const tlv = (pairs: Array<[number, string]>) =>
  Buffer.from(Uint8Array.from(pairs.flatMap(([t, v]) => { const b = u8(v); return [t, b.length, ...b]; }))).toString('base64');
const ok = (r: ReturnType<typeof decodeZatcaQr>): ZatcaQr => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r.qr; };
const input = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد مصطنع', date: '2026-11-01', due: '', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: true, taxStatus: TS_EXCLUDED, subtotalHalalas: 10000, taxHalalas: 1500, totalHalalas: 11500, ...over,
});
const sup = (name: string, vat: string) => ({ name, vat, phone: '', category: '', amountHalalas: null, utility: '' });
const log = (...a: unknown[]) => { /* eslint-disable-next-line no-console */ console.log(...a); };

describe('N١ · رقم البطاقة فيه رقم البائع ومعه رقمٌ آخر (السجل التجاري) يُعدّ «رقماً ضريبياً آخر»', () => {
  test('بطاقة «300000000000003 / س.ت 1010101010» باسم البائع نفسه: يُقترح موردٌ ثانٍ «الاسم · الرقم» بتنبيهٍ خاطئ، وإضافته تصنع بطاقةً ثانية', () => {
    const db = memDb();
    const id = saveSupplier(db, null, sup('مؤسسة مصطنعة للتوريد', '300000000000003 / س.ت 1010101010'));
    const qr = ok(decodeZatcaQr(tlv([[1, 'مؤسسة مصطنعة للتوريد'], [2, '300000000000003'], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']])));
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    // كما يفعل الزر الأساسي «إضافة المورد» في الشاشة (purchases.tsx: saveSupplier باسم المسودة ورقمها)
    let added = '';
    if (!d.supplierId) { try { saveSupplier(db, null, sup(d.supplier, d.newSupplierVat ?? '')); added = 'أُضيف'; } catch (e) { added = (e as Error).message; } }
    const cards = db.all<{ name: string; vat: string }>(`SELECT name, vat FROM suppliers WHERE deleted_at IS NULL AND vat LIKE '%300000000000003%' ORDER BY created_at`);
    log('N1 · المسودة:', JSON.stringify(d), '· إضافة المورد:', added || '—', '· البطاقات:', JSON.stringify(cards));
    // المتوقع: البطاقة تحمل رقم البائع نفسه (رقمٌ ضريبي بصيغة الهيئة داخلها) فتُنسب إليها المسودة بلا تنبيه «رقمٍ آخر» ولا بطاقةٍ ثانية
    expect(d.supplierId).toBe(id);
    expect(d.warnings).not.toContain('supplierVat');
  });
});

describe('N٢ · رقم البائع في الرمز بعلامة اتجاهٍ لا تُرى: «ليس بصيغة الهيئة»، فلا يُطابَق بطاقته ويُقترح موردٌ بلا رقم', () => {
  test.each([['U+200F', '‏300000000000003'], ['U+200E', '300000000000003‎']])(
    'رقم الرمز وقبله أو بعده %s: تنبيه vatNo، والمورد المسجّل بالرقم نفسه لا يُعرف، ويُضاف موردٌ مكرر بلا رقم ضريبي', (_n, vatInQr) => {
      const db = memDb();
      const id = saveSupplier(db, null, sup('شركة التجهيزات المصطنعة', '300000000000003'));
      // الاسم التجاري في الرمز يخالف اسم البطاقة (كثيراً ما يكون)، فلا يبقى إلا الرقم
      const qr = ok(decodeZatcaQr(tlv([[1, 'متجر التجهيزات المصطنع'], [2, vatInQr], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']])));
      const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
      let added = '';
      if (!d.supplierId) { try { saveSupplier(db, null, sup(d.supplier, d.newSupplierVat ?? '')); added = 'أُضيف'; } catch (e) { added = (e as Error).message; } }
      const cards = db.all<{ name: string; vat: string }>(`SELECT name, vat FROM suppliers WHERE deleted_at IS NULL ORDER BY created_at`);
      log('N2', _n, '· التنبيهات:', qr.warnings, '· المسودة:', JSON.stringify({ supplier: d.supplier, supplierId: d.supplierId, newSupplierVat: d.newSupplierVat }),
        '· إضافة المورد:', added || '—', '· البطاقات:', JSON.stringify(cards));
      // المتوقع: علامة الاتجاه تُهمل في الرمز كما تُهمل في البطاقة منذ إصلاح L٣ (normVat)، فيُعرف المورد برقمه
      expect(qr.warnings).not.toContain('vatNo');
      expect(d.supplierId).toBe(id);
    });
});

describe('N٣ · اسم البائع فارغ في الرمز يُقرأ «فاتورة»، ويُقترح موردٌ بلا اسم، و«إضافة المورد» تفشل بتقرير عطل', () => {
  test.each([['فارغ', ''], ['مسافات', '   ']])('الوسم ١ %s', (_n, seller) => {
    const db = memDb();
    const r = decodeZatcaQr(tlv([[1, seller], [2, '300000000000003'], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']]));
    let draft: ReturnType<typeof purchaseDraftFromQr> | null = null;
    let add = '';
    if (r.ok) {
      draft = purchaseDraftFromQr(db, r.qr, () => '2026-11-07');
      // الشاشة: حوار «موردٌ غير مسجّل» بـ«{{name}}» فارغ، وزره الأساسي saveSupplier (purchases.tsx:436) ثم reportFailure عند الرمي
      try { saveSupplier(db, null, sup(draft.supplier, draft.newSupplierVat ?? '')); add = 'أُضيف'; } catch (e) { add = (e as Error).message; }
    }
    log('N3', _n, '· القراءة:', JSON.stringify(r), '· المسودة:', JSON.stringify(draft), '· إضافة المورد:', add);
    // المتوقع: رمزٌ بلا اسم بائع «ناقص» (missing) كما يقول نصّه «لا يحمل اسم البائع…»، ولا يُقترح موردٌ بلا اسم
    const proposesNameless = !!draft && !draft.supplierId && draft.supplier.trim() === '';
    expect(proposesNameless).toBe(false);
  });
});

describe('N٤ · «استعادة الكل» تقول «تمت استعادة جميع العناصر بنجاح» والفاتورة المكررة باقيةٌ في السلة', () => {
  test('فاتورةٌ من رمزها حُذفت ثم سُجّلت من الرمز نفسه: الاستعادة الجماعية تتخطّاها صامتة، والشاشة تعلن نجاح الكل', async () => {
    const db = memDb();
    const qr = ok(decodeZatcaQr(tlv([[1, 'مورد مصطنع'], [2, '300000000000003'], [3, '2026-11-01T09:15:42'], [4, '115.00'], [5, '15.00']])));
    const key = zatcaQrKey(qr);
    const a = savePurchase(db, input({ qrKey: key }));
    deletePurchase(db, a);
    // تُقرأ الفاتورة نفسها من رمزها وتُسجَّل (ما في السلة لا يمنع · DESIGN §١٣.٢١)
    savePurchase(db, input({ qrKey: key }));
    const before = trashItems(db).length;
    const restored = await restoreAllFromTrash(db);
    const after = trashItems(db).length;
    // الشاشة: settings.tsx «استعادة الكل» — await restoreAllFromTrash(...) ثم toast('تمت استعادة جميع العناصر بنجاح') بلا نظرٍ في العدد
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'settings.tsx'), 'utf8');
    const handler = /await restoreAllFromTrash\([^\n]*\);\s*\n\s*toast\('([^']*)'\);/.exec(src);
    log('N4 · في السلة قبل:', before, '· المستعاد:', restored, '· في السلة بعد:', after, '· رسالة الشاشة:', handler?.[1] ?? '(تغيّرت)');
    expect(restored).toBe(0);
    expect(after).toBe(1);
    // المتوقع: الشاشة تقول ما استُعيد وما بقي وسببه، لا «جميع العناصر بنجاح»
    expect(handler).toBeNull();
  });
});
