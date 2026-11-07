/**
 * المدقق Z1 · الجولة الثالثة عشرة · المعرّفات الحتمية للكشف وسطوره (src/domain/bankStatement/store.ts:43-44 و48-67 · db011e7) في قاعدة
 * السحابة · بياناتٌ مصطنعة كلها · يعمل على المحاكي وحده (ويُتخطّى بدونه):
 *   npx firebase emulators:exec --only firestore --project demo-aqari "TZ=Asia/Riyadh npx jest -i tests/d4.auditZ1.reimportRules.emulator.test.ts"
 *
 * Z1-5 · متوسط: «البنوك ٢» تقرأ كشفاً وتحفظ سطوره (DESIGN §١٣.٢٢ · جدول الصلاحيات)، والقاعدة تجيز لها الإنشاء وحده (opWrites.banks.create)
 * والتعديل للبنوك ٣ (memberUpdates: owns && level >= 3) · وكان الكشف المعاد بعد حذفه بمعرّفاتٍ جديدة (uid) فيُنشأ · ومنذ db011e7 معرّف الكشف من
 * البنك وبصمة الملف ومعرّف السطر من بصمته، ومستنداتهما المحذوفة حذفاً ناعماً باقيةٌ في السحابة، فإعادة قراءة الملف نفسه بعد حذفه (أشيع
 * سببٍ للحذف: ربطٌ أو بنكٌ خطأ) تحييهما «تعديلاً» يُرفض كله «خارج صلاحيتك»: لا يصل الكشف إلى المالك، ويختفي من جهاز العضو نفسه بعد أن
 * قيل له «حُفظ الكشف · ٢ حركة جديدة» (ولا يحفظه ثانيةً: «لا جديد» أو يُرفض مرةً أخرى).
 * لماذا يهم: موظف الإدخال لا يستطيع إعادة كشفٍ حُذف أبداً، ولا أثر عند المالك إلا سطور «المرفوض».
 * السلوك الصحيح: ما تجيزه الشاشة والقرار للبنوك ٢ (قراءة الكشف وحفظ سطوره) يُقبل في السحابة: الكشف المعاد حيٌّ بسطوره عند المالك، ولا رفض.
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { Access } from '@/domain/access/access';
import { memberTokens, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const d = HOST ? describe : describe.skip;

function token(uid: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email: uid.toLowerCase() + '@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
function remoteFor(org: string, uid: string, a: Access | null): FirestoreRemote {
  return new FirestoreRemote({
    projectId: PROJECT, uid, org, idToken: async () => token(uid), baseUrl: 'http://' + HOST,
    memberTokens: () => (a ? memberTokens(a) : null),
    fullReadTables: () => (a ? fullReadTables(a, SYNC_TABLES.map((t) => t.name)) : new Set()),
    access: () => a ?? { owner: true, uid, perms: {}, allProps: true, props: [] },
  });
}

d('Z1-5 · [متوسط] عضو «البنوك ٢» يعيد قراءة كشفٍ حُذف فتُرفض كتابته كلها «خارج صلاحيتك» (store.ts:43-44 · المعرّف الحتمي يجعل الإنشاء تعديلاً)', () => {
  test('المالك يحفظ كشف أكتوبر ثم يحذفه، والعضو يعيد قراءة الملف نفسه: الكشف حيٌّ بسطريه عند المالك، ولا رفض عند العضو', async () => {
    const org = 'OWNER-Z1-5';
    const M: Access = { owner: false, uid: 'U-Z1-5', perms: { banks: 2 }, allProps: true, props: [] };
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addBank } = await import('./helpers/fixtures');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    const { readStatementGrid } = await import('@/domain/bankStatement/read');
    const { saveStatement, deleteStatement } = await import('@/domain/bankStatement/store');
    const owner = memDb();
    enableSync(owner, org);
    const bank = addBank(owner, 'بنك مصطنع Z1-5', 0);
    const ro = remoteFor(org, org, null);
    const oct = () => {
      const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
        ['2026/10/02', 'حوالة واردة مصطنعة', '', '1,000.00', '1,000.00'], ['2026/10/05', 'رسوم مصطنعة', '5.00', '', '995.00']]);
      if (!r.ok) throw new Error(r.error);
      return r;
    };
    // المالك يحفظ الكشف ثم يحذفه (قُرئ لبنكٍ خطأ أو بربطٍ خطأ)
    const P = saveStatement(owner, bank, oct(), { name: 'oct-z1-5.pdf', hash: 'z1-5' });
    await syncOnce(owner, ro, 'dev-owner-z1-5');
    deleteStatement(owner, P.statementId);
    expect((await syncOnce(owner, ro, 'dev-owner-z1-5')).pending).toBe(0);
    expect((await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${org}/members/${M.uid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(org) },
      body: JSON.stringify({ fields: encodeFields({ email: M.uid!.toLowerCase() + '@example.test', perm: M.perms, all: true, props: [], tokens: memberTokens(M) }) }),
    })).status).toBe(200);

    // عضو الإدخال يعيد قراءة الملف نفسه ويحفظه (كما تجيزه الشاشة للبنوك ٢)
    const member = memDb();
    enableSync(member, M.uid!);
    member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org, profile: { name: 'عضو مصطنع Z1-5' } })]);
    member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [org]);
    const rm = remoteFor(org, M.uid!, M);
    await syncOnce(member, rm, 'dev-member-z1-5');
    await syncOnce(member, rm, 'dev-member-z1-5');
    const again = saveStatement(member, bank, oct(), { name: 'oct-z1-5.pdf', hash: 'z1-5' });
    expect(again.added).toBe(2);
    await syncOnce(member, rm, 'dev-member-z1-5');
    await syncOnce(owner, ro, 'dev-owner-z1-5');
    await syncOnce(owner, ro, 'dev-owner-z1-5');

    const out = {
      memberRejects: member.all<{ tbl: string; reason: string }>(`SELECT tbl, reason FROM sync_rejects`).map((x) => x.tbl + ': ' + x.reason),
      ownerStatementLive: !!owner.get(`SELECT 1 FROM bank_statements WHERE id = ? AND deleted_at IS NULL`, [again.statementId]),
      ownerLiveLines: Number(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL`, [bank])!.n),
    };
    // (الواقع: ثلاثة رفوض «خارج صلاحيتك» (الكشف وسطراه)، والكشف محذوفٌ عند المالك بلا سطرٍ حيّ)
    expect(out).toEqual({ memberRejects: [], ownerStatementLive: true, ownerLiveLines: 2 });
    owner.close();
    member.close();
  });
});
