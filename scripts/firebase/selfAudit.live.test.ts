/**
 * تجربةٌ حية بعد نشر القواعد على المشروع نفسه (التوجيه الثالث · قرار المالك 2026-11-07): عضو اختبارٍ في منشأة اختبارٍ مصطنعة
 * يكتب سطر سجل العمليات عن نفسه بحقولٍ صحيحة فيُقبل، وبرموز رؤيةٍ غير عامة فيُرفض · بكود التطبيق نفسه (buildDoc وannotate
 * وFirestoreRemote) كجهاز العضو. ثم تُحذف المنشأة المصطنعة وعضوها ومستخدمه.
 * لا يعمل إلا من سير عمل النشر (بمفتاح حساب الخدمة) بأمرٍ صريح، وليس من الحزمة (roots في jest.config.js هي tests/ وحدها).
 * وبـ SMOKE_EMULATOR=1 يجري على محاكيي Firestore والدخول بمفتاحٍ مصطنع، لتجربة المسار كله قبل المشروع.
 */
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const g = require('./gauth.js');

const EMU = process.env.SMOKE_EMULATOR === '1';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '';
const PROJECT = EMU ? 'demo-aqari' : process.env.FIREBASE_PROJECT ?? '';
const SA_PATH = EMU ? '' : process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '';
const RUN = process.env.GITHUB_RUN_ID ?? String(Date.now());
const ORG = `ci-smoke-${RUN}`;
const UID = `ci-smoke-member-${RUN}`;
const FS_BASE = EMU ? `http://${FS_HOST}` : 'https://firestore.googleapis.com';
const FS = `${FS_BASE}/v1/projects/${PROJECT}/databases/(default)/documents`;
const IDTK = EMU ? `http://${AUTH_HOST}/identitytoolkit.googleapis.com` : 'https://identitytoolkit.googleapis.com';
const VIEWER: Access = { owner: false, uid: UID, perms: { props: 1 }, allProps: true, props: [] };

const live = (EMU ? FS_HOST && AUTH_HOST : PROJECT && SA_PATH) ? describe : describe.skip;

/** في المحاكي: حساب خدمةٍ مصطنع بمفتاحٍ يُولَّد الآن (المحاكي لا يتحقق من التوقيع) */
function emulatorSa() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { type: 'service_account', project_id: PROJECT, client_email: 'ci-smoke@demo-aqari.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

live('بعد النشر · سطر العضو عن نفسه في سجل العمليات على المشروع', () => {
  let admin = '';
  let idToken = '';
  const written: string[] = [];

  const adminFetch = async (url: string, init: RequestInit = {}) =>
    fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' } });

  beforeAll(async () => {
    const sa = EMU ? emulatorSa() : g.parseServiceAccount(fs.readFileSync(SA_PATH, 'utf8'), PROJECT);
    // المحاكي يقبل «owner» مشرفاً لا تمرّ كتابته بالقواعد
    admin = EMU ? 'owner' : await g.accessToken(sa, ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/firebase',
      'https://www.googleapis.com/auth/datastore', 'https://www.googleapis.com/auth/identitytoolkit']);
    // مفتاح واجهة الدخول من إعداد تطبيق المشروع (ويب أولاً ثم أندرويد) · يُخفى في السجل
    let apiKey: string | null = EMU ? 'emulator-key' : null;
    for (const kind of EMU ? [] : ['webApps', 'androidApps']) {
      const list = await (await adminFetch(`https://firebase.googleapis.com/v1beta1/projects/${PROJECT}/${kind}`)).json() as { apps?: Array<{ name: string }> };
      for (const app of list.apps ?? []) {
        apiKey = g.apiKeyFrom(await (await adminFetch(`https://firebase.googleapis.com/v1beta1/${app.name}/config`)).json());
        if (apiKey) break;
      }
      if (apiKey) break;
    }
    if (!apiKey) throw new Error('لا مفتاح واجهة دخول في إعداد تطبيقات المشروع');
    if (process.env.GITHUB_ACTIONS) console.log('::add-mask::' + apiKey);
    // عضويةٌ مصطنعة بصلاحية العرض وحدها، كتبها المشرف (لا تمرّ بالقواعد) كما يكتبها المالك عند الدعوة
    const m = await adminFetch(`${FS}/orgs/${ORG}/members/${UID}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: encodeFields({ email: 'ci-smoke@example.test', perm: VIEWER.perms, all: true, props: [], tokens: memberTokens(VIEWER) }) }),
    });
    if (!m.ok) throw new Error('تعذّر إنشاء عضوية الاختبار: ' + m.status);
    const s = await fetch(`${IDTK}/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: g.customToken(sa, UID), returnSecureToken: true }),
    });
    const sj = await s.json() as { idToken?: string; error?: { message?: string } };
    if (!sj.idToken) throw new Error('تعذّر دخول عضو الاختبار: ' + (sj.error?.message ?? s.status));
    idToken = sj.idToken;
    if (process.env.GITHUB_ACTIONS) console.log('::add-mask::' + idToken);
  });

  /** تُحذف المنشأة المصطنعة كلها: صفوفها وعضويتها، ثم مستخدم العضو · ويعيد ما بقي منها */
  const cleanup = async (): Promise<string[]> => {
    const paths = [...written, `orgs/${ORG}/members/${UID}`];
    for (const p of paths) await adminFetch(`${FS}/${p}`, { method: 'DELETE' });
    const left: string[] = [];
    for (const p of paths) if ((await adminFetch(`${FS}/${p}`)).status !== 404) left.push(p);
    // مستخدم العضو ورمز تجديده لا يبقيان: حذفٌ ناجح، أو لم يوجد أصلاً (المتحقق المستقل: كان الرد يُهمل)
    const del = await adminFetch(`${IDTK}/v1/projects/${PROJECT}/accounts:delete`, { method: 'POST', body: JSON.stringify({ localId: UID }) });
    const dj = await del.json().catch(() => ({})) as { error?: { message?: string } };
    if (!del.ok && dj.error?.message !== 'USER_NOT_FOUND') left.push(`auth:${UID} (${del.status})`);
    return left;
  };

  // شبكة أمان إن سقط الاختبار قبل تنظيفه
  afterAll(async () => { if (admin) await cleanup(); });

  test('بحقولٍ صحيحة يُقبل · وبرموز رؤيةٍ غير عامة يُرفض', async () => {
    const { memDb } = await import('../../tests/helpers/testDb');
    const { logAudit } = await import('@/domain/audit');
    const { buildDoc } = await import('@/sync/engine');
    const mdb = memDb();
    const make = () => {
      logAudit(mdb, 'الأعضاء', 'update', 'بيانات عضو', 'عضو اختبار مصطنع');
      const k = mdb.get<{ id: string }>(`SELECT id FROM audit_log ORDER BY rowid DESC LIMIT 1`)!.id;
      written.push(`orgs/${ORG}/rows/audit_log__${k}`);
      return annotate(mdb, buildDoc(mdb, 'audit_log', k, 'upsert', new Date().toISOString(), 'dev-ci-smoke'), VIEWER).doc;
    };
    const remote = new FirestoreRemote({
      projectId: PROJECT, uid: UID, org: ORG, idToken: async () => idToken, ...(EMU ? { baseUrl: FS_BASE } : {}),
      memberTokens: () => memberTokens(VIEWER),
      fullReadTables: () => fullReadTables(VIEWER, SYNC_TABLES.map((t) => t.name)),
      access: () => VIEWER,
    });
    const good = (await remote.write([make()]))[0];
    expect([good.ok, good.code]).toEqual([true, 'OK']);
    const forged = (await remote.write([{ ...make(), g: ['contracts|P-ANY'] }]))[0];
    expect([forged.ok, forged.code]).toEqual([false, 'PERMISSION_DENIED']);
    mdb.close();
    // لا يبقى من المنشأة المصطنعة شيء
    expect(await cleanup()).toEqual([]);
  });
});
