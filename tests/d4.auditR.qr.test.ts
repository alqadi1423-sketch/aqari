/**
 * المدقق الخارجي R · الجولة التاسعة · قراءة فاتورة الشراء من رمزها كما هي في e7c151c (التوجيه الرابع ٦ · ١: «فواتير المشتريات: صورة أو PDF،
 * ورمز QR أولاً، وتُعرض معبأة للمراجعة ولا تُحفظ بلا تأكيد، والمكررة تُرفض»). منطق المجال وحده.
 * كل حالةٍ هنا تفشل على الكود الحالي وتمرّ حين يُصلح · البيانات مصطنعة كلها (أسماء وأرقام ضريبية ومبالغ ليست لأحد).
 *   TZ=Asia/Riyadh npx jest tests/d4.auditR.qr.test.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import ts from 'typescript';
import { decodeZatcaQr, zatcaQrKey, type ZatcaQr } from '@/domain/zatcaQr';
import { purchaseDraftFromQr } from '@/domain/purchaseQr';
import { savePurchase, purchaseByQrKey, taxPeriodOf, TS_EXCLUDED, TS_DEDUCTIBLE, type PurchaseInput } from '@/domain/purchases';
import { saveSupplier } from '@/domain/suppliers';
import { zatcaTlvBase64 } from '@/domain/printDocs';
import { vatReturnData } from '@/domain/vatReturn';
import { RuleViolation } from '@/domain/contracts/service';
import { memDb } from './helpers/testDb';

const ROOT = path.join(__dirname, '..');
const u8 = (v: string) => Array.from(new TextEncoder().encode(v));
const tlv = (pairs: Array<[number, string]>) =>
  Buffer.from(Uint8Array.from(pairs.flatMap(([t, v]) => { const b = u8(v); return [t, b.length, ...b]; }))).toString('base64');
const ok = (r: ReturnType<typeof decodeZatcaQr>): ZatcaQr => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r.qr; };
const sup = (name: string, vat: string) => ({ name, vat, phone: '', category: '', amountHalalas: null, utility: '' });
const input = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد مصطنع', date: '2026-11-01', due: '', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: true, taxStatus: TS_EXCLUDED, subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000, ...over,
});
/** كما يحفظ النموذج بعد التعبئة من الرمز (purchases.tsx: المبالغ والتاريخ من المسودة والمفتاح zatcaQrKey) */
const fromQr = (qr: ZatcaQr, supplier: string, over: Partial<PurchaseInput> = {}): PurchaseInput => input({
  supplier, date: qr.issuedAt.slice(0, 10), subtotalHalalas: qr.subtotalHalalas, taxHalalas: qr.vatHalalas, totalHalalas: qr.totalHalalas,
  qrKey: zatcaQrKey(qr) || undefined, ...over,
});
const trySave = (db: ReturnType<typeof memDb>, i: PurchaseInput): string => {
  try { savePurchase(db, i); return 'حُفظت'; } catch (e) { return 'رُفضت: ' + (e as Error).message; }
};
const log = (...a: unknown[]) => { /* eslint-disable-next-line no-console */ console.log(...a); };

describe('R١ · وقتٌ «منتصف الليل» المحشوّ (T00:00:00) يُعدّ وقتاً بالثانية: فاتورتان مختلفتان في يومٍ واحد بالمبلغ نفسه مفتاحٌ واحد', () => {
  test('رمز فواتير التطبيق نفسه (printDocs.ts: «issue + T00:00:00Z»): فاتورتا إيجارٍ لوحدتين بالإيجار نفسه في اليوم نفسه، الثانية تُرفض «مسجّلة من قبل»', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'domain', 'printDocs.ts'), 'utf8');
    const line = src.slice(0, src.indexOf("v.issue + 'T00:00:00Z'")).split('\n').length;
    // ما يطبعه التطبيق في رمز فاتورته الضريبية: تاريخ الإصدار وحده محشوّاً بمنتصف الليل (لا رقم فاتورة في رمز الهيئة)
    const inv1 = ok(decodeZatcaQr(zatcaTlvBase64('شركة العقار المصطنعة', '310000000000003', '2026-11-01' + 'T00:00:00Z', 575000, 75000)));
    const inv2 = ok(decodeZatcaQr(zatcaTlvBase64('شركة العقار المصطنعة', '310000000000003', '2026-11-01' + 'T00:00:00Z', 575000, 75000)));
    const db = memDb();
    const first = trySave(db, fromQr(inv1, 'شركة العقار المصطنعة'));
    const second = trySave(db, fromQr(inv2, 'شركة العقار المصطنعة'));
    log('R1 · printDocs.ts سطر', line, '· المفتاحان:', zatcaQrKey(inv1), '=', zatcaQrKey(inv2), '· الأولى:', first, '· الثانية (فاتورة الوحدة الأخرى):', second);
    expect(src.includes("v.issue + 'T00:00:00Z'")).toBe(true);
    expect(first).toBe('حُفظت');
    // المتوقع: وقتٌ محشوٌّ بمنتصف الليل تاريخٌ وحده (كما قرّر J١٣ للتاريخ وحده)، فلا يرفض فاتورةً حقيقيةً ثانية
    expect(second).toBe('حُفظت');
  });

  test.each([['بلا منطقة', '2026-11-01T00:00:00'], ['بتوقيت المملكة', '2026-11-01T00:00:00+03:00']])(
    'نظام فوترة يحفظ التاريخ وحده (%s): عقدا نظافةٍ لعمارتين بالمبلغ نفسه يُفوتَران في اليوم نفسه، والثانية تُرفض', (_n, at) => {
      const db = memDb();
      const a = ok(decodeZatcaQr(tlv([[1, 'مؤسسة النظافة المصطنعة'], [2, '300000000000003'], [3, at], [4, '1150.00'], [5, '150.00']])));
      const b = ok(decodeZatcaQr(tlv([[1, 'مؤسسة النظافة المصطنعة'], [2, '300000000000003'], [3, at], [4, '1150.00'], [5, '150.00']])));
      const r = [trySave(db, fromQr(a, 'مؤسسة النظافة المصطنعة')), trySave(db, fromQr(b, 'مؤسسة النظافة المصطنعة'))];
      log('R1', _n, '· التنبيهات:', a.warnings, '· المفتاح:', zatcaQrKey(a), '· الحفظ:', r);
      expect(r[1]).toBe('حُفظت');
    });
});

describe('R٢ · «الضريبة فوق الإجمالي» تنبيهٌ لا يمنع: بالوضع الافتراضي يُحفظ صافٍ سالب، وبـ«قابلة للخصم» يسقط الحفظ بخطأ قيدٍ في SQLite يُكتب عطلاً', () => {
  // رمزٌ بوسمَي الإجمالي والضريبة مقلوبين (4 = 15.00 · 5 = 115.00)، وهو خطأٌ شائع في مولّدات الرموز
  const setup = () => {
    const db = memDb();
    db.run(`UPDATE company SET vat_enabled = 1, vatno = '399999999999993' WHERE id = 1`);
    saveSupplier(db, null, sup('مؤسسة القلب المصطنعة', '300000000000003'));
    const qr = ok(decodeZatcaQr(tlv([[1, 'مؤسسة القلب المصطنعة'], [2, '300000000000003'], [3, '2026-11-01T09:15:42'], [4, '15.00'], [5, '115.00']])));
    return { db, qr, d: purchaseDraftFromQr(db, qr, () => '2026-11-07') };
  };
  test('الوضع الذي تتركه التعبئة («غير قابلة للخصم»): تُحفظ فاتورةٌ صافيها ‎-100.00 وضريبتها 115.00 وإجماليها 15.00', () => {
    const { db, qr, d } = setup();
    // ما يكتبه apply في الحقول ثم save(): الأساس + الضريبة = الإجمالي فلا نافذة عدم توازن، والحفظ مباشرةً (purchases.tsx:693)
    const saved = trySave(db, fromQr(qr, d.supplier));
    const row = db.get<{ s: number; t: number; g: number }>(`SELECT subtotal_halalas AS s, tax_halalas AS t, total_halalas AS g FROM purchases`);
    const ret = vatReturnData(db, 2026, 4);
    log('R2أ · المسودة:', JSON.stringify({ subtotal: d.subtotalHalalas, tax: d.taxHalalas, total: d.totalHalalas, warnings: d.warnings }),
      '· الحفظ:', saved, '· الصف:', JSON.stringify(row), '· سطر رقابة المستبعدة في الإقرار:', JSON.stringify(ret.excluded));
    expect(d.warnings).toContain('vatOverTotal');
    // المتوقع: فاتورة شراءٍ صافيها سالب (ضريبتها فوق إجماليها) لا تُحفظ، والسبب يُقال للمستخدم
    expect(saved).toMatch(/^رُفضت/);
  });
  test('«قابلة للخصم»: الرفض يأتي من قيد CHECK في القاعدة (نصٌّ إنجليزي)، فيُعرض «عطلاً» ويُكتب تقرير عطل لا قاعدة عمل', () => {
    const { db, qr, d } = setup();
    let err: unknown = null;
    try { savePurchase(db, fromQr(qr, d.supplier, { taxStatus: TS_DEDUCTIBLE, excludeFromVat: false })); } catch (e) { err = e; }
    const msg = (err as Error | null)?.message ?? '';
    log('R2ب · الخطأ:', (err as Error | null)?.constructor?.name, '·', msg);
    expect(err).not.toBeNull();
    // المتوقع: رفضٌ مقصود بقاعدةٍ عربية (RuleViolation) قبل أي كتابة، لا سقوطٌ في SQLite يقرؤه failureDialog عطلاً
    expect(err).toBeInstanceOf(RuleViolation);
    expect(msg).not.toMatch(/CHECK constraint/);
  });
});

describe('R٣ · «والمكررة تُرفض» بين الرمز وما سُجّل يدوياً (أو قبل الهجرة ٥٤): الفاتورة نفسها تُسجَّل مرتين بلا كلمة', () => {
  test('فاتورةٌ مسجّلة يدوياً لموردٍ برقمه، ثم يُقرأ رمزها: فحص التكرار قبل التعبئة لا يجدها، والحفظ يقبلها', () => {
    const db = memDb();
    saveSupplier(db, null, sup('مؤسسة الصيانة المصطنعة', '300000000000003'));
    // سجّلها المحاسب يدوياً (أو قبل وجود القراءة: كل فاتورةٍ قبل الهجرة ٥٤ مفتاحها '')
    savePurchase(db, input({ supplier: 'مؤسسة الصيانة المصطنعة', date: '2026-11-01', subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000 }));
    const qr = ok(decodeZatcaQr(tlv([[1, 'مؤسسة الصيانة المصطنعة'], [2, '300000000000003'], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']])));
    const key = zatcaQrKey(qr);
    // ما يفحصه fillFromQr قبل التعبئة (purchases.tsx:411-412) هو هذا وحده
    const dup = purchaseByQrKey(db, key);
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    const saved = trySave(db, fromQr(qr, d.supplier));
    const live = db.all<{ no: string; qr_key: string }>(`SELECT no, qr_key FROM purchases WHERE deleted_at IS NULL ORDER BY created_at`);
    log('R3 · فحص التكرار قبل التعبئة:', JSON.stringify(dup), '· الحفظ:', saved, '· الفواتير الحيّة:', JSON.stringify(live));
    // المتوقع: فاتورةٌ حيّة لمورد الرقم نفسه بالتاريخ نفسه والإجمالي والضريبة نفسيهما تُذكر قبل التعبئة (تأكيدٌ صريح على الأقل)،
    // لا أن تُسجَّل الثانية صامتة
    expect(dup).not.toBeNull();
  });
});

describe('R٤ · بصمة فاتورة المرحلة الثانية (الوسم ٦) تُهمل: فاتورتان مختلفتان في الثانية نفسها بالمبلغ نفسه مفتاحٌ واحد', () => {
  test('رمزان من المرحلة الثانية يختلفان في البصمة وحدها: الثانية تُرفض «مسجّلة من قبل»', () => {
    const base: Array<[number, string]> = [[1, 'أسواق الواحة المصطنعة'], [2, '300000000000003'], [3, '2026-11-01T18:05:11Z'], [4, '23.00'], [5, '3.00']];
    const tail: Array<[number, string]> = [[7, 'MEUCIQDsigSynthetic=='], [8, 'MFYwEAYHKoZIzj0CAQYFKbSynthetic==']];
    const a = ok(decodeZatcaQr(tlv([...base, [6, 'aGFzaC1vZi1pbnZvaWNlLWE='], ...tail])));
    const b = ok(decodeZatcaQr(tlv([...base, [6, 'aGFzaC1vZi1pbnZvaWNlLWI='], ...tail])));
    const db = memDb();
    const r = [trySave(db, fromQr(a, 'أسواق الواحة المصطنعة', { date: '2026-11-01' })), trySave(db, fromQr(b, 'أسواق الواحة المصطنعة', { date: '2026-11-01' }))];
    log('R4 · المرحلة:', a.phase, b.phase, '· المفتاحان:', zatcaQrKey(a), zatcaQrKey(b), '· الحفظ:', r);
    expect(a.phase).toBe(2);
    // المتوقع: بصمة الفاتورة (الوسم ٦) تميّز فاتورتين، فمفتاحاهما مختلفان والثانية تُحفظ
    expect(zatcaQrKey(a)).not.toBe(zatcaQrKey(b));
    expect(r[1]).toBe('حُفظت');
  });
});

describe('R٥ · مطابقة الاسم بلا توحيد يونيكود: الاسم نفسه مفكَّكاً (NFD) أو بأشكال العرض العربية بطاقةٌ ثانية تبدو هي (تتمة P٤ب)', () => {
  test.each([
    ['مفكَّك (NFD: الهمزة محرفٌ مركَّب)', 'مؤسسة الأمانة المصطنعة'.normalize('NFD')],
    ['أشكال العرض (U+FExx)', 'ﻣﺆﺳﺴﺔ ﺍﻷﻣﺎﻧﺔ ﺍﻟﻤﺼﻄﻨﻌﺔ'],
  ])('بطاقةٌ بلا رقمٍ ضريبي باسم البائع، والرمز يحمل اسمه %s: «ليس في الموردين» و«إضافة المورد» تصنع بطاقتين', (_n, seller) => {
    const db = memDb();
    const id = saveSupplier(db, null, sup('مؤسسة الأمانة المصطنعة', ''));
    const qr = ok(decodeZatcaQr(tlv([[1, seller], [2, '300000000000003'], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']])));
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    if (!d.supplierId) saveSupplier(db, null, sup(d.supplier, d.newSupplierVat ?? ''));
    const looks = db.all<{ name: string }>(`SELECT name FROM suppliers WHERE deleted_at IS NULL`).map((s) => s.name.normalize('NFKC'));
    log('R5', _n, '· المسودة:', JSON.stringify({ known: d.supplierId === id, newSupplierVat: d.newSupplierVat }), '· الأسماء كما تُرى:', JSON.stringify(looks));
    expect(d.supplierId).toBe(id);
    expect(new Set(looks).size).toBe(looks.length);
  });
});

describe('R٦ · الوقت بمنطقته يُحوَّل إلى منطقة الهاتف لا إلى توقيت المملكة: تاريخ الفاتورة وفترتها الضريبية بحسب مكان الهاتف', () => {
  test('فاتورةٌ صدرت 00:30 بتوقيت المملكة أول أكتوبر («2026-09-30T21:30:00Z»): هاتفٌ في لندن أو نيويورك يجعلها 30 سبتمبر (الربع الثالث)', () => {
    // jest يعزل process.env فلا يتغيّر توقيت المحرّك داخله: تُترجم الوحدات الثلاث (dates وzatcaQr وpurchaseQr) وتُشغَّل في عمليةٍ بتوقيتٍ آخر
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'auditR-tz-'));
    for (const f of ['dates', 'zatcaQr', 'purchaseQr']) {
      const code = fs.readFileSync(path.join(ROOT, 'src', 'domain', f + '.ts'), 'utf8');
      fs.writeFileSync(path.join(out, f + '.js'), ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText);
    }
    const payload = tlv([[1, 'مورد مصطنع'], [2, '300000000000003'], [3, '2026-09-30T21:30:00Z'], [4, '1150.00'], [5, '150.00']]);
    const script = `const z=require(${JSON.stringify(path.join(out, 'zatcaQr.js'))});const p=require(${JSON.stringify(path.join(out, 'purchaseQr.js'))});`
      + `const r=z.decodeZatcaQr(${JSON.stringify(payload)});process.stdout.write(p.purchaseDraftFromQr({all:()=>[]},r.qr,()=>'TODAY').date);`;
    const dates: Record<string, string> = {};
    for (const tz of ['Asia/Riyadh', 'Europe/London', 'America/New_York', 'Asia/Dubai']) {
      dates[tz] = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).stdout;
    }
    fs.rmSync(out, { recursive: true, force: true });
    log('R6 · تاريخ المسودة بحسب منطقة الهاتف:', JSON.stringify(dates), '· الفترة:', JSON.stringify(Object.fromEntries(Object.entries(dates).map(([k, v]) => [k, taxPeriodOf(v)]))));
    expect(dates['Asia/Riyadh']).toBe('2026-10-01');
    // المتوقع: تاريخ الفاتورة يومها بتوقيت المملكة (+03:00) أينما كان الهاتف
    expect(dates['Europe/London']).toBe('2026-10-01');
    expect(dates['America/New_York']).toBe('2026-10-01');
  });
});

describe('R٧ · تاريخٌ مقروءٌ في الرمز يُترك لتاريخ اليوم حين لا يُقرأ الوقت معه (تتمة J١٣)', () => {
  test.each([['التاريخ وحده', '2026-09-30'], ['صيغة Ruby ‏(Time#to_s)', '2026-09-30 22:15:00 +0300']])(
    '%s («%s») يُقرأ في 2 أكتوبر: تاريخ الفاتورة 2026-10-02 فتقع في الربع الرابع', (_n, at) => {
      const db = memDb();
      const qr = ok(decodeZatcaQr(tlv([[1, 'مورد مصطنع'], [2, '300000000000003'], [3, at], [4, '1150.00'], [5, '150.00']])));
      const d = purchaseDraftFromQr(db, qr, () => '2026-10-02');
      log('R7', _n, '· التنبيهات:', qr.warnings, '· تاريخ المسودة:', d.date, '· الفترة:', taxPeriodOf(d.date));
      // المتوقع: اليوم المكتوب في الرمز (يومٌ من التقويم) هو تاريخ الفاتورة ولو بقي تنبيه الوقت
      expect(d.date).toBe('2026-09-30');
    });
});

describe('R٨ · (إصلاح P١ ناقص) البطاقة المطابقة رقماً واسماً مؤرشفة: تُنسب الفاتورة صامتةً لموردٍ آخر «فيه» الرقم بين أرقامٍ أخرى', () => {
  test('بلا تنبيه «مؤرشف» ولا «اسمٌ آخر»: المسودة باسم مؤسسة الواحة والبائع شركة النخبة', () => {
    const db = memDb();
    const a = saveSupplier(db, null, sup('مؤسسة الواحة المصطنعة', '300000000000003 / 311111111111113'));
    const b = saveSupplier(db, null, sup('شركة النخبة المصطنعة', '311111111111113'));
    db.run(`UPDATE suppliers SET archived = 1 WHERE id = ?`, [b]);
    const qr = ok(decodeZatcaQr(tlv([[1, 'شركة النخبة المصطنعة'], [2, '311111111111113'], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']])));
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    log('R8 · المسودة:', JSON.stringify({ supplier: d.supplier, supplierId: d.supplierId === a ? 'أ (الواحة)' : d.supplierId === b ? 'ب (النخبة)' : d.supplierId, warnings: d.warnings }));
    // المتوقع: لا تُنسب صامتةً لبطاقةٍ رقمها ليس رقم البائع وحده واسمها غير اسمه: إمّا البطاقة المطابقة بتنبيه «مؤرشف»، وإمّا تنبيهٌ يسمّي الفرق
    expect(d.supplierId === a && d.warnings.length === 0).toBe(false);
  });
});
