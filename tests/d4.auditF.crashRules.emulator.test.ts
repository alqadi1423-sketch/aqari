/**
 * المدقق الخارجي F · الجولة الثالثة · قاعدة تقرير العطل (memberCrashReport) على محاكي Firestore.
 * قرار المالك 2026-11-07 «نعم توصلني»: تقارير أعطال الأعضاء تصل المالك وحده، محجوبةً، بحدٍّ يومي (عشرون لكل حساب · رسالة 381460e:
 * «فلا يتجاوز 20 في اليوم لكل حساب» تفرضه القاعدة برتبة المعرّف والإنشاء وحده).
 *
 * يعمل حين يكون المحاكي قائماً ويُتخطّى غير ذلك:
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest -i tests/auditF.crashRules.emulator.test.ts"
 * البيانات مصطنعة كلها.
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'OWNERF';
const d = HOST ? describe : describe.skip;

function token(uid: string, email = uid.toLowerCase() + '@example.test'): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const member = (uid: string, perms: Access['perms'], props: string[] | 'all'): Access =>
  ({ owner: false, uid, perms, allProps: props === 'all', props: props === 'all' ? [] : props });
function remoteFor(uid: string, a: Access | null): FirestoreRemote {
  return new FirestoreRemote({
    projectId: PROJECT, uid, org: ORG, idToken: async () => token(uid), baseUrl: 'http://' + HOST,
    memberTokens: () => (a ? memberTokens(a) : null),
    fullReadTables: () => (a ? fullReadTables(a, SYNC_TABLES.map((t) => t.name)) : new Set()),
    access: () => a ?? { owner: true, uid, perms: {}, allProps: true, props: [] },
  });
}
async function putDoc(path: string, data: Record<string, unknown>, uid: string): Promise<number> {
  const res = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) },
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  return res.status;
}

d('F · قاعدة تقرير العطل', () => {
  // عضوٌ قارئٌ فقط (لا قسم إدخال) · وعضو تحصيلٍ بإدخال
  const VIEWER = member('U-FVIEW', { props: 1 }, 'all');
  const COLLECTOR = member('U-FCOL', { collect: 2, contracts: 1, props: 1 }, 'all');
  let mdb: DB;

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    for (const a of [VIEWER, COLLECTOR]) {
      expect(await putDoc(`orgs/${ORG}/members/${a.uid}`, {
        email: a.uid!.toLowerCase() + '@example.test', perm: a.perms, all: a.allProps, props: a.props, tokens: memberTokens(a),
      }, ORG)).toBe(200);
    }
    const { memDb } = await import('./helpers/testDb');
    mdb = memDb();
  });

  /** تقرير عطلٍ سليمٌ كما يكتبه جهاز العضو ويزيّنه annotate */
  const legit = async (a: Access) => {
    const { buildDoc } = await import('@/sync/engine');
    const { recordCrashReport } = await import('@/domain/crashReport');
    mdb.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('uid', ?)`, [a.uid]);
    mdb.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'عضو مصطنع' } })]);
    expect(recordCrashReport(mdb, { where: 'موضع مصطنع', e: new Error('عطل مصطنع'), platform: 'android' })).toBe(true);
    const k = mdb.get<{ id: string }>(`SELECT id FROM audit_log ORDER BY rowid DESC LIMIT 1`)!.id;
    return annotate(mdb, buildDoc(mdb, 'audit_log', k, 'upsert', new Date().toISOString(), 'dev-f'), a).doc;
  };
  const write = async (a: Access, doc: RemoteDoc) => (await remoteFor(a.uid!, a).write([doc]))[0];

  test('F1 · الحدّ اليومي: عضوٌ قارئٌ لا ينشئ أكثر من عشرين مستند «تقرير عطل» في اليوم · ولو بمستند حذفٍ مفتاحه حرّ (del: true)', async () => {
    // العشرون المشروعة: الرتب ٠ إلى ١٩
    let ok = 0;
    let base: RemoteDoc | null = null;
    for (let i = 0; i < 20; i++) {
      const doc = await legit(VIEWER);
      base = base ?? doc;
      if ((await write(VIEWER, doc)).ok) ok++;
    }
    expect(ok).toBe(20);
    // الحادي والعشرون بالمسار المشروع مرفوض (الرتبة ٢٠ لا تطابق)، فالحدّ قائمٌ ظاهراً
    const day0 = String(base!.d!.id).split('-').slice(-2)[0];
    const r20 = String(base!.d!.id).replace(/-0$/, '-20');
    expect((await write(VIEWER, { ...base!, id: 'audit_log__' + r20, k: r20, d: { ...base!.d!, id: r20 } })).ok).toBe(false);
    expect(day0).toMatch(/^[0-9]{8}$/);
    const day = day0;
    // مستند «حذف» بحمولةٍ كاملة ومعرّفٍ مشروع في d، ومفتاحٍ (k) حرّ: keyOk يُرجع true لكل del فلا يُقارن k بـ d.id
    const extra: string[] = [];
    for (let i = 0; i < 5; i++) {
      const k = `flood-${day}-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const forged: RemoteDoc = { ...base!, id: 'audit_log__' + k, k, del: true, d: { ...base!.d!, id: `crash-${VIEWER.uid}-${day}-0` } };
      if ((await write(VIEWER, forged)).ok) extra.push(k);
    }
    // eslint-disable-next-line no-console
    console.log('F1 · مستنداتٌ فوق العشرين قُبلت:', extra.length, extra);
    expect(extra).toEqual([]);
  });

  test('F2 · «تقرير عطل» بمسار عملية قسمٍ (op = collect) يتخطى memberCrashReport كلها: بلا حدٍّ ولا شكل معرّف ولا حدّ موضع', async () => {
    const base = await legit(COLLECTOR);
    expect(base.op).toBe('self');
    const accepted: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `fake-crash-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const forged: RemoteDoc = {
        ...base, id: 'audit_log__' + id, k: id, op: 'collect',
        d: { ...base.d!, id, entity_name: 'موضع'.repeat(200), user_name: 'عضوٌ آخر مصطنع' },
      };
      if ((await write(COLLECTOR, forged)).ok) accepted.push(id);
    }
    // eslint-disable-next-line no-console
    console.log('F2 · تقارير عطلٍ مزوّرة قُبلت بمسار collect:', accepted.length);
    // المتوقع: «تقرير عطل» لا يُكتب إلا بقاعدته (حدّ عشرين، والمعرّف بالحساب واليوم والرتبة، والموضع دون 120)
    expect(accepted).toEqual([]);
  });

  test('صمد: المالك يسحب تقرير العضو (g = []) ويظهر في قائمته · والعضو الآخر لا يقرؤه', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    const { crashReports } = await import('@/domain/crashReport');
    const owner = memDb();
    enableSync(owner, ORG);
    await syncOnce(owner, remoteFor(ORG, null), 'dev-owner-f');
    const list = crashReports(owner);
    expect(list.some((c) => c.id.startsWith('crash-U-FVIEW-'))).toBe(true);
    // eslint-disable-next-line no-console
    console.log('في قائمة المالك:', list.length, 'تقريراً · منها مزوّرٌ بمسار collect:', list.filter((c) => c.id.startsWith('fake-crash-')).length,
      '· باسم الكاتب المكتوب:', [...new Set(list.map((c) => c.who))],
      '· وسطور «مرفوض عند الوصول» من مستندات الحذف المزوّرة:', owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'audit_log'`)!.n);
    // عضوٌ آخر (COLLECTOR) يسحب: لا تقرير لغيره
    const { docs } = await remoteFor(COLLECTOR.uid!, COLLECTOR).pull(null, 500);
    expect(docs.some((x) => x.d?.entity_type === 'تقرير عطل' && String(x.d?.id).startsWith('crash-U-FVIEW-'))).toBe(false);
  });
});
