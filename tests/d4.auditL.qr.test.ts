/**
 * المدقق الخارجي L · الجولة السادسة · قراءة فاتورة الشراء من رمزها كما هي في e8d6c19 (التوجيه الرابع ٦ · ١: «فواتير المشتريات: صورة أو PDF،
 * ورمز QR أولاً، وتُعرض معبأة للمراجعة ولا تُحفظ بلا تأكيد، والمكررة تُرفض»).
 * كل حالةٍ هنا تفشل على الكود الحالي وتمرّ حين يُصلح · البيانات مصطنعة كلها (أسماء وأرقام ضريبية ومبالغ ليست لأحد).
 *   TZ=Asia/Riyadh npx jest tests/auditL.qr.test.ts
 */
import fs from 'fs';
import path from 'path';
import { decodeZatcaQr, pickZatcaQr, zatcaQrKey, type ZatcaQr } from '@/domain/zatcaQr';
import { purchaseDraftFromQr } from '@/domain/purchaseQr';
import { savePurchase, purchaseByQrKey, TS_EXCLUDED, type PurchaseInput } from '@/domain/purchases';
import { saveSupplier } from '@/domain/suppliers';
import { periodBounds } from '@/domain/dates';
import { memDb } from './helpers/testDb';

/** TLV كما تشترطه الهيئة: وسمٌ بايت، طولٌ بايت، القيمة UTF-8 (أو بايتاتٌ كما هي) */
const tlvBytes = (pairs: Array<[number, number[]]>) =>
  Buffer.from(Uint8Array.from(pairs.flatMap(([t, b]) => [t, b.length, ...b]))).toString('base64');
const u8 = (v: string) => Array.from(new TextEncoder().encode(v));
const tlv = (pairs: Array<[number, string]>) => tlvBytes(pairs.map(([t, v]) => [t, u8(v)]));
const ok = (r: ReturnType<typeof decodeZatcaQr>): ZatcaQr => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r.qr; };
const input = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد مصطنع', date: '2026-11-01', due: '', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: true, taxStatus: TS_EXCLUDED, subtotalHalalas: 10000, taxHalalas: 1500, totalHalalas: 11500, ...over,
});
const realDay = (d: string) => { const x = new Date(d + 'T12:00:00Z'); return !Number.isNaN(x.getTime()) && x.toISOString().slice(0, 10) === d; };

describe('L١ · يومٌ لا وجود له في التقويم (30 فبراير، 31 أبريل) «وقتٌ مقروء» بلا تنبيه', () => {
  test('بلا منطقة: تاريخ المسودة «2026-02-30» كما هو، ويُحفظ في الفاتورة وقيدها فلا تقع في شهر فبراير ولا مارس', () => {
    const db = memDb();
    db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S-L1', 'مورد مصطنع', '300000000000003', '2026-01-01T00:00:00.000Z')`);
    const qr = ok(decodeZatcaQr(tlv([[1, 'مورد مصطنع'], [2, '300000000000003'], [3, '2026-02-30T10:00:00'], [4, '115.00'], [5, '15.00']])));
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    // كما تحفظ الشاشة المسودة بعد «تأكيد» المستخدم (purchases.tsx doSaveIn: date كما في الحقل، ولا فحص لصحة اليوم)
    const id = savePurchase(db, input({ supplier: d.supplier, date: d.date, qrKey: zatcaQrKey(qr) }));
    const saved = db.get<{ date: string; je: string }>(
      `SELECT p.date, j.date AS je FROM purchases p LEFT JOIN journal_entries j ON j.id = p.journal_entry_id WHERE p.id = ?`, [id])!;
    const feb = periodBounds('month', new Date(2026, 1, 15));
    const mar = periodBounds('month', new Date(2026, 2, 15));
    const inMonth = (b: { from: string; to: string }) => db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM purchases WHERE id = ? AND date >= ? AND date <= ?`, [id, b.from, b.to])!.n;
    // eslint-disable-next-line no-console
    console.log('L1 · التنبيهات:', qr.warnings, '· تاريخ المسودة:', d.date, '· المحفوظ:', JSON.stringify(saved),
      '· في فبراير', feb, inMonth(feb), '· في مارس', mar, inMonth(mar), '· وDate.parse يقرؤه:', new Date(qr.issuedAt).toString());
    // المتوقع: يومٌ لا وجود له «وقتٌ لا يُقرأ» (تنبيه issuedAt) فلا يصير تاريخ فاتورةٍ ولا قيد
    expect(qr.warnings).toContain('issuedAt');
    expect(realDay(d.date)).toBe(true);
  });
  test('بمنطقة: «2026-02-30T10:00:00Z» يصير صامتاً 2 مارس (يومٌ لم يكتبه البائع) بلا تنبيه', () => {
    const db = memDb();
    const qr = ok(decodeZatcaQr(tlv([[1, 'مورد مصطنع'], [2, '300000000000003'], [3, '2026-02-30T10:00:00Z'], [4, '115.00'], [5, '15.00']])));
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    // eslint-disable-next-line no-console
    console.log('L1 · بمنطقة · التنبيهات:', qr.warnings, '· تاريخ المسودة:', d.date);
    expect(qr.warnings).toContain('issuedAt');
  });
});

describe('L٢ · وقتٌ بالدقيقة وحدها يصنع مفتاحاً، فترفض فاتورةٌ ثانية حقيقية «مسجّلة من قبل»', () => {
  test('فاتورتان مختلفتان من محطةٍ واحدة في الدقيقة نفسها بالمبلغ نفسه (رمزهما بلا ثوانٍ): الثانية تُرفض', () => {
    const db = memDb();
    // المدقق J١٣ وإصلاحه (zatcaQr.ts:164): «وقتٌ لا يُقرأ بالثانية … لا يميّز فاتورتين … فلا مفتاح ولا رفض» · والدقيقة ليست ثانية
    const q1 = ok(decodeZatcaQr(tlv([[1, 'محطة مصطنعة'], [2, '300000000000003'], [3, '2026-11-01T09:00'], [4, '100.00'], [5, '13.04']])));
    const q2 = ok(decodeZatcaQr(tlv([[1, 'محطة مصطنعة'], [2, '300000000000003'], [3, '2026-11-01T09:00'], [4, '100.00'], [5, '13.04']])));
    savePurchase(db, input({ supplier: 'محطة مصطنعة', subtotalHalalas: 8696, taxHalalas: 1304, totalHalalas: 10000, qrKey: zatcaQrKey(q1) }));
    // كما تفعل الشاشة قبل التعبئة (purchases.tsx fillFromQr: purchaseByQrKey ثم حوار «مسجّلة من قبل»)
    const dup = purchaseByQrKey(db, zatcaQrKey(q2));
    let err = '';
    try { savePurchase(db, input({ supplier: 'محطة مصطنعة', subtotalHalalas: 8696, taxHalalas: 1304, totalHalalas: 10000, qrKey: zatcaQrKey(q2) })); }
    catch (e) { err = (e as Error).message; }
    // eslint-disable-next-line no-console
    console.log('L2 · التنبيهات:', q1.warnings, '· المفتاح:', zatcaQrKey(q1), '· فحص الشاشة:', JSON.stringify(dup), '· حفظ الثانية:', err || 'حُفظت');
    // (المفتاح يحمل حقائقه منذ إصلاح T١، والدقيقة بلا ثوانٍ لا تجعل الثانية «الفاتورة نفسها يقيناً»)
    expect(dup?.exact ?? false).toBe(false);
    expect(err).toBe('');
  });
});

describe('L٣ · رقم البطاقة بشرطات («300-000-000-000-003») يُعدّ «رقماً آخر» (تراجعٌ عن 662e4ae)', () => {
  test('المورد نفسه بالاسم نفسه والرقم نفسه يُقترح موردٌ جديد «الاسم · الرقم» بتنبيه supplierVat، وإضافته تصنع بطاقةً ثانية بالرقم نفسه', () => {
    const db = memDb();
    // حقل الرقم الضريبي في suppliers.tsx:289 لوحته رقمية (فيها «-»)، وsaveSupplier لا يطبّع الرقم
    saveSupplier(db, null, { name: 'مؤسسة مصطنعة', vat: '300-000-000-000-003', phone: '', category: '', amountHalalas: null, utility: '' });
    const qr = ok(decodeZatcaQr(tlv([[1, 'مؤسسة مصطنعة'], [2, '300000000000003'], [3, '2026-11-01T09:00:00Z'], [4, '1150.00'], [5, '150.00']])));
    const d = purchaseDraftFromQr(db, qr);
    // كما في purchases.tsx «إضافة المورد»
    let added = '';
    if (!d.supplierId) {
      try { saveSupplier(db, null, { name: d.supplier, vat: d.newSupplierVat ?? '', phone: '', category: '', amountHalalas: null, utility: '' }); added = 'أُضيف'; }
      catch (e) { added = 'رُفض: ' + (e as Error).message; }
    }
    const rows = db.all<{ name: string; vat: string }>(`SELECT name, vat FROM suppliers WHERE deleted_at IS NULL ORDER BY created_at`);
    // eslint-disable-next-line no-console
    console.log('L3 · المسودة:', JSON.stringify(d), '· إضافة المورد:', added, '· الموردون:', JSON.stringify(rows));
    expect(d.warnings).not.toContain('supplierVat');
    expect(d.supplierId).not.toBeNull();
  });
  test('وعلامة الاتجاه (U+200F، تلصقها النسخ من النصوص العربية) لا تُرى في البطاقة، والنتيجة نفسها', () => {
    const db = memDb();
    saveSupplier(db, null, { name: 'مؤسسة مصطنعة', vat: '\u200F300000000000003', phone: '', category: '', amountHalalas: null, utility: '' });
    const qr = ok(decodeZatcaQr(tlv([[1, 'مؤسسة مصطنعة'], [2, '300000000000003'], [3, '2026-11-01T09:00:00Z'], [4, '1150.00'], [5, '150.00']])));
    const d = purchaseDraftFromQr(db, qr);
    // eslint-disable-next-line no-console
    console.log('L3b · المسودة:', JSON.stringify(d));
    expect(d.supplierId).not.toBeNull();
  });
});

describe('L٨ · رمزٌ بأرقامٍ عربية هندية كله: المبالغ والرقم تُقرأ (J٤) والوقت لا، فلا مفتاح ولا رفضٌ للمكررة', () => {
  test('الفاتورة نفسها تُقرأ وتُحفظ مرتين بلا «مسجّلة من قبل»، وتاريخها اليوم', () => {
    const db = memDb();
    const raw = tlv([[1, 'مورد مصطنع'], [2, '٣٠٠٠٠٠٠٠٠٠٠٠٠٠٣'], [3, '٢٠٢٦-١١-٠١T٠٩:١٥:٣٠Z'], [4, '١١٥٠٫٠٠'], [5, '١٥٠٫٠٠']]);
    const q1 = ok(decodeZatcaQr(raw));
    const q2 = ok(decodeZatcaQr(raw));
    const d = purchaseDraftFromQr(db, q1, () => '2026-11-07');
    const save = (q: ZatcaQr) => { try { savePurchase(db, input({ subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000, date: d.date, qrKey: zatcaQrKey(q) })); return 'حُفظت'; } catch (e) { return (e as Error).message; } };
    const first = save(q1);
    const dupBefore = purchaseByQrKey(db, zatcaQrKey(q2));
    const second = save(q2);
    // eslint-disable-next-line no-console
    console.log('L8 · الإجمالي:', q1.totalHalalas, '· الرقم:', q1.vatNo, '· التنبيهات:', q1.warnings, '· تاريخ المسودة:', d.date, '· المفتاح:', JSON.stringify(zatcaQrKey(q1)),
      '· الأولى:', first, '· فحص الشاشة للثانية:', JSON.stringify(dupBefore), '· الثانية:', second);
    expect(q1.totalHalalas).toBe(115000);
    expect(q1.warnings).not.toContain('issuedAt');
    expect(second).not.toBe('حُفظت');
  });
});

describe('L٤ · المورد المطابق برقمه مؤرشف: المسودة تنسب إليه، ونموذج الفاتورة لا يعرفه', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'purchases.tsx'), 'utf8');
  test('supplierId لموردٍ مؤرشف لا تعرضه قائمة النموذج (archived = 0)، فيُقال عند «قابلة للخصم» «بلا رقم ضريبي في بطاقته» وبطاقته فيها رقمه', () => {
    const db = memDb();
    const sid = saveSupplier(db, null, { name: 'مورد مؤرشف مصطنع', vat: '300000000000003', phone: '', category: '', amountHalalas: null, utility: '' });
    db.run(`UPDATE suppliers SET archived = 1 WHERE id = ?`, [sid]);
    const qr = ok(decodeZatcaQr(tlv([[1, 'مورد مؤرشف مصطنع'], [2, '300000000000003'], [3, '2026-11-01T09:00:00Z'], [4, '1150.00'], [5, '150.00']])));
    const d = purchaseDraftFromQr(db, qr);
    // قائمة الموردين في النموذج كما هي في purchases.tsx (والاختيار بها: selectedSupplier = suppliers.find(name))
    const listSql = /`(SELECT id, name, vat, default_category[^`]*)`/.exec(src)?.[1] ?? '';
    const formList = db.all<{ id: string; vat: string }>(listSql);
    const selected = formList.find((s) => s.id === d.supplierId);
    // eslint-disable-next-line no-console
    console.log('L4 · المسودة:', JSON.stringify(d), '· قائمة النموذج:', listSql, '→', JSON.stringify(formList),
      '· وفحص الحفظ:', /if \(!\(selectedSupplier\?\.vat \?\? ''\)\.trim\(\)\) \{/.test(src), '· و«أضِفه الآن» بلا مورد مختار:', /if \(!selectedSupplier\) \{ toast\('اختر المورد أولاً'\)/.test(src));
    expect(listSql).toMatch(/archived = 0/);
    // المتوقع: لا يُنسب إلى موردٍ لا يختاره النموذج، أو يُنبَّه على أرشفته
    expect(d.supplierId === null || selected !== undefined || d.warnings.length > 0).toBe(true);
  });
});

describe('L٥ · رمزٌ فيه تسلسل UTF-8 فوق U+10FFFF يرمي RangeError', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'purchases.tsx'), 'utf8');
  test('pickZatcaQr يرمي فلا يبلغ رمز الهيئة الصحيح في الصورة نفسها، وfillFromQr لا يلتقطه (وعدٌ مرفوض بلا رسالة)', () => {
    // البائع F4 90 80 80 (U+110000 · ليس محرفاً) · والرمز الثاني في الصورة رمز فاتورةٍ صحيح
    const bad = tlvBytes([[1, [0xf4, 0x90, 0x80, 0x80]], [2, u8('300000000000003')], [3, u8('2026-11-01T09:00:00Z')], [4, u8('115.00')], [5, u8('15.00')]]);
    const good = tlv([[1, 'مورد مصطنع'], [2, '300000000000003'], [3, '2026-11-01T09:00:00Z'], [4, '115.00'], [5, '15.00']]);
    let thrown = '';
    let r: ReturnType<typeof pickZatcaQr> | null = null;
    try { r = pickZatcaQr([bad, good]); } catch (e) { thrown = String(e); }
    // في الشاشة: القراءة وحدها في try/catch، وpickZatcaQr بعدها خارجها (try { … } finally { setQrBusy(false) } بلا catch)
    const fill = /const fillFromQr = async[\s\S]*?\n {2}\};/.exec(src)?.[0] ?? '';
    const pickLine = /.*const r = pickZatcaQr\(values\);.*/.exec(fill)?.[0]?.trim();
    // eslint-disable-next-line no-console
    console.log('L5 · النتيجة:', thrown || JSON.stringify(r), '· سطر الاختيار في fillFromQr:', pickLine,
      '· والمحاولة الخارجية finally بلا catch:', /\n {4}\} finally \{ setQrBusy\(false\); \}/.test(fill) && !/\n {4}\} catch/.test(fill));
    expect(thrown).toBe('');
    expect(r?.ok).toBe(true);
  });
});

describe('L٦ · صورة رمزٍ قُرئ في فاتورةٍ جديدة لم تُحفظ تُرفق صامتةً بفاتورةٍ أخرى تُعدَّل بعدها (فحصٌ للمصدر · الواجهة لا تعمل على Node)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'purchases.tsx'), 'utf8');
  test('openEdit لا يمسح pendingFile، والحفظ يرفقه ولو كان زر الإرفاق مخفياً لأن للفاتورة أصلاً', () => {
    // ١) «قراءة QR الفاتورة» في فاتورةٍ جديدة يضع الصورة pendingFile (setPendingFile(img)) ٢) إغلاق النافذة لا يمسحها
    // ٣) «تعديل» فاتورةٍ أخرى لا يمسحها ٤) «حفظ التعديل» يرفقها بالفاتورة المعدّلة أصلاً ثانياً يُعرض أولاً (ORDER BY created_at DESC)
    const openEdit = /const openEdit = useCallback\(\(id: string\) => \{[\s\S]*?\n {2}\}, \[db\]\);/.exec(src)?.[0] ?? '';
    const sheet = /<Sheet visible=\{formOpen\} onClose=\{(\(\) => [^\n]*?)\}\s*$/m.exec(src)?.[1] ?? '';
    const attach = /.*if \(pendingFile\) \{\s*\n\s*attachPicked\(db, pendingFile, 'purchase', savedId.*/.exec(src)?.[0]?.trim();
    const hidden = /\{editingAttCount \? \(\s*<AttachStrip[\s\S]*?hideAdd \/>\s*\) : \(/.test(src);
    // eslint-disable-next-line no-console
    console.log('L6 · fillFromQr يضع:', /setPendingFile\(img\)/.test(src), '· إغلاق النافذة:', sheet, '· openEdit يمسح pendingFile:', /setPendingFile\(/.test(openEdit),
      '· الحفظ:', attach, '· زر الإرفاق مخفيٌّ لما له أصل:', hidden);
    expect(openEdit.length).toBeGreaterThan(0);
    expect(attach).toBeTruthy();
    expect(openEdit).toMatch(/setPendingFile\(null\)/);
  });
});
