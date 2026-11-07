/**
 * المدقق الخارجي J · الجولة الخامسة · قراءة فاتورة الشراء من رمزها كما هي في 662e4ae (e34d88c · التوجيه الرابع ٦ · ١:
 * «فواتير المشتريات: صورة أو PDF، ورمز QR أولاً، وتُعرض معبأة للمراجعة ولا تُحفظ بلا تأكيد، والمكررة تُرفض»).
 * كل حالةٍ هنا تفشل على الكود الحالي، وتمرّ حين يُصلح · البيانات مصطنعة كلها (أسماء وأرقام ضريبية ومبالغ ليست لأحد).
 *   TZ=Asia/Riyadh npx jest tests/auditJ.qr.test.ts
 */
import fs from 'fs';
import path from 'path';
import { deflateSync } from 'fflate';
import { decodeZatcaQr, pickZatcaQr, type ZatcaQr } from '@/domain/zatcaQr';
import { purchaseDraftFromQr } from '@/domain/purchaseQr';
import { qrFromInvoiceXml, qrValuesFromInvoiceFile } from '@/domain/invoiceFile';
import { zatcaTlvBase64 } from '@/domain/printDocs';
import { savePurchase, TS_DEDUCTIBLE, type PurchaseInput } from '@/domain/purchases';
import { saveSupplier } from '@/domain/suppliers';
import { memDb } from './helpers/testDb';

/** TLV كما تشترطه الهيئة: وسمٌ بايت، طولٌ بايت، القيمة UTF-8 */
const tlv = (pairs: Array<[number, string]>) => {
  const out: number[] = [];
  for (const [t, v] of pairs) {
    const b = Array.from(new TextEncoder().encode(v));
    out.push(t, b.length, ...b);
  }
  return Buffer.from(Uint8Array.from(out)).toString('base64');
};
const ok = (r: ReturnType<typeof decodeZatcaQr>): ZatcaQr => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r.qr; };

describe('J١ · المورد بالاسم ورقمه الضريبي يخالف رقم الرمز', () => {
  test('فاتورة بائعٍ رقمه ٣٢٢… تُنسب صامتةً لموردٍ مسجّلٍ بالاسم نفسه ورقمٍ آخر ٣١١…، فتُحفظ «قابلة للخصم» برقمٍ ليس رقم البائع', () => {
    const db = memDb();
    db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
    // موردٌ مسجّل برقمه (ليس «بلا رقم» الذي أراده التعليق في purchaseQr.ts:25)
    db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S-J1', 'مؤسسة مصطنعة للتوريد', '311111111111113', '2026-01-01T00:00:00.000Z')`);
    // وفاتورة بائعٍ آخر بالاسم التجاري نفسه ورقمٍ ضريبي آخر (فرعٌ أو منشأةٌ أخرى)
    const qr = ok(decodeZatcaQr(tlv([[1, 'مؤسسة مصطنعة للتوريد'], [2, '322222222222223'], [3, '2026-11-01T09:00:00Z'], [4, '1150.00'], [5, '150.00']])));
    const d = purchaseDraftFromQr(db, qr);
    // eslint-disable-next-line no-console
    console.log('J1 · المسودة:', JSON.stringify(d));
    // وكما تفعل الشاشة (purchases.tsx «إضافة المورد» بعد إصلاح J١): المورد المقترح برقم البائع يُضاف ثم تُحفظ الفاتورة باسمه
    if (!d.supplierId && d.newSupplierVat) {
      saveSupplier(db, null, { name: d.supplier, vat: d.newSupplierVat, phone: '', category: '', amountHalalas: null, utility: '' });
    }
    const input: PurchaseInput = {
      supplier: d.supplier, date: d.date, due: '', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
      exempt: false, excludeFromVat: false, taxStatus: TS_DEDUCTIBLE,
      subtotalHalalas: d.subtotalHalalas, taxHalalas: d.taxHalalas, totalHalalas: d.totalHalalas,
    };
    const id = savePurchase(db, input);
    const saved = db.get<{ v: string }>(`SELECT supplier_vatno AS v FROM purchases WHERE id = ?`, [id])!.v;
    // eslint-disable-next-line no-console
    console.log('J1 · رقم البائع في الرمز:', qr.vatNo, '· الرقم المحفوظ مع الفاتورة:', saved);
    // المتوقع: لا يُنسب للمورد بالاسم ورقمه يخالف رقم الرمز (أو يُنبَّه على الأقل) · فلا يُحفظ رقمٌ ضريبي ليس رقم البائع
    expect(d.supplierId === null || d.warnings.length > 0).toBe(true);
    expect(saved).toBe(qr.vatNo);
  });
});

describe('J٢ · وقت الإصدار بلا منطقة زمنية (صيغة المرحلة الثانية: IssueDate + IssueTime)', () => {
  test('22:30 من آخر يومٍ في الربع الثالث يصير 1 أكتوبر: الوقت بلا منطقة يُقرأ UTC ويُزاد ثلاث ساعات', () => {
    const db = memDb();
    // كما في اختبار المرحلة الثانية نفسه (tests/d6.zatcaQr.test.ts:37) وقتٌ بلا Z
    const qr = ok(decodeZatcaQr(tlv([[1, 'مورد مصطنع'], [2, '300000000000003'], [3, '2026-09-30T22:30:00'], [4, '230.00'], [5, '30.00']])));
    expect(qr.warnings).toEqual([]);
    const d = purchaseDraftFromQr(db, qr);
    // eslint-disable-next-line no-console
    console.log('J2 · الوقت في الرمز:', qr.issuedAt, '· تاريخ المسودة:', d.date, '· ونفسه بـ Date في JS (محلي حسب ISO 8601 وECMAScript):',
      new Date(qr.issuedAt).toString());
    // ISO 8601 (وECMAScript لصيغة التاريخ والوقت) وقتٌ بلا منطقة وقتٌ محلي · فيوم الفاتورة 30 سبتمبر (الربع الثالث)
    expect(d.date).toBe('2026-09-30');
  });
});

describe('J٣ · فاصلة عشرية تُحذف كأنها فاصل آلاف', () => {
  test('«115,00» تُقرأ 11500.00 ريال (مئة ضعف) بلا أي تنبيه، لأن نسبة الضريبة بقيت ١٥٪', () => {
    const q = ok(decodeZatcaQr(tlv([[1, 'مورد مصطنع'], [2, '300000000000003'], [3, '2026-11-01T09:00:00Z'], [4, '115,00'], [5, '15,00']])));
    // eslint-disable-next-line no-console
    console.log('J3 · الإجمالي:', q.totalHalalas / 100, '· الضريبة:', q.vatHalalas / 100, '· التنبيهات:', q.warnings);
    // فاصل الآلاف يفصل ثلاث خانات · «115,00» ليست ألوفاً: إما تُقرأ 115.00 أو تُرفض/يُنبَّه عليها، لا 11500
    expect(q.totalHalalas === 11500 || q.warnings.length > 0).toBe(true);
  });
});

describe('J٤ · الأرقام العربية الهندية', () => {
  test('«١١٥٠٫٠٠» تُرفض «ليس رمز فاتورة ضريبية» مع أن الكود يعالج فاصلَيها العربيين، والتطبيق نفسه يقرؤها (toHalalas)', () => {
    const r = decodeZatcaQr(tlv([[1, 'مورد مصطنع'], [2, '300000000000003'], [3, '2026-11-01T09:00:00Z'], [4, '١١٥٠٫٠٠'], [5, '١٥٠٫٠٠']]));
    // eslint-disable-next-line no-console
    console.log('J4 · النتيجة:', JSON.stringify(r));
    expect(r.ok && r.qr.totalHalalas).toBe(115000);
  });
});

describe('J٥ · رقم المورد الضريبي بأرقامٍ عربية هندية في بطاقته', () => {
  test('لا يُطابَق برقم الرمز، فيُقترح «مورد غير مسجّل» ويُضاف موردٌ ثانٍ بالرقم الضريبي نفسه', () => {
    const db = memDb();
    // أُدخل الرقم من لوحة مفاتيح عربية (حقل الرقم الضريبي في suppliers.tsx:289 لا يطبّع الأرقام، وsaveSupplier لا يطبّعها)
    saveSupplier(db, null, { name: 'مؤسسة مصطنعة', vat: '٣٠٠٠٠٠٠٠٠٠٠٠٠٠٣', phone: '', category: '', amountHalalas: null, utility: '' });
    // والرمز يحمل الاسم الرسمي المسجّل والرقم نفسه بأرقامٍ لاتينية
    const qr = ok(decodeZatcaQr(tlv([[1, 'مؤسسة مصطنعة للتجارة المحدودة'], [2, '300000000000003'], [3, '2026-11-01T09:00:00Z'], [4, '1150.00'], [5, '150.00']])));
    const d = purchaseDraftFromQr(db, qr);
    // كما في purchases.tsx «إضافة المورد»
    let added = '';
    if (!d.supplierId) {
      try { saveSupplier(db, null, { name: d.supplier, vat: d.newSupplierVat ?? '', phone: '', category: '', amountHalalas: null, utility: '' }); added = 'أُضيف'; }
      catch (e) { added = 'رُفض: ' + (e as Error).message; }
    }
    const rows = db.all<{ name: string; vat: string }>(`SELECT name, vat FROM suppliers WHERE deleted_at IS NULL ORDER BY created_at`);
    // eslint-disable-next-line no-console
    console.log('J5 · المسودة:', JSON.stringify(d), '· إضافة المورد:', added, '· الموردون:', JSON.stringify(rows));
    expect(d.supplierId).not.toBeNull();
  });
});

describe('J٦ · إشعار دائن (InvoiceTypeCode 381) يُعبَّأ فاتورة شراء', () => {
  test('ملف XML لإشعارٍ دائن من المورد يُقرأ كفاتورة شراء بمبالغ موجبة بلا أي تنبيه، فيُزاد المصروف وضريبة المدخلات بدل أن ينقصا', () => {
    const QR = zatcaTlvBase64('مورد مصطنع', '300000000000003', '2026-11-03T11:00:00Z', 23000, 3000);
    // فواتير الهيئة كلها بجذر Invoice، والنوع في InvoiceTypeCode: 388 فاتورة ضريبية، 381 إشعار دائن، 383 إشعار مدين
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:cbc" xmlns:cac="urn:cac">
  <cbc:ID>CN-0001</cbc:ID>
  <cbc:InvoiceTypeCode name="0100000">381</cbc:InvoiceTypeCode>
  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>INV-0001</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>
  <cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment>
    <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${QR}</cbc:EmbeddedDocumentBinaryObject>
  </cac:Attachment></cac:AdditionalDocumentReference>
</Invoice>`;
    const r = pickZatcaQr(qrValuesFromInvoiceFile(new TextEncoder().encode(xml), 'credit-note.xml', 'text/xml'));
    // eslint-disable-next-line no-console
    console.log('J6 · نتيجة قراءة الإشعار الدائن:', JSON.stringify(r));
    // المتوقع: لا يُعبَّأ إشعارٌ دائن فاتورةَ شراء (يُرفض أو يُنبَّه)
    expect(r.ok && r.qr.warnings.length === 0).toBe(false);
  });
});

describe('J٧ · PDF/A-3 يضمّن الملف بلا «/Type /EmbeddedFile» (اختياري في المواصفة)', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const latin = (b: Uint8Array) => Array.from(b, (x) => String.fromCharCode(x)).join('');
  test('ملفٌ مضمّن صحيح بمواصفة PDF (الجدول ٤٤ في ISO 32000-1: Type اختياري) ومواصفة PDF/A-3 (Subtype إلزامي) لا يُقرأ', () => {
    const QR = zatcaTlvBase64('مورد مصطنع', '300000000000003', '2026-11-02T10:15:30Z', 230000, 30000);
    const xml = `<Invoice><cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${QR}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference></Invoice>`;
    const z = deflateSync(enc(xml));
    const pdf = [
      '%PDF-1.7\n',
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(invoice.xml) 5 0 R] >> >> /AF [5 0 R] >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n',
      `4 0 obj\n<< /Subtype /text#2Fxml /Filter /FlateDecode /Length ${z.length} /Params << /Size ${xml.length} >> >>\nstream\n` + latin(z) + '\nendstream\nendobj\n',
      '5 0 obj\n<< /Type /Filespec /F (invoice.xml) /UF (invoice.xml) /AFRelationship /Alternative /EF << /F 4 0 R /UF 4 0 R >> >>\nendobj\n',
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
    ].join('');
    const values = qrValuesFromInvoiceFile(Uint8Array.from(pdf, (c) => c.charCodeAt(0)), 'invoice.pdf', 'application/pdf');
    // eslint-disable-next-line no-console
    console.log('J7 · القيم المقروءة من PDF الذي يضمّن الفاتورة:', values);
    expect(values).toEqual([QR]);
  });
});

describe('J٨ · سقف الحجم لا يحدّ الزمن', () => {
  test('ملف XML مصنوع من ١٦٠ ألف حرف («<ID » مكررة بلا «>») يحبس خيط الواجهة ثوانيَ، ونموّه تربيعي (٨ ميغا = ساعات)', () => {
    const crafted = '<ID '.repeat(40 * 1024);
    const t0 = Date.now();
    expect(qrFromInvoiceXml(crafted)).toEqual([]);
    const ms = Date.now() - t0;
    // ومقارنةً: ملفٌ صالحٌ بحجم السقف تقريباً يُقرأ سريعاً
    const QR = zatcaTlvBase64('مورد مصطنع', '300000000000003', '2026-11-02T10:15:30Z', 230000, 30000);
    const big = '<Invoice>' + '<cbc:Note>نص</cbc:Note>'.repeat(300000)
      + `<cbc:ID>QR</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject>${QR}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></Invoice>`;
    const t1 = Date.now();
    expect(qrFromInvoiceXml(big)).toEqual([QR]);
    const msBig = Date.now() - t1;
    // eslint-disable-next-line no-console
    console.log('J8 · المصنوع:', crafted.length, 'حرفاً في', ms, 'ms · والصالح:', big.length, 'حرفاً في', msBig, 'ms');
    expect(ms).toBeLessThan(1500);
  });
});

jest.mock('@react-native-ml-kit/barcode-scanning', () => {
  // كما في index.ts من الحزمة نفسها حين لا تُربط وحدتها الأصلية (NativeModules.BarcodeScanning غائب: نسخةٌ أقدم من التطبيق تحمل
  // حزمة JS أحدث، أو بيئة بلا ML Kit): الاستيراد ينجح، وكل وصولٍ لخاصيةٍ يرمي LINKING_ERROR
  const proxy = new Proxy({}, { get() { throw new Error("The package '@react-native-ml-kit/barcode-scanning' doesn't seem to be linked."); } });
  return { __esModule: true, default: proxy };
});

describe('J٩ · وحدة ML Kit غير مربوطة', () => {
  test('تُرمى «qr-read» («جرّب صورةً أوضح») لا «qr-unavailable» («حدّث التطبيق»): الاستيراد لا يفشل أبداً، والفشل عند الاستدعاء', async () => {
    const { readQrFromImage } = await import('@/services/invoiceQr');
    let msg = '';
    try { await readQrFromImage('file:///tmp/qr-synthetic.png'); } catch (e) { msg = (e as Error).message; }
    // eslint-disable-next-line no-console
    console.log('J9 · الخطأ:', msg);
    expect(msg).toBe('qr-unavailable');
  });
});

describe('J١٠ · قراءة رمز فاتورةٍ ثانية في النموذج نفسه (فحصٌ للمصدر · الواجهة لا تعمل على Node)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'purchases.tsx'), 'utf8');
  test('تُعبَّأ بيانات الثانية ومفتاحها، ويبقى مرفقاً صورةُ الأولى (أصلٌ لفاتورةٍ أخرى)', () => {
    // apply(): setQrKey(key) والمبالغ للفاتورة الجديدة دائماً، والصورة لا تُستبدل إن كان في النموذج ملفٌ معلّق ولو كان صورة الرمز السابق
    const apply = /const apply = \(name: string\) => \{[\s\S]*?\n {6}\};/.exec(src)?.[0] ?? '';
    expect(apply).toMatch(/setQrKey\(key\)/);
    // eslint-disable-next-line no-console
    console.log('J10 · سطر المرفق في apply():', /.*setPendingFile\(img\).*/.exec(apply)?.[0]?.trim());
    expect(apply).not.toMatch(/if \(!pendingFile\) setPendingFile\(img\)/);
  });
});

import { savePurchase as save2, purchaseByQrKey } from '@/domain/purchases';
import { zatcaQrKey } from '@/domain/zatcaQr';

describe('J١٣ · وقتٌ «لا يُقرأ» يدخل المفتاح، وتاريخٌ مقروءٌ يُترك', () => {
  const base = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
    supplier: 'محطة مصطنعة', date: '2026-11-01', due: '', category: 'وقود', incorpItem: '', amortize: false, amortizeMonths: null,
    exempt: false, excludeFromVat: true, subtotalHalalas: 8696, taxHalalas: 1304, totalHalalas: 10000, ...over,
  });
  test('فاتورتان حقيقيتان مختلفتان من البائع نفسه في اليوم نفسه بالمبلغ نفسه، ورمزهما بالتاريخ وحده: الثانية تُرفض «مسجّلة من قبل»', () => {
    const db = memDb();
    // التنبيه نفسه يقول إن الوقت لا يُقرأ (issuedAt)، والمفتاح «بالثانية» يُبنى منه كما هو
    const q1 = ok(decodeZatcaQr(tlv([[1, 'محطة مصطنعة'], [2, '300000000000003'], [3, '2026-11-01'], [4, '100.00'], [5, '13.04']])));
    const q2 = ok(decodeZatcaQr(tlv([[1, 'محطة مصطنعة'], [2, '300000000000003'], [3, '2026-11-01'], [4, '100.00'], [5, '13.04']])));
    expect(q1.warnings).toContain('issuedAt');
    save2(db, base({ qrKey: zatcaQrKey(q1) }));
    let err = '';
    try { save2(db, base({ qrKey: zatcaQrKey(q2) })); } catch (e) { err = (e as Error).message; }
    // eslint-disable-next-line no-console
    console.log('J13 · المفتاح:', zatcaQrKey(q1), '· حفظ الثانية:', err || 'حُفظت', '· المطابِقة:', JSON.stringify(purchaseByQrKey(db, zatcaQrKey(q2))));
    expect(err).toBe('');
  });
  test('وقتٌ بفاصل مسافة («2026-10-30 22:15:00» · RFC 3339 يجيزه، وDate يقرؤه) يُعدّ «لا يُقرأ» فيصير تاريخ الفاتورة اليوم', () => {
    const db = memDb();
    const q = ok(decodeZatcaQr(tlv([[1, 'مورد مصطنع'], [2, '300000000000003'], [3, '2026-10-30 22:15:00'], [4, '115.00'], [5, '15.00']])));
    const d = purchaseDraftFromQr(db, q, () => '2026-11-07');
    // eslint-disable-next-line no-console
    console.log('J13 · التنبيهات:', q.warnings, '· تاريخ المسودة:', d.date, '· وDate.parse:', new Date(q.issuedAt.replace(' ', 'T')).toString());
    expect(d.date).toBe('2026-10-30');
  });
});
