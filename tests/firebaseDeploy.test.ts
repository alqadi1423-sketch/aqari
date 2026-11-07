/**
 * سير عمل نشر القواعد والفهارس (التوجيه الثالث · «قبل كل شيء» · قرار المالك 2026-11-07): أدوات المفتاح والنشر في
 * scripts/firebase/gauth.js بلا اعتمادات، تُختبر هنا بمفتاحٍ مصطنع يُولَّد في الاختبار ولا يُكتب في المستودع.
 */
import { generateKeyPairSync, createVerify } from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const g = require('../scripts/firebase/gauth.js');

const PROJECT = 'aqari-ec12e';
const EMAIL = 'github-deploy@aqari-ec12e.iam.gserviceaccount.com';

function fakeSa(over: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = {
    type: 'service_account', project_id: PROJECT, private_key_id: 'kid-مصطنع-1',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: EMAIL, token_uri: 'https://oauth2.googleapis.com/token', ...over,
  };
  return { sa, publicKey };
}

const part = (jwt: string, i: number) => JSON.parse(Buffer.from(jwt.split('.')[i], 'base64url').toString('utf8'));
const verifies = (jwt: string, publicKey: import('node:crypto').KeyObject) => {
  const [h, p, s] = jwt.split('.');
  return createVerify('RSA-SHA256').update(h + '.' + p).verify(publicKey, Buffer.from(s, 'base64url'));
};

describe('مفتاح حساب الخدمة', () => {
  test('السليم يُقبل · والناقص أو لمشروعٍ آخر أو ليس حساب خدمة يُرفض برسالة واضحة لا تحمل المفتاح', () => {
    const { sa } = fakeSa();
    expect(g.parseServiceAccount(JSON.stringify(sa), PROJECT).client_email).toBe(EMAIL);
    const cases: Array<[string, string]> = [
      ['', 'فارغ'],
      ['ليس JSON', 'JSON'],
      [JSON.stringify({ ...sa, type: 'authorized_user' }), 'حساب خدمة'],
      [JSON.stringify({ ...sa, project_id: 'مشروع-آخر' }), 'مشروع-آخر'],
      [JSON.stringify({ ...sa, private_key: undefined }), 'private_key'],
      [JSON.stringify({ ...sa, client_email: undefined }), 'client_email'],
    ];
    for (const [raw, says] of cases) {
      let msg = '';
      try { g.parseServiceAccount(raw, PROJECT); } catch (e) { msg = (e as Error).message; }
      expect(msg).toContain(says);
      expect(msg).not.toContain('PRIVATE KEY');
    }
  });

  test('رمز الدخول المخصص موقَّعٌ بمفتاح الحساب لعضوٍ بعينه ولساعة', () => {
    const { sa, publicKey } = fakeSa();
    const jwt = g.customToken(sa, 'عضو-اختبار', 1_800_000_000);
    expect(verifies(jwt, publicKey)).toBe(true);
    expect(part(jwt, 0)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const p = part(jwt, 1);
    expect([p.iss, p.sub, p.uid, p.exp - p.iat, p.aud]).toEqual([EMAIL, EMAIL, 'عضو-اختبار', 3600,
      'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit']);
  });

  test('طلب رمز الوصول: ينجح بالمفتاح السليم · والمفتاح المنتهي أو المعطّل يُفشل برسالة التجديد', async () => {
    const { sa, publicKey } = fakeSa();
    let sent = '';
    const ok = async (_url: string, init: { body: string }) => { sent = init.body; return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.مصطنع', expires_in: 3599 }) }; };
    expect(await g.accessToken(sa, ['https://www.googleapis.com/auth/cloud-platform'], ok, 1_800_000_000)).toBe('ya29.مصطنع');
    const assertion = new URLSearchParams(sent).get('assertion')!;
    expect(verifies(assertion, publicKey)).toBe(true);
    expect(part(assertion, 1).aud).toBe('https://oauth2.googleapis.com/token');

    const dead = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }) });
    let msg = '';
    try { await g.accessToken(sa, ['x'], dead, 1_800_000_000); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('جدّد');
    expect(msg).toContain(EMAIL);
    expect(msg).toContain('FIREBASE_SERVICE_ACCOUNT');
    expect(msg).toContain('invalid_grant');
    expect(msg).not.toContain('PRIVATE KEY');
  });

  test('حال انتهاء المفتاح: منتهٍ، أو قبل الانتهاء بشهرٍ فأقل، أو سليم · وبلا تاريخٍ معروف لا يُدّعى شيء', () => {
    const now = Date.parse('2026-12-10T00:00:00Z');
    expect(g.expiryStatus('2026-12-01T00:00:00Z', now).state).toBe('expired');
    expect(g.expiryStatus('2027-01-05T00:00:00Z', now)).toEqual({ state: 'soon', days: 26 });
    expect(g.expiryStatus('2027-03-01T00:00:00Z', now).state).toBe('ok');
    expect(g.expiryStatus(null, now).state).toBe('unknown');
    expect(g.expiryStatus('9999-12-31T23:59:59Z', now).state).toBe('none');
  });
});

describe('تنبيه انتهاء المفتاح', () => {
  test('بتاريخ IAM: منتهٍ خطأٌ يوقف · وقبله بشهرٍ تنبيه · وبعيدٌ معلومة', () => {
    const now = Date.parse('2026-12-10T00:00:00Z');
    expect(g.keyNotice({ validBefore: '2026-12-01T00:00:00Z', now }).level).toBe('error');
    expect(g.keyNotice({ validBefore: '2027-01-05T00:00:00Z', now }).level).toBe('warning');
    expect(g.keyNotice({ validBefore: '2027-06-01T00:00:00Z', now }).level).toBe('info');
  });
  test('بلا تاريخ IAM: يُنبَّه بالتاريخ المسجَّل (أول يناير) قبله بشهر ولا يُوقف به · وبلا تاريخٍ مسجَّل لا يُدّعى شيء', () => {
    const hint = '2027-01-01';
    expect(g.keyNotice({ validBefore: null, hintDate: hint, now: Date.parse('2026-11-07T00:00:00Z') }).level).toBe('notice');
    const soon = g.keyNotice({ validBefore: null, hintDate: hint, now: Date.parse('2026-12-05T00:00:00Z') });
    expect(soon.level).toBe('warning');
    expect(soon.text).toContain('جدّد');
    // فات التاريخ المسجَّل والمفتاح ما زال يُقبل: تنبيهٌ لا إيقاف (الرفض الحقيقي في طلب رمز الوصول)
    expect(g.keyNotice({ validBefore: null, hintDate: hint, now: Date.parse('2027-01-03T00:00:00Z') }).level).toBe('warning');
    expect(g.keyNotice({ validBefore: null, now: Date.parse('2026-12-05T00:00:00Z') }).level).toBe('notice');
  });
});

describe('ما قبل النشر وما بعده', () => {
  test('خلاصة اختبارات المحاكي: الفاشل أو المعلّق أو الفارغ يوقف النشر', () => {
    expect(g.jestSummaryOk({ success: true, numPendingTests: 0, numTotalTests: 35, numFailedTests: 0 }).ok).toBe(true);
    expect(g.jestSummaryOk({ success: false, numPendingTests: 0, numTotalTests: 35, numFailedTests: 1 }).ok).toBe(false);
    expect(g.jestSummaryOk({ success: true, numPendingTests: 3, numTotalTests: 35, numFailedTests: 0 }).ok).toBe(false);
    expect(g.jestSummaryOk({ success: true, numPendingTests: 0, numTotalTests: 0, numFailedTests: 0 }).ok).toBe(false);
    expect(g.jestSummaryOk(null).ok).toBe(false);
  });

  test('المنشور يطابق المختبَر حرفاً حرفاً', () => {
    const local = 'rules_version = \'2\';\nservice cloud.firestore {}\n';
    expect(g.sameRules({ source: { files: [{ name: 'firestore.rules', content: local }] } }, local)).toBe(true);
    expect(g.sameRules({ source: { files: [{ name: 'firestore.rules', content: local + ' ' }] } }, local)).toBe(false);
    expect(g.sameRules({ source: { files: [] } }, local)).toBe(false);
  });

  test('مفتاح واجهة الدخول من إعداد تطبيق الويب أو من ملف تطبيق أندرويد', () => {
    expect(g.apiKeyFrom({ apiKey: 'AIza-مصطنع-ويب' })).toBe('AIza-مصطنع-ويب');
    const gs = { client: [{ api_key: [{ current_key: 'AIza-مصطنع-أندرويد' }] }] };
    expect(g.apiKeyFrom({ configFileContents: Buffer.from(JSON.stringify(gs)).toString('base64') })).toBe('AIza-مصطنع-أندرويد');
    expect(g.apiKeyFrom({})).toBeNull();
  });
});
