/**
 * المدقق الخارجي T · الجولة العاشرة · تاريخ فاتورة الشراء من وقت رمزها كما في 7e3b492 (leadingDay وriyadhDateOf · إصلاحا R٦ وR٧) ·
 * منطق المجال ونصّ التنبيه الذي تعرضه الشاشة · كل حالةٍ تفشل على 7e3b492 وتمرّ حين يُصلح · بياناتٌ مصطنعة.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditT.qrDates.test.ts
 */
import fs from 'fs';
import path from 'path';
import { decodeZatcaQr, zatcaQrKey, riyadhDateOf, type ZatcaQr } from '@/domain/zatcaQr';
import { purchaseDraftFromQr } from '@/domain/purchaseQr';
import { taxPeriodOf } from '@/domain/purchases';
import { memDb } from './helpers/testDb';

const ROOT = path.join(__dirname, '..');
const u8 = (v: string) => Array.from(new TextEncoder().encode(v));
const tlv = (pairs: Array<[number, string]>) =>
  Buffer.from(Uint8Array.from(pairs.flatMap(([t, v]) => { const b = u8(v); return [t, b.length, ...b]; }))).toString('base64');
const ok = (r: ReturnType<typeof decodeZatcaQr>): ZatcaQr => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r.qr; };
const qrAt = (at: string) => ok(decodeZatcaQr(tlv([[1, 'صيدلية الليل المصطنعة'], [2, '300000000000003'], [3, at], [4, '1150.00'], [5, '150.00']])));
const AR = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'locales', 'ar.json'), 'utf8')) as { purchaseQr: { warn: Record<string, string> } };
const log = (...a: unknown[]) => { /* eslint-disable-next-line no-console */ console.log(...a); };

describe('T٥ · leadingDay يأخذ اليوم المكتوب ولو كان بمنطقةٍ مكتوبة بعده: وقتٌ بتوقيت غرينتش بعد 21:00 يصير يوماً (وربعاً) قبل يومه بتوقيت المملكة', () => {
  test.each([
    ['Go ‏(time.Time.String)', '2026-09-30 21:30:00 +0000 UTC'],
    ['Ruby للوقت بتوقيت غرينتش ‏(Time#to_s)', '2026-09-30 21:30:00 UTC'],
    ['Java ‏(ZonedDateTime.toString)', '2026-09-30T21:30:00Z[UTC]'],
    ['PostgreSQL ‏(timestamptz نصّاً بمنطقة الخادم UTC)', '2026-09-30 21:30:00+00'],
  ])('%s «%s»: صيدليةٌ صرفت 00:30 بتوقيت المملكة أول أكتوبر', (_n, at) => {
    const qr = qrAt(at);
    const d = purchaseDraftFromQr(memDb(), qr, () => '2026-10-02');
    // اللحظة نفسها بصيغةٍ يقرؤها التطبيق
    const same = riyadhDateOf('2026-09-30T21:30:00Z');
    log('T5', _n, '· التنبيهات:', qr.warnings, '· المفتاح:', JSON.stringify(zatcaQrKey(qr)), '· تاريخ المسودة:', d.date, '(', taxPeriodOf(d.date), ')',
      '· اليوم بتوقيت المملكة:', same, '· نصّ التنبيه:', AR.purchaseQr.warn.issuedAt);
    expect(same).toBe('2026-10-01');
    // المتوقع: يوم الفاتورة بتوقيت المملكة كما لصيغة «Z» نفسها (R٦)، لا اليوم المكتوب بمنطقةٍ أخرى · أو لا يُؤخذ يومٌ مكتوب بمنطقةٍ لم تُقرأ
    expect(d.date).not.toBe('2026-09-30');
  });

  test('وصيغة PostgreSQL بمنطقة المملكة («…22:15:42+03»، الساعة بلا دقائق) يومها صحيح لكنها «لا تُقرأ»: لا مفتاح، فالفاتورة نفسها لا تُرفض مرتين', () => {
    const qr = qrAt('2026-11-01 22:15:42+03');
    const same = qrAt('2026-11-01 22:15:42+03:00');
    log('T5 · PostgreSQL «+03»: التنبيهات:', qr.warnings, '· المفتاح:', JSON.stringify(zatcaQrKey(qr)), '· والصيغة نفسها بـ«+03:00»:', zatcaQrKey(same));
    expect(zatcaQrKey(same)).not.toBe('');
    // المتوقع: «+03» منطقةٌ مقروءة (ISO 8601 يجيز الساعة وحدها) كـ«+03:00»، فللفاتورة مفتاحٌ يرفض تكرارها
    expect(qr.warnings).not.toContain('issuedAt');
    expect(zatcaQrKey(qr)).not.toBe('');
  });

  test('ونصّ تنبيه «issuedAt» يقول «أُخذ تاريخ اليوم» والمسودة أخذت اليوم المكتوب في الرمز: المستخدم يُخبَر بغير ما حدث', () => {
    const qr = qrAt('2026-09-30');
    const d = purchaseDraftFromQr(memDb(), qr, () => '2026-10-02');
    const msg = AR.purchaseQr.warn.issuedAt;
    log('T5 · التاريخ وحده: التنبيهات:', qr.warnings, '· تاريخ المسودة:', d.date, '· اليوم:', '2026-10-02', '· نصّ التنبيه:', msg);
    expect(qr.warnings).toContain('issuedAt');
    expect(d.date).toBe('2026-09-30');
    // المتوقع: التنبيه يصف ما فُعل (أُخذ يوم الرمز المكتوب ولم يُقرأ وقته) لا «تاريخ اليوم»
    expect(/فأُخذ تاريخ اليوم/.test(msg)).toBe(false);
  });
});

describe('T٩ · حوافّ riyadhDateOf وتاريخ المسودة: سنةٌ دون ١٠٠٠ أو بعد ٩٩٩٩ بلا صيغة YYYY-MM-DD، و«T24:00:00» بلا منطقة يوماً قبل يومه', () => {
  test.each([['0999-12-31T12:00:00Z'], ['9999-12-31T22:00:00Z']])('«%s»: تاريخ المسودة ليس يوماً بصيغة التطبيق', (at) => {
    const qr = qrAt(at);
    const d = purchaseDraftFromQr(memDb(), qr, () => '2026-11-07');
    log('T9 ·', at, '· التنبيهات:', qr.warnings, '· تاريخ المسودة:', JSON.stringify(d.date), '· الفترة:', taxPeriodOf(d.date));
    // المتوقع: إمّا يومٌ بصيغة YYYY-MM-DD، وإمّا تنبيه «وقتٌ لا يُقرأ» (سنةٌ خارج المدى) فيُصحّحه المستخدم
    expect(/^\d{4}-\d{2}-\d{2}$/.test(d.date) || qr.warnings.includes('issuedAt')).toBe(true);
  });

  test('«2026-09-30T24:00:00» (نهاية اليوم في ISO 8601 = 00:00 أول أكتوبر): يُقرأ بلا تنبيه، فتاريخه 30 سبتمبر ومفتاحه وقتٌ «حقيقي»', () => {
    const qr = qrAt('2026-09-30T24:00:00');
    const d = purchaseDraftFromQr(memDb(), qr, () => '2026-11-07');
    log('T9 · T24 · التنبيهات:', qr.warnings, '· تاريخ المسودة:', d.date, '· اللحظة:', new Date(Date.parse('2026-09-30T24:00:00')).toString(), '· المفتاح:', zatcaQrKey(qr));
    // المتوقع: «24:00» يُقرأ يوماً تالياً (أو يُنبَّه أنه لا يُقرأ)، لا يوماً قبله في ربعٍ آخر بلا تنبيه
    expect(d.date === '2026-10-01' || qr.warnings.includes('issuedAt')).toBe(true);
  });
});
