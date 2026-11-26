/**
 * المدقق الخارجي J · الجولة الخامسة · retryCrashRank (engine.ts:2100) بالقواعد الحقيقية على محاكي Firestore، كما هي في 662e4ae.
 * جهاز عضوٍ بلا اتصال تسعة أيام يقع له عطلٌ واحد · حين يعود الاتصال ترفض memberCrashReport التقرير (crashDayOk: يومه قبل ثمانية أيام)،
 * فيعيده المحرّك بالرتبة التالية للرفض نفسه حتى حدّ اليوم · فيصير عشرين صفاً على الجهاز وعشرين كتابةً مرفوضة.
 *   npx firebase emulators:exec --only firestore --project demo-aqari "TZ=Asia/Riyadh npx jest -i tests/auditJ.crashRetry.emulator.test.ts"
 * البيانات مصطنعة كلها.
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc, WriteResult } from '@/sync/types';
import { memberTokens, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';
import type { Access } from '@/domain/access/access';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'OWNERJ';
const d = HOST ? describe : describe.skip;

function token(uid: string, email = uid.toLowerCase() + '@example.test'): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
async function putDoc(path: string, data: Record<string, unknown>, uid: string): Promise<number> {
  const res = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) },
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  return res.status;
}

d('J١١ · إعادة رتبة تقرير العطل على رفضٍ لا تغيّره الرتبة', () => {
  const M: Access = { owner: false, uid: 'U-JOFF', perms: { props: 1 }, allProps: true, props: [] };
  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    expect(await putDoc(`orgs/${ORG}/members/${M.uid}`, {
      email: M.uid!.toLowerCase() + '@example.test', perm: M.perms, all: M.allProps, props: M.props, tokens: memberTokens(M),
    }, ORG)).toBe(200);
  });

  test('عطلٌ واحد قبل تسعة أيام بلا اتصال: عشرون صفاً على جهاز العضو وعشرون كتابةً مرفوضة، ولا يصل المالكَ شيء', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    const { getMeta } = await import('@/repos/settings');
    const { recordCrashReport, CRASH_ENTITY } = await import('@/domain/crashReport');
    const db = memDb();
    enableSync(db, M.uid!);
    db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'عضو مصطنع' } })]);
    const remote = new FirestoreRemote({
      projectId: PROJECT, uid: M.uid!, org: ORG, idToken: async () => token(M.uid!), baseUrl: 'http://' + HOST,
      memberTokens: () => memberTokens(M),
      fullReadTables: () => fullReadTables(M, SYNC_TABLES.map((t) => t.name)),
      access: () => M,
    });
    expect(remote.memberMode).toBe(true);
    // عدّاد كتابات التقرير ونتائجها كما ردّتها القواعد
    const results: string[] = [];
    const write0 = remote.write.bind(remote);
    remote.write = async (docs: RemoteDoc[]): Promise<WriteResult[]> => {
      const res = await write0(docs);
      docs.forEach((x, i) => { if (x.t === 'audit_log' && x.d?.entity_type === CRASH_ENTITY) results.push(x.k.replace(/^crash-[^-]+-/, '') + ':' + (res[i].ok ? 'ok' : res[i].code)); });
      return res;
    };
    const dev = getMeta(db, 'device_id')!;
    await syncOnce(db, remote, dev);
    const at = new Date(Date.now() - 9 * 86400000);
    expect(recordCrashReport(db, { where: 'موضع مصطنع', e: new Error('عطل مصطنع'), platform: 'android', at })).toBe(true);
    await syncOnce(db, remote, dev);
    const local = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = ?`, [CRASH_ENTITY])!.n;
    // eslint-disable-next-line no-console
    console.log('J11 (محاكي) · صفوف التقرير على الجهاز:', local, '· كتابات التقرير ونتائجها:', results.join(' '));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((x) => x.endsWith('PERMISSION_DENIED'))).toBe(true);
    expect(local).toBe(1);
  });
});
