/**
 * المدقق الخارجي S · الجولة العاشرة · على 7e3b492 · بيانات مصطنعة كلها.
 * S٥: حفظ كشف البنك (bankStatement/store.ts: saveStatement) يكتب صفّ البنك نفسه (UPDATE banks SET stmt_mapping)، فيرفعه جهاز العضو مع
 * الكشف · والجدول في DESIGN §١٣.٢٢ يجيز لـ«البنوك ٢» قراءة الكشف وحفظه «ويحفظ ربط أعمدته لبنكه»، وقاعدة السحابة لا تجيز لـ«البنوك ٢» تعديل
 * صفّ البنك (القسم يملكه، فتعديله لـ«كامل» ٣) · فكل كشفٍ يحفظه عضو البنوك (إدخال) يترك على جهازه رفضاً «خارج صلاحيتك» لصفّ البنك، ولا
 * يصل ربط الأعمدة السحابة · ولعضو «كامل» يصل صفّ البنك جهازَ المالك في كل كشف (فيكثر ما يمرّ بمسار keepOpening في S٢).
 * السلوك الصحيح: ما يجيزه التطبيق لـ«البنوك ٢» يُرفع بلا رفض (ربطٌ في جدولٍ له، أو قاعدةٌ تجيز الحقل وحده).
 *   firebase emulators:exec --only firestore --project demo-aqari "TZ=Asia/Riyadh npx jest -i tests/d4.auditS.statementBank.emulator.test.ts"
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { Access } from '@/domain/access/access';
import { memberTokens, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'OWNER-S10B';
const d = HOST ? describe : describe.skip;

function token(uid: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email: uid.toLowerCase() + '@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
function remoteFor(uid: string, a: Access | null): FirestoreRemote {
  return new FirestoreRemote({
    projectId: PROJECT, uid, org: ORG, idToken: async () => token(uid), baseUrl: 'http://' + HOST,
    memberTokens: () => (a ? memberTokens(a) : null),
    fullReadTables: () => (a ? fullReadTables(a, SYNC_TABLES.map((t) => t.name)) : new Set()),
    access: () => a ?? { owner: true, uid, perms: {}, allProps: true, props: [] },
  });
}

d('S5 · عضو البنوك (إدخال) يحفظ كشفاً', () => {
  const M: Access = { owner: false, uid: 'U-S10B', perms: { banks: 2 }, allProps: true, props: [] };
  test('S5: الكشف يُرفع، وصفّ البنك (ربط الأعمدة) يُرفض «خارج صلاحيتك» على جهاز العضو', async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addBank } = await import('./helpers/fixtures');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    const { readStatementGrid } = await import('@/domain/bankStatement/read');
    const { saveStatement } = await import('@/domain/bankStatement/store');
    const owner = memDb();
    enableSync(owner, ORG);
    const A = addBank(owner, 'بنك مصطنع S10B', 0);
    expect((await syncOnce(owner, remoteFor(ORG, null), 'dev-owner-s10b')).pending).toBe(0);
    expect((await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/members/${M.uid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(ORG) },
      body: JSON.stringify({ fields: encodeFields({ email: M.uid!.toLowerCase() + '@example.test', perm: M.perms, all: true, props: [], tokens: memberTokens(M) }) }),
    })).status).toBe(200);

    // جهاز العضو
    const member = memDb();
    enableSync(member, M.uid!);
    member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'عضو مصطنع S10B' } })]);
    member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [ORG]);
    const rm = remoteFor(M.uid!, M);
    await syncOnce(member, rm, 'dev-member-s10b');
    await syncOnce(member, rm, 'dev-member-s10b');
    expect(member.get(`SELECT 1 FROM banks WHERE id = ?`, [A])).toBeTruthy();

    const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/02', 'إيداع نقدي مصطنع', '', '5,000.00', '5,000.00'], ['2026/10/05', 'رسوم خدمة مصطنعة', '15.00', '', '4,985.00']]);
    if (!r.ok) throw new Error(r.error);
    const saved = saveStatement(member, A, r, { name: 'oct-s10b.pdf', hash: 'h-s10b' });
    expect(saved.added).toBe(2);
    await syncOnce(member, rm, 'dev-member-s10b');
    const out = {
      rejects: member.all<{ tbl: string; reason: string }>(`SELECT tbl, reason FROM sync_rejects`).map((x) => x.tbl + ': ' + x.reason),
      statementInCloud: (await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/rows/bank_statements__${saved.statementId}`,
        { headers: { Authorization: 'Bearer ' + token(ORG) } })).status,
    };
    // eslint-disable-next-line no-console
    console.log('S5', JSON.stringify(out));
    expect(out.statementInCloud).toBe(200); // الكشف نفسه وصل
    expect(out.rejects).toEqual([]);
    owner.close();
    member.close();
  });
});
