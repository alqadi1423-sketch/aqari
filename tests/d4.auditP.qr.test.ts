/**
 * المدقق الخارجي P · الجولة الثامنة · قراءة فاتورة الشراء من رمزها كما هي في e5e16f5 (التوجيه الرابع ٦ · ١: «فواتير المشتريات: صورة أو PDF،
 * ورمز QR أولاً، وتُعرض معبأة للمراجعة ولا تُحفظ بلا تأكيد، والمكررة تُرفض»). منطق المجال وحده.
 * كل حالةٍ هنا تفشل على الكود الحالي وتمرّ حين يُصلح · البيانات مصطنعة كلها (أسماء وأرقام ضريبية ومبالغ ليست لأحد).
 *   TZ=Asia/Riyadh npx jest tests/auditP.qr.test.ts
 */
import { decodeZatcaQr, zatcaQrKey, type ZatcaQr } from '@/domain/zatcaQr';
import { purchaseDraftFromQr } from '@/domain/purchaseQr';
import { savePurchase, TS_EXCLUDED, type PurchaseInput } from '@/domain/purchases';
import { saveSupplier } from '@/domain/suppliers';
import { memDb } from './helpers/testDb';

const u8 = (v: string) => Array.from(new TextEncoder().encode(v));
const tlv = (pairs: Array<[number, string]>) =>
  Buffer.from(Uint8Array.from(pairs.flatMap(([t, v]) => { const b = u8(v); return [t, b.length, ...b]; }))).toString('base64');
const ok = (r: ReturnType<typeof decodeZatcaQr>): ZatcaQr => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r.qr; };
const sup = (name: string, vat: string) => ({ name, vat, phone: '', category: '', amountHalalas: null, utility: '' });
const input = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد مصطنع', date: '2026-11-01', due: '', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: true, taxStatus: TS_EXCLUDED, subtotalHalalas: 10000, taxHalalas: 1500, totalHalalas: 11500, ...over,
});
const log = (...a: unknown[]) => { /* eslint-disable-next-line no-console */ console.log(...a); };

describe('P١ · (جديد في e5e16f5) cardHasVat: بطاقةٌ «فيها» الرقم بين أرقامٍ أخرى تسبق بطاقةً رقمها هو الرقم نفسه واسمها اسم البائع', () => {
  test('الفاتورة تُنسب صامتةً إلى موردٍ آخر (بلا تنبيه) لأن byVat يأخذ أول بطاقةٍ فيها مقطعٌ بالرقم لا البطاقة المطابقة', () => {
    const db = memDb();
    // بطاقة أ (أقدم): رقمها ورقمٌ ثانٍ مفصولان بـ«/» (رقم المجموعة الضريبية مثلاً) · بطاقة ب: رقمها هو رقم البائع حرفاً بحرف واسمها اسمه
    const a = saveSupplier(db, null, sup('مؤسسة الواحة المصطنعة', '300000000000003 / 311111111111113'));
    const b = saveSupplier(db, null, sup('شركة النخبة المصطنعة', '311111111111113'));
    db.run(`UPDATE suppliers SET created_at = ? WHERE id = ?`, ['2026-01-01T00:00:00.000Z', a]);
    db.run(`UPDATE suppliers SET created_at = ? WHERE id = ?`, ['2026-02-01T00:00:00.000Z', b]);
    const qr = ok(decodeZatcaQr(tlv([[1, 'شركة النخبة المصطنعة'], [2, '311111111111113'], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']])));
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    log('P1 · المسودة:', JSON.stringify({ supplier: d.supplier, supplierId: d.supplierId === a ? 'أ' : d.supplierId === b ? 'ب' : d.supplierId, warnings: d.warnings }));
    // المتوقع: البطاقة التي رقمها رقم البائع نفسه (واسمها اسمه) أولى من بطاقةٍ رقمه أحد أرقامها
    expect(d.supplierId).toBe(b);
    expect(d.supplier).toBe('شركة النخبة المصطنعة');
  });
});

describe('P٢ · cardHasVat: الرقم الضريبي ومعه السجل التجاري بشرطةٍ أو مسافة («V - CR» و«V CR») لا يُعرف رقماً للبطاقة', () => {
  test.each([['شرطة', '300000000000003 - 1010101010'], ['مسافة', '300000000000003 1010101010']])(
    'بطاقة باسم البائع ورقمه ثم السجل بـ%s: تنبيه «رقمٌ ضريبي آخر» ويُقترح موردٌ ثانٍ', (_n, cardVat) => {
      const db = memDb();
      const id = saveSupplier(db, null, sup('مؤسسة مصطنعة للتوريد', cardVat));
      const qr = ok(decodeZatcaQr(tlv([[1, 'مؤسسة مصطنعة للتوريد'], [2, '300000000000003'], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']])));
      const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
      log('P2', _n, '· المسودة:', JSON.stringify({ supplier: d.supplier, known: d.supplierId === id, newSupplierVat: d.newSupplierVat, warnings: d.warnings }));
      expect(d.supplierId).toBe(id);
      expect(d.warnings).not.toContain('supplierVat');
    });

  test('واسم البائع التجاري يخالف اسم البطاقة: «ليس في الموردين» و«إضافة المورد» تصنع بطاقةً ثانية بالرقم نفسه', () => {
    const db = memDb();
    saveSupplier(db, null, sup('شركة التجهيزات المصطنعة', '300000000000003 - 1010101010'));
    const qr = ok(decodeZatcaQr(tlv([[1, 'متجر التجهيزات المصطنع'], [2, '300000000000003'], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']])));
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    // كما يفعل الزر الأساسي «إضافة المورد» في الشاشة (purchases.tsx:446)
    if (!d.supplierId) saveSupplier(db, null, sup(d.supplier, d.newSupplierVat ?? ''));
    const cards = db.all<{ name: string; vat: string }>(`SELECT name, vat FROM suppliers WHERE deleted_at IS NULL AND vat LIKE '%300000000000003%'`);
    log('P2 · البطاقات بالرقم نفسه:', JSON.stringify(cards));
    expect(cards.length).toBe(1);
  });
});

describe('P٣ · علامة الاتجاه العربية (ALM · U+061C) ومحرف العرض الصفري (U+200B) حول رقم البائع: «ليس بصيغة الهيئة»', () => {
  test.each([['U+061C', '؜300000000000003'], ['U+200B', '300000000000003​']])(
    'رقم الرمز ومعه %s: تنبيه vatNo، والمورد المسجّل بالرقم لا يُعرف، ويُضاف موردٌ مكرر بلا رقم ضريبي', (_n, vatInQr) => {
      const db = memDb();
      const id = saveSupplier(db, null, sup('شركة التجهيزات المصطنعة', '300000000000003'));
      const qr = ok(decodeZatcaQr(tlv([[1, 'متجر التجهيزات المصطنع'], [2, vatInQr], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']])));
      const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
      log('P3', _n, '· التنبيهات:', qr.warnings, '· المسودة:', JSON.stringify({ supplier: d.supplier, known: d.supplierId === id, newSupplierVat: d.newSupplierVat }));
      // المتوقع: كإصلاح N٢ لـU+200E/U+200F — وU+061C من علامات الاتجاه (Bidi_Control) نفسها
      expect(qr.warnings).not.toContain('vatNo');
      expect(d.supplierId).toBe(id);
    });
});

describe('P٤ · اسم البائع من علامات اتجاهٍ أو محارف صفرية وحدها يُقرأ «فاتورة» ويُقترح موردٌ بلا اسمٍ مرئي', () => {
  test.each([['U+200F', '‏'], ['U+061C', '؜'], ['U+200B', '​'], ['عزل الاتجاه', '⁧⁩']])('الوسم ١ = %s', (_n, seller) => {
    const db = memDb();
    const r = decodeZatcaQr(tlv([[1, seller], [2, '300000000000003'], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']]));
    let added = '';
    if (r.ok) {
      const d = purchaseDraftFromQr(db, r.qr, () => '2026-11-07');
      try { saveSupplier(db, null, sup(d.supplier, d.newSupplierVat ?? '')); added = 'أُضيف'; } catch (e) { added = (e as Error).message; }
    }
    const names = db.all<{ name: string }>(`SELECT name FROM suppliers`).map((s) => s.name.split('').map((c) => 'U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' '));
    log('P4', _n, '· القراءة:', r.ok ? 'فاتورة' : r.error, '· إضافة المورد:', added || '—', '· أسماء الموردين:', JSON.stringify(names));
    // المتوقع: كإصلاح N٣ — اسمٌ لا يُرى «ناقص» (missing)
    expect(r.ok ? 'ok' : r.error).toBe('missing');
  });
});

describe('P٤ب · علامة اتجاهٍ حول اسم البائع (كما حول رقمه في N٢) لا تُهمل في المطابقة بالاسم، فتُضاف بطاقةٌ ثانية باسمٍ يبدو نفسه', () => {
  test('بطاقةٌ بلا رقمٍ ضريبي باسم البائع، والرمز «U+200F + الاسم»: «ليس في الموردين» و«إضافة المورد» تصنع بطاقتين متطابقتين في العين', () => {
    const db = memDb();
    const id = saveSupplier(db, null, sup('مؤسسة الأمانة المصطنعة', ''));
    const qr = ok(decodeZatcaQr(tlv([[1, '\u200Fمؤسسة الأمانة المصطنعة'], [2, '300000000000003'], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']])));
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    if (!d.supplierId) saveSupplier(db, null, sup(d.supplier, d.newSupplierVat ?? ''));
    const looks = db.all<{ name: string }>(`SELECT name FROM suppliers WHERE deleted_at IS NULL`).map((s) => s.name.replace(/[\u200E\u200F\u061C]/g, ''));
    log('P4b · المسودة:', JSON.stringify({ known: d.supplierId === id, newSupplierVat: d.newSupplierVat }), '· أسماء الموردين كما تُرى:', JSON.stringify(looks));
    expect(d.supplierId).toBe(id);
    expect(new Set(looks).size).toBe(looks.length);
  });
});

describe('P٥ · علامة اتجاهٍ حول وقت الإصدار: الوقت «لا يُقرأ»، فالتاريخ اليوم والمفتاح فارغ، والفاتورة نفسها تُحفظ مرتين', () => {
  test.each([['U+200F قبله', '‏2026-11-01T09:15:42'], ['U+200E بعده', '2026-11-01T09:15:42‎']])('%s', (_n, at) => {
    const db = memDb();
    const qr = ok(decodeZatcaQr(tlv([[1, 'مورد مصطنع'], [2, '300000000000003'], [3, at], [4, '115.00'], [5, '15.00']])));
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    const key = zatcaQrKey(qr);
    // القراءة الأولى تُحفظ، ثم يُقرأ الرمز نفسه مرةً ثانية ويُحفظ (purchases.tsx: purchaseByQrKey ثم savePurchase بالمفتاح)
    const saved: string[] = [];
    for (let i = 0; i < 2; i++) {
      try { savePurchase(db, input({ date: d.date, qrKey: key || undefined })); saved.push('حُفظت'); } catch (e) { saved.push('رُفضت: ' + (e as Error).message); }
    }
    log('P5', _n, '· التنبيهات:', qr.warnings, '· التاريخ:', d.date, '· المفتاح:', JSON.stringify(key), '· الحفظ مرتين:', saved);
    // المتوقع: العلامة لا تُعدّ من الوقت (كما لا تُعدّ من الرقم منذ N٢)، فالتاريخ 2026-11-01 والمكررة تُرفض
    expect(qr.warnings).not.toContain('issuedAt');
    expect(d.date).toBe('2026-11-01');
    expect(saved[1]).toMatch(/^رُفضت/);
  });
});
