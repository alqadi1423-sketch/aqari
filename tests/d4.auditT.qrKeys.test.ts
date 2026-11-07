/**
 * المدقق الخارجي T · الجولة العاشرة · مفتاح فاتورة الشراء المقروءة من رمزها كما هو في 7e3b492 (التوجيه الرابع ٦ · ١: «فواتير المشتريات:
 * صورة أو PDF، ورمز QR أولاً، وتُعرض معبأة للمراجعة ولا تُحفظ بلا تأكيد، والمكررة تُرفض»). منطق المجال وحده.
 * كل حالةٍ هنا تفشل على 7e3b492 وتمرّ حين يُصلح · البيانات مصطنعة كلها (أسماء وأرقام ضريبية 3…3 ومبالغ ليست لأحد).
 *   TZ=Asia/Riyadh npx jest tests/d4.auditT.qrKeys.test.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import ts from 'typescript';
import { decodeZatcaQr, zatcaQrKey, riyadhDateOf, type ZatcaQr } from '@/domain/zatcaQr';
import { purchaseDraftFromQr } from '@/domain/purchaseQr';
import { savePurchase, purchaseByQrKey, purchaseLookalike, deletePurchase, restorePurchase, taxPeriodOf, TS_EXCLUDED, type PurchaseInput } from '@/domain/purchases';
import { zatcaTlvBase64 } from '@/domain/printDocs';
import { memDb } from './helpers/testDb';

const ROOT = path.join(__dirname, '..');
const u8 = (v: string) => Array.from(new TextEncoder().encode(v));
const tlv = (pairs: Array<[number, string]>) =>
  Buffer.from(Uint8Array.from(pairs.flatMap(([t, v]) => { const b = u8(v); return [t, b.length, ...b]; }))).toString('base64');
const ok = (r: ReturnType<typeof decodeZatcaQr>): ZatcaQr => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r.qr; };
const input = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد مصطنع', date: '2026-11-01', due: '', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: true, taxStatus: TS_EXCLUDED, subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000, ...over,
});
/** كما يحفظ النموذج بعد التعبئة (purchases.tsx: التاريخ والمبالغ من المسودة، والمفتاح zatcaQrKey) */
const fromQr = (db: ReturnType<typeof memDb>, qr: ZatcaQr, supplier: string, key = zatcaQrKey(qr)): PurchaseInput => {
  const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
  return input({ supplier, date: d.date, subtotalHalalas: d.subtotalHalalas, taxHalalas: d.taxHalalas, totalHalalas: d.totalHalalas, qrKey: key || undefined });
};
const trySave = (db: ReturnType<typeof memDb>, i: PurchaseInput): string => {
  try { savePurchase(db, i); return 'حُفظت'; } catch (e) { return 'رُفضت: ' + (e as Error).message; }
};
/** ما يفحصه fillFromQr قبل التعبئة (purchases.tsx:413-414 و465): المطابقة التامة ثم الشبيهة · null = تُعبَّأ بلا سؤال */
const uiCheck = (db: ReturnType<typeof memDb>, qr: ZatcaQr) => {
  const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
  const dup = purchaseByQrKey(db, zatcaQrKey(qr));
  return dup ?? purchaseLookalike(db, { vat: qr.vatNo, seller: qr.sellerName, date: d.date, total: d.totalHalalas, tax: d.taxHalalas });
};
const log = (...a: unknown[]) => { /* eslint-disable-next-line no-console */ console.log(...a); };

/** zatcaQrKey كما كانت في e7c151c (قبل 7e3b492): المفتاح الذي كتبه التطبيق في كل فاتورةٍ قُرئت من رمزها حتى هذا الإصدار */
function legacyKeyOf(payload: string): string {
  const src = spawnSync('git', ['show', 'e7c151c:src/domain/zatcaQr.ts'], { cwd: ROOT, encoding: 'utf8' });
  if (src.status !== 0) throw new Error('git show e7c151c تعذّر: ' + src.stderr);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'auditT-legacy-'));
  const file = path.join(out, 'zatcaQr.js');
  fs.writeFileSync(file, ts.transpileModule(src.stdout, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const old = require(file) as { decodeZatcaQr: typeof decodeZatcaQr; zatcaQrKey: typeof zatcaQrKey };
  const r = old.decodeZatcaQr(payload);
  fs.rmSync(out, { recursive: true, force: true });
  if (!r.ok) throw new Error('لم يُقرأ بالإصدار السابق');
  return old.zatcaQrKey(r.qr);
}

describe('T١ · مفاتيح ما حُفظ قبل 7e3b492 لا يراها المفتاح الجديد: الفاتورة نفسها تُقرأ بعد التحديث فتُسجَّل ثانيةً بلا رفضٍ ولا سؤال', () => {
  test('أ · فاتورة المرحلة الثانية (فيها الوسم ٦) حُفظت بمفتاح الوقت (e7c151c)، وبعد التحديث مفتاحها البصمة: لا مطابقة تامة ولا شبيهة', () => {
    const payload = tlv([[1, 'مؤسسة الصيانة المصطنعة'], [2, '300000000000003'], [3, '2026-11-01T09:15:42+03:00'], [4, '1150.00'], [5, '150.00'],
      [6, 'aGFzaC1vZi1pbnZvaWNlLXQ='], [7, 'MEUCIQDsigSynthetic=='], [8, 'MFYwEAYHKoZIzj0CAQYFKbSynthetic==']]);
    const qr = ok(decodeZatcaQr(payload));
    const db = memDb();
    // حُفظت بالإصدار السابق: المبالغ والتاريخ كما هي، والمفتاح كما كتبه ذلك الإصدار
    const oldKey = legacyKeyOf(payload);
    const first = trySave(db, fromQr(db, qr, 'مؤسسة الصيانة المصطنعة', oldKey));
    // بعد التحديث يصوّر المحاسب الفاتورة نفسها (أو تصل نسختها XML بالبريد)
    const newKey = zatcaQrKey(qr);
    const seen = uiCheck(db, qr);
    const second = trySave(db, fromQr(db, qr, 'مؤسسة الصيانة المصطنعة'));
    const live = db.all<{ no: string; qr_key: string }>(`SELECT no, qr_key FROM purchases WHERE deleted_at IS NULL ORDER BY created_at`);
    log('T1أ · المفتاح القديم:', oldKey, '· الجديد:', newKey, '· الأولى:', first, '· فحص الشاشة قبل التعبئة:', JSON.stringify(seen),
      '· الثانية:', second, '· الحيّة:', JSON.stringify(live));
    expect(first).toBe('حُفظت');
    expect(oldKey).not.toBe(newKey);
    // المتوقع: الفاتورة نفسها (البائع والوقت بالثانية والإجمالي والضريبة) تُعرف ولو حُفظت بمفتاح الصيغة السابقة: تُرفض كما كانت تُرفض قبل
    // التحديث، أو يُسأل عنها على الأقل · لا تعبئةٌ وحفظٌ صامتان
    expect(seen).not.toBeNull();
  });

  test('ب · وقتٌ محشوٌّ بمنتصف الليل (رمز فواتير التطبيق نفسه printDocs) حُفظ بمفتاحٍ قبل التحديث، وبعده المفتاح فارغ والشبيهة لا ترى ما له مفتاح', () => {
    const payload = zatcaTlvBase64('شركة العقار المصطنعة', '310000000000003', '2026-11-01T00:00:00Z', 575000, 75000);
    const qr = ok(decodeZatcaQr(payload));
    const db = memDb();
    const oldKey = legacyKeyOf(payload);
    const first = trySave(db, fromQr(db, qr, 'شركة العقار المصطنعة', oldKey));
    const seen = uiCheck(db, qr);
    const second = trySave(db, fromQr(db, qr, 'شركة العقار المصطنعة'));
    log('T1ب · المفتاح القديم:', oldKey, '· الجديد:', JSON.stringify(zatcaQrKey(qr)), '· فحص الشاشة:', JSON.stringify(seen), '· الثانية:', second);
    expect(first).toBe('حُفظت');
    expect(oldKey).not.toBe('');
    // المتوقع: على الأقل سؤال «قد تكون مسجّلةً من قبل» (كما لفاتورةٍ بلا مفتاح) · لا تعبئةٌ صامتة لفاتورةٍ مسجّلةٍ من رمزها نفسه
    expect(seen).not.toBeNull();
  });

  test('ج · والاستعادة كذلك: نسخة الصيغة السابقة في السلة تعود فوق نسختها الحيّة بمفتاح البصمة', () => {
    const payload = tlv([[1, 'أسواق الواحة المصطنعة'], [2, '300000000000003'], [3, '2026-11-01T18:05:11Z'], [4, '230.00'], [5, '30.00'], [6, 'aGFzaC1yZXN0b3Jl']]);
    const qr = ok(decodeZatcaQr(payload));
    const db = memDb();
    const oldId = savePurchase(db, fromQr(db, qr, 'أسواق الواحة المصطنعة', legacyKeyOf(payload)));
    deletePurchase(db, oldId);
    savePurchase(db, fromQr(db, qr, 'أسواق الواحة المصطنعة'));
    let restored = 'استُعيدت';
    try { restorePurchase(db, oldId); } catch (e) { restored = 'رُفضت: ' + (e as Error).message; }
    const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM purchases WHERE deleted_at IS NULL`)!.n;
    log('T1ج · الاستعادة:', restored, '· الفواتير الحيّة للفاتورة نفسها:', n);
    // المتوقع: لا تعود فوق نسختها الحيّة (كما تُرفض الاستعادة بالمفتاح نفسه · d6.purchaseQrDup)
    expect(n).toBe(1);
  });
});

describe('T٤ · قاعدة «منتصف الليل المحشوّ» نصّية لا زمنية (إصلاح R١ ناقص)', () => {
  test('أ · منتصف ليل المملكة مكتوباً بتوقيت غرينتش («…T21:00:00.000Z» لليوم السابق، كما يكتبه toISOString لتاريخٍ محلي): فاتورتان حقيقيتان والثانية تُرفض', () => {
    // نظام فوترةٍ بتوقيت المملكة يحفظ تاريخ الفاتورة وحده (منتصف ليلها المحلي) ويكتبه في الرمز بـ toISOString
    const at = new Date(Date.parse('2026-11-01T00:00:00+03:00')).toISOString();
    const mk = () => ok(decodeZatcaQr(tlv([[1, 'مؤسسة النظافة المصطنعة'], [2, '300000000000003'], [3, at], [4, '1150.00'], [5, '150.00']])));
    const a = mk();
    const b = mk(); // عقد نظافة العمارة الثانية: المبلغ نفسه في اليوم نفسه
    const db = memDb();
    const r = [trySave(db, fromQr(db, a, 'مؤسسة النظافة المصطنعة')), trySave(db, fromQr(db, b, 'مؤسسة النظافة المصطنعة'))];
    // والصيغة التي يعدّها الإصلاح «تاريخاً وحده» هي اللحظة نفسها
    const literal = ok(decodeZatcaQr(tlv([[1, 'مؤسسة النظافة المصطنعة'], [2, '300000000000003'], [3, '2026-11-01T00:00:00+03:00'], [4, '1150.00'], [5, '150.00']])));
    log('T4أ · الوقت في الرمز:', at, '· يوم المسودة:', riyadhDateOf(at), '· المفتاح:', zatcaQrKey(a),
      '· اللحظة نفسها بصيغة «+03:00»:', Date.parse(at) === Date.parse(literal.issuedAt), 'مفتاحها:', JSON.stringify(zatcaQrKey(literal)), '· الحفظ:', r);
    expect(riyadhDateOf(at)).toBe('2026-11-01');
    expect(r[0]).toBe('حُفظت');
    // المتوقع: منتصف ليل المملكة تاريخٌ وحده أيّاً كانت كتابته (كما قرّر R١ لـ «T00:00:00+03:00»)، فلا يرفض فاتورةً حقيقيةً ثانية
    expect(r[1]).toBe('حُفظت');
  });

  test('ب · والعكس: «T00:00:00» بمنطقةٍ شرق المملكة يُعدّ تاريخاً وحده للمفتاح، ثم يُحوَّل لحظةً للتاريخ فيرجع يوماً (وربعاً)', () => {
    const qr = ok(decodeZatcaQr(tlv([[1, 'مورد مصطنع'], [2, '300000000000003'], [3, '2026-10-01T00:00:00+04:00'], [4, '1150.00'], [5, '150.00']])));
    const d = purchaseDraftFromQr(memDb(), qr, () => '2026-11-07');
    log('T4ب · المفتاح:', JSON.stringify(zatcaQrKey(qr)), '(تاريخٌ وحده) · تاريخ المسودة:', d.date, '· الفترة:', taxPeriodOf(d.date));
    // المتوقع: حكمٌ واحد على الوقت: إن عُدّ تاريخاً وحده (لا مفتاح) فيومه المكتوب (2026-10-01، الربع الرابع)، لا يُحوَّل كأنه لحظة
    expect(zatcaQrKey(qr) !== '' || d.date === '2026-10-01').toBe(true);
  });
});

describe('T٦ · مفتاح البصمة يُسقط الوقت: الوسم ٦ (نصٌّ لا يُتحقَّق منه) إن تكرّر عند البائع جمع فاتورتين في يومين مختلفين، والثانية تُرفض بلا مخرج', () => {
  test('اشتراكٌ شهري بالمبلغ نفسه (أكتوبر ونوفمبر) من مولّد رموزٍ يكرّر الوسم ٦: فاتورة نوفمبر «مسجّلة من قبل» برقم فاتورة أكتوبر', () => {
    const mk = (at: string) => ok(decodeZatcaQr(tlv([[1, 'شركة الاتصالات المصطنعة'], [2, '300000000000003'], [3, at], [4, '115.00'], [5, '15.00'],
      [6, 'U1lOVEhFVElDLUZJWEVE'], [7, 'MEUCIQDsigSynthetic=='], [8, 'MFYwEAYHKoZIzj0CAQYFKbSynthetic==']])));
    const oct = mk('2026-10-05T10:00:00+03:00');
    const nov = mk('2026-11-05T10:00:00+03:00');
    const db = memDb();
    const r = [trySave(db, fromQr(db, oct, 'شركة الاتصالات المصطنعة')), trySave(db, fromQr(db, nov, 'شركة الاتصالات المصطنعة'))];
    log('T6 · المفتاحان:', zatcaQrKey(oct), '=', zatcaQrKey(nov), '· يوما الفاتورتين:', oct.issuedAt, nov.issuedAt, '· الحفظ:', r);
    expect(r[0]).toBe('حُفظت');
    // المتوقع: فاتورتان في يومين مختلفين لا تكونان الفاتورة نفسها، فالبصمة تميّز ولا تجمع (الوقت يبقى في المفتاح معها)
    expect(r[1]).toBe('حُفظت');
  });
});
