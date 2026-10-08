/**
 * عطل الدخول في الحزمة التجريبية (رسالة المالك 2026-10-08): كل فشل في التحقق كان يُعرض «يحتاج اتصالاً بالإنترنت»
 * والسبب الفعلي فهرسٌ غير منشور · فكل فشل يقول سببه الفعلي، ورسالة عربية كتبها التطبيق تُعرض كما هي.
 */
import { initI18n } from '@/i18n';
import { FirestoreHttpError } from '@/cloud/firestore';
import { readFileSync } from 'fs';
import { join } from 'path';
import { signInFailureKind, signInFailureText, gateFailure } from '@/cloud/signInFailure';

// نص التفاصيل نفسه يُبنى بوحدةٍ أصلية · يكفي هنا أنه يحمل الموضع ونص الخطأ
jest.mock('@/services/errorReport', () => ({ errorReportText: (w: string, e: unknown) => w + ' · ' + (e instanceof Error ? e.message : String(e)) }));

beforeAll(() => { initI18n('ar'); });

const indexBody = JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'The query requires a COLLECTION_GROUP_ASC index for collection invites and field email.' } });

test('الفهرس الناقص لا يُنسب إلى الاتصال', () => {
  const e = new FirestoreHttpError(400, indexBody);
  expect(signInFailureKind(e)).toBe('index');
  expect(signInFailureText(e)).toContain('فهرس');
  expect(signInFailureText(e)).not.toContain('الإنترنت');
});

test('كل سببٍ بنصه: الشبكة · القواعد · الرمز · إعداد قوقل · خدمات بلاي · غيرها برمزه', () => {
  expect(signInFailureKind(new TypeError('Network request failed'))).toBe('network');
  expect(signInFailureKind(new FirestoreHttpError(403, 'PERMISSION_DENIED'))).toBe('denied');
  expect(signInFailureKind(new FirestoreHttpError(401, 'UNAUTHENTICATED'))).toBe('token');
  expect(signInFailureKind(Object.assign(new Error('DEVELOPER_ERROR'), { code: '10' }))).toBe('googleConfig');
  expect(signInFailureKind(Object.assign(new Error('x'), { code: 'PLAY_SERVICES_NOT_AVAILABLE' }))).toBe('playServices');
  const other = new FirestoreHttpError(503, 'UNAVAILABLE');
  expect(signInFailureKind(other)).toBe('server');
  expect(signInFailureText(other)).toContain('503');
  const texts = new Set(['network', 'index', 'denied', 'token', 'googleConfig', 'playServices', 'server']
    .map((k) => signInFailureText(k === 'index' ? new FirestoreHttpError(400, indexBody)
      : k === 'denied' ? new FirestoreHttpError(403, '') : k === 'token' ? new FirestoreHttpError(401, '')
        : k === 'server' ? new FirestoreHttpError(500, '') : k === 'network' ? new TypeError('Network request failed')
          : Object.assign(new Error('e'), { code: k === 'googleConfig' ? '10' : 'PLAY_SERVICES_NOT_AVAILABLE' }))));
  expect(texts.size).toBe(7);
});

test('رسالة عربية كتبها التطبيق تُعرض كما هي', () => {
  expect(signInFailureText(new Error('رفضت قوقل رمز الدخول'))).toBe('رفضت قوقل رمز الدخول');
});

test('خطأ على الجهاز بلا رمز لا يُنسب إلى الخادم · ورمز قوقل غير المفصّل يُذكر برمزه', () => {
  expect(signInFailureKind(new TypeError('undefined is not a function'))).toBe('device');
  expect(signInFailureText(new TypeError('x'))).toContain('TypeError');
  expect(signInFailureText(new TypeError('x'))).not.toContain('الخادم');
  const busy = Object.assign(new Error('in progress'), { code: 'ASYNC_OP_IN_PROGRESS' });
  expect(signInFailureKind(busy)).toBe('google');
  expect(signInFailureText(busy)).toContain('ASYNC_OP_IN_PROGRESS');
  // رمز وحدة على الجهاز (القاعدة أو الخزنة) لا يُنسب إلى قوقل · ويُذكر رمزه
  const sqlite = Object.assign(new Error('disk I/O'), { code: 'ERR_INTERNAL_SQLITE_ERROR' });
  expect(signInFailureKind(sqlite)).toBe('device');
  expect(signInFailureText(sqlite)).toContain('ERR_INTERNAL_SQLITE_ERROR');
  expect(signInFailureKind(Object.assign(new Error('x'), { code: '12500' }))).toBe('google');
  // ٤٠٠ آخر غير الفهرس لا يُقال عنه «الفهرس»
  expect(signInFailureKind(new FirestoreHttpError(400, 'INVALID_ARGUMENT bad value'))).toBe('server');
  expect(signInFailureKind(new Error('OAuth author mismatch'))).toBe('device');
});

test('سبب شاشة «لم يكتمل التحقق»: بلا اتصال يُقال ذلك · ومع الاتصال الخطأ نفسه وتفاصيله', () => {
  const off = gateFailure('الدخول', false);
  expect(off.lead).toContain('اتصال');
  const on = gateFailure('الدخول', true, new FirestoreHttpError(400, indexBody));
  expect(on.lead).toContain('فهرس');
  expect(on.full).toContain('FAILED_PRECONDITION');
});

test('تعثّر التحقق من الدعوات يحمل سببه إلى الشاشة · لا يُبتلع الخطأ (حارس الموضع)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'services', 'cloud.ts'), 'utf8');
  const i = src.indexOf("if (inv === null) { patch({ gate: 'retry' }); return; }");
  expect(i).toBeGreaterThan(0);
  const before = src.slice(Math.max(0, i - 700), i);
  expect(before).toMatch(/catch \(e\) \{[\s\S]*gateError: gateFailure\(GATE_WHERE, true, e\)/);
  expect(before).toMatch(/gateError: gateFailure\(GATE_WHERE, false\)/);
  expect(before).not.toMatch(/catch \{ inv = null; \}/);
});
