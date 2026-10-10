/**
 * مراجعة التثبيت #55 على محاكي Firestore: عدّاد الترقيم (ومنه INV للفاتورة الضريبية) كان يرفعه أي عضو ولو بـ«عرض»،
 * فيصنع فجوة في تسلسل الفواتير · INV لمن يصدر الفاتورة وبواحدٍ لا غير، وقفزة غيره محدودة · بيانات مصطنعة.
 */
import { encodeFields } from '@/cloud/firestore';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'CNTOWNER';
const d = HOST ? describe : describe.skip;

function token(uid: string, email = uid.toLowerCase() + '@example.test'): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const put = async (path: string, data: Record<string, unknown>, uid: string) => (await fetch(
  `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`,
  { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) }, body: JSON.stringify({ fields: encodeFields(data) }) },
)).status;
const member = (perm: Record<string, number>) => ({ email: 'm@example.test', perm, all: true, props: [], tokens: [], orgName: 'منشأة مصطنعة' });
const C = `orgs/${ORG}/meta/counters`;

d('أول فاتورة ضريبية بعد التفعيل من المالك (قرار المالك 2026-10-09 على #55)', () => {
    const ORG2 = 'CNTOWNER2';
    const C2 = `orgs/${ORG2}/meta/counters`;
    test('العضو لا يُنشئ أول رقم فاتورة · والمالك يُنشئه ثم يتابع العضو بواحد', async () => {
      expect(await put(`orgs/${ORG2}/members/U-INV`, member({ invoices: 3 }), ORG2)).toBe(200);
      expect(await put(C2, { JE: 10 }, ORG2)).toBe(200);
      expect(await put(C2, { JE: 10, INV: 1 }, 'U-INV')).toBe(403);
      expect(await put(C2, { JE: 10, INV: 1 }, ORG2)).toBe(200);
      expect(await put(C2, { JE: 10, INV: 2 }, 'U-INV')).toBe(200);
    });
  });

d('عدّاد الترقيم (مراجعة التثبيت #55)', () => {
  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    expect(await put(`orgs/${ORG}/members/U-VIEW`, member({ collect: 1 }), ORG)).toBe(200);
    expect(await put(`orgs/${ORG}/members/U-INV`, member({ invoices: 3 }), ORG)).toBe(200);
    expect(await put(C, { JE: 10, EJ: 0, PUR: 0, INV: 5 }, ORG)).toBe(200);
  });

  test('عضوٌ بلا الفواتير لا يحرّك INV · ويحجز كتل القيود', async () => {
    expect(await put(C, { JE: 10, EJ: 0, PUR: 0, INV: 6 }, 'U-VIEW')).toBe(403);
    expect(await put(C, { JE: 510, EJ: 0, PUR: 0, INV: 5 }, 'U-VIEW')).toBe(200);
  });

  test('من يصدر الفاتورة يرفع INV بواحدٍ لا غير', async () => {
    expect(await put(C, { JE: 510, EJ: 0, PUR: 0, INV: 6 }, 'U-INV')).toBe(200);
    expect(await put(C, { JE: 510, EJ: 0, PUR: 0, INV: 8 }, 'U-INV')).toBe(403);
  });

  test('قفزة العضو في غير INV محدودة · والمالك كما كان', async () => {
    expect(await put(C, { JE: 510 + 200000, EJ: 0, PUR: 0, INV: 6 }, 'U-VIEW')).toBe(403);
    // سقف القفزة حجم كتلة السلسلة (المراجعات الخارجية «ثالثاً أ ٧»): القيود ٥٠٠، والحرفي ٥٠، والمشتريات ١٠٠
    expect(await put(C, { JE: 510 + 501, EJ: 0, PUR: 0, INV: 6 }, 'U-VIEW')).toBe(403);
    expect(await put(C, { JE: 510, EJ: 51, PUR: 0, INV: 6 }, 'U-VIEW')).toBe(403);
    expect(await put(C, { JE: 510, EJ: 50, PUR: 100, INV: 6 }, 'U-VIEW')).toBe(200);
    expect(await put(C, { JE: 510, EJ: 50, PUR: 100, INV: 20 }, ORG)).toBe(200);
  });
});

d('العضو وأرضيته فوق العدّاد (المتحقق المستقل على «ثالثاً أ ٧»)', () => {
  const ORG3 = 'CNTOWNER3';
  test('يحجز بخطواتٍ تحت سقف القواعد حتى تتخطى كتلتُه أرضيتَه · ولا قفزة واحدة فوق السقف', async () => {
    const { FirestoreRemote } = await import('@/cloud/firestore');
    expect(await put(`orgs/${ORG3}/members/U-STEP`, member({ collect: 2 }), ORG3)).toBe(200);
    expect(await put(`orgs/${ORG3}/meta/counters`, { JE: 1504 }, ORG3)).toBe(200);
    // قفزةٌ واحدة إلى ما بعد الأرضية تُرفض (السقف قائم)
    expect(await put(`orgs/${ORG3}/meta/counters`, { JE: 2905 }, 'U-STEP')).toBe(403);
    const r = new FirestoreRemote({ projectId: PROJECT, uid: 'U-STEP', org: ORG3, idToken: async () => token('U-STEP'), baseUrl: 'http://' + HOST,
      memberTokens: () => ['collect|@'] });
    const [b] = await r.reserveBlocks([{ series: 'JE', size: 500, floor: 2400, gap: 1000 }]);
    expect(b.lo).toBeGreaterThan(2400);
    expect(b.hi - b.lo + 1).toBe(500);
  });
});
