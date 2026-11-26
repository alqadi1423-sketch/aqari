/**
 * المدقق الخارجي H · الجولة الرابعة · قاعدة تقرير العطل (memberCrashReport) كما هي في 97d0beb، على محاكي Firestore.
 * قرار المالك 2026-11-07 «نعم توصلني»: تقارير أعطال الأعضاء تصل المالك وحده، محجوبةً، بحدٍّ للحجم ولليوم، وتُرى في شاشة الحال.
 *
 * يعمل حين يكون المحاكي قائماً ويُتخطّى غير ذلك:
 *   npx firebase emulators:exec --only firestore --project demo-aqari "TZ=Asia/Riyadh npx jest -i tests/auditH.crashRules.emulator.test.ts"
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
const ORG = 'OWNERH';
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

/** يوم UTC بصيغة المعرّف (crashDay) لتاريخٍ بعد اليوم بأيامٍ عددها off */
const dayOf = (off: number) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10).replace(/-/g, '');

d('H · قاعدة تقرير العطل', () => {
  // أعضاءٌ قرّاءٌ فقط (لا قسم إدخال)
  const PIN1 = member('U-HPIN1', { props: 1 }, 'all');
  const PIN2 = member('U-HPIN2', { props: 1 }, 'all');
  const GEN = member('U-HGEN', { props: 1 }, 'all');
  const TWO = member('U-HTWO', { props: 1 }, 'all');
  const ALIAS = member('U-HALIAS', { props: 1 }, 'all');

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    for (const a of [PIN1, PIN2, GEN, TWO, ALIAS]) {
      expect(await putDoc(`orgs/${ORG}/members/${a.uid}`, {
        email: a.uid!.toLowerCase() + '@example.test', perm: a.perms, all: a.allProps, props: a.props, tokens: memberTokens(a),
      }, ORG)).toBe(200);
    }
  });

  /** جهاز عضو: قاعدةٌ بحسابه وعضويته */
  const device = async (a: Access): Promise<DB> => {
    const { memDb } = await import('./helpers/testDb');
    const db = memDb();
    db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('uid', ?)`, [a.uid]);
    db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'عضو مصطنع' } })]);
    return db;
  };
  /** تقرير عطلٍ سليمٌ كما يكتبه جهاز العضو ويزيّنه annotate */
  const legit = async (db: DB, a: Access) => {
    const { buildDoc } = await import('@/sync/engine');
    const { recordCrashReport } = await import('@/domain/crashReport');
    expect(recordCrashReport(db, { where: 'موضع مصطنع', e: new Error('عطل مصطنع'), platform: 'android' })).toBe(true);
    const k = db.get<{ id: string }>(`SELECT id FROM audit_log ORDER BY rowid DESC LIMIT 1`)!.id;
    return annotate(db, buildDoc(db, 'audit_log', k, 'upsert', new Date().toISOString(), 'dev-h'), a).doc;
  };
  const write = async (a: Access, doc: RemoteDoc) => (await remoteFor(a.uid!, a).write([doc]))[0];
  /** المستند نفسه بمعرّفٍ آخر (يومٌ ورتبة) ووقتٍ آخر */
  const reshape = (base: RemoteDoc, uid: string, day: string, rank: number, ts: string): RemoteDoc => {
    const id = `crash-${uid}-${day}-${rank}`;
    return { ...base, id: 'audit_log__' + id, k: id, d: { ...base.d!, id, ts } };
  };

  test('H1 · وقت التقرير (ts) بلا حدٍّ في القاعدة: عضوٌ يكتب تقارير بوقتٍ في 9999 فتبقى أول قائمة المالك وسجلّه أبداً وتطرد التقارير الحقيقية من الشاشة', async () => {
    const FAR = '9999-12-31T23:59:59';
    // عضوٌ قارئٌ فقط: كل يومٍ تقبله القاعدة (ثمانية مضت وغد) × الرتب ٠–١٩، بوقتٍ في 9999
    const db1 = await device(PIN1);
    const base1 = await legit(db1, PIN1);
    let ok1 = 0;
    for (let off = -7; off <= 1; off++) {
      for (let rank = 0; rank < 20; rank++) {
        if ((await write(PIN1, reshape(base1, PIN1.uid!, dayOf(off), rank, FAR))).ok) ok1++;
      }
    }
    // وعضوٌ ثانٍ مثله ليومه وحده
    const db2 = await device(PIN2);
    const base2 = await legit(db2, PIN2);
    let ok2 = 0;
    for (let rank = 0; rank < 20; rank++) if ((await write(PIN2, reshape(base2, PIN2.uid!, dayOf(0), rank, FAR))).ok) ok2++;

    // ثم عضوٌ ثالث يقع له عطلٌ حقيقي اليوم (المسار المشروع حرفاً)
    const dbg = await device(GEN);
    const genuine = await legit(dbg, GEN);
    expect((await write(GEN, genuine)).ok).toBe(true);

    // جهاز المالك يسحب
    const { memDb } = await import('./helpers/testDb');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    const { crashReports } = await import('@/domain/crashReport');
    const owner = memDb();
    enableSync(owner, ORG);
    for (let i = 0; i < 5; i++) await syncOnce(owner, remoteFor(ORG, null), 'dev-owner-h');
    const inDb = owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'تقرير عطل'`)!.n;
    const list = crashReports(owner);
    const inYear = crashReports(owner, 30, new Date(Date.now() + 400 * 86400000));
    // الصفحة الأولى من شاشة سجل العمليات (app/audit-log.tsx: ORDER BY ts DESC LIMIT ? OFFSET ?)
    const auditTop = owner.all<{ id: string; ts: string }>(`SELECT id, ts FROM audit_log ORDER BY ts DESC LIMIT 5`);
    // eslint-disable-next-line no-console
    console.log('H1 · قُبل بوقتٍ في 9999:', ok1, '+', ok2, '· تقارير العطل على جهاز المالك:', inDb,
      '· في شاشة الحال (حدّها ٢٠٠):', list.length, '· منها الحقيقي:', list.some((c) => c.id === genuine.k),
      '· وبعد ٤٠٠ يوم ما زال فيها:', inYear.length, '· أول سجل العمليات:', auditTop.map((r) => r.ts).join(' | '));

    // القاعدة نفسها تحدّ وقت «العضو عن نفسه» (selfAuditNotAhead: «وقتٌ بعيدٌ يبقى أول السجل») · وتقرير العطل بلا هذا الحد
    expect(ok1 + ok2).toBe(0);
    expect(list.some((c) => c.id === genuine.k)).toBe(true);
  });

  test('H2 · عضوٌ بجهازين (أو أعاد التثبيت) في اليوم نفسه: تقرير الجهاز الثاني يأخذ رتبةً أخذها الأول فيُرفض ويُسقط بصمت', async () => {
    const devA = await device(TWO);
    const devB = await device(TWO);
    const a = await legit(devA, TWO);
    const b = await legit(devB, TWO);
    const ra = await write(TWO, a);
    const rb = await write(TWO, b);
    // eslint-disable-next-line no-console
    console.log('H2 · معرّف الجهاز الأول:', a.k, ra.ok, '· الثاني:', b.k, rb.ok, rb.code);
    // الرتبة واحدةٌ للحساب في يومه (فالحدّ عشرون أياً كان جهازه): الثاني يُرفض أول مرة، ثم يعيده جهازه بالرتبة التالية (retryCrashRank ·
    // إصلاح H٢) فيصل المالك
    expect(rb.ok).toBe(false);
    const { retryCrashRank } = await import('@/domain/crashReport');
    const { buildDoc } = await import('@/sync/engine');
    expect(retryCrashRank(devB, b.d as Record<string, unknown>)).toBe(true);
    const k2 = devB.get<{ id: string }>(`SELECT id FROM audit_log ORDER BY rowid DESC LIMIT 1`)!.id;
    expect(k2).toBe(b.k.replace(/-0$/, '-1'));
    const b2 = annotate(devB, buildDoc(devB, 'audit_log', k2, 'upsert', new Date().toISOString(), 'dev-h2'), TWO).doc;
    const rb2 = await write(TWO, b2);
    // eslint-disable-next-line no-console
    console.log('H2 · بعد الإعادة:', k2, rb2.ok);
    expect(rb2.ok).toBe(true);
  });

  test('صمد · يومٌ مشوّه يطبّعه غيرُ القاعدة إلى يومٍ في النافذة (٣٨ من الشهر السابق، ويوم ٠٠) لا يمرّ فيضاعف الحد', async () => {
    const db = await device(ALIAS);
    const base = await legit(db, ALIAS);
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + 1;
    const dd = now.getUTCDate();
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    // اليوم بصيغٍ مشوّهة يطبّعها من يطبّع (شهرٌ سابق بيومٍ فوق ٣١، ويوم ٠٠ للشهر التالي، وشهر ١٣ للسنة السابقة)
    const prevM = m === 1 ? 12 : m - 1;
    const prevY = m === 1 ? y - 1 : y;
    const daysPrev = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
    const aliases = [
      `${prevY}${pad(prevM)}${pad(daysPrev + dd)}`,
      `${y}${pad(m)}${pad(0)}`,
      ...(m === 1 ? [`${y - 1}13${pad(dd)}`] : []),
    ];
    const accepted: string[] = [];
    for (const day of aliases) {
      if ((await write(ALIAS, reshape(base, ALIAS.uid!, day, 0, new Date().toISOString().slice(0, 19)))).ok) accepted.push(day);
    }
    // eslint-disable-next-line no-console
    console.log('صمد · أيامٌ مشوّهة قُبلت:', accepted, 'من', aliases);
    expect(accepted).toEqual([]);
  });
});
