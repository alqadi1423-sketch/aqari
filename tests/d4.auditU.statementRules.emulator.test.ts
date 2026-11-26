/**
 * المدقق الخارجي U · الجولة العاشرة · كشف البنك في قاعدة السحابة (opWrites.banks · DESIGN §١٣.٢٢): «يعتمد مطابقةً … ويستبعد سطراً بسبب»
 * للبنوك ٣ وحده، و«يقرأ كشفاً ويحفظ سطوره» للبنوك ٢ · والقاعدة تجيز للبنوك ٢ إنشاء سطر الكشف بأي حالة: «مطابَق» بحركةٍ أو «مستبعَد»
 * بسبب، فيتخطى الاعتماد كما كانت الفاتورة تتخطى «الإصدار» قبل حارس المسودة في memberCreates · بياناتٌ مصطنعة.
 *   npx firebase emulators:exec --only firestore --project demo-aqari "TZ=Asia/Riyadh npx jest -i tests/d4.auditU.statementRules.emulator.test.ts"
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import type { Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'OWNER-U10';
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

d('U٢٤ وU٢٥ · عضو البنوك ٢: ينشئ سطر كشفٍ «مطابَقاً» أو «مستبعَداً» فيتخطى الاعتماد، ولا يحفظ ربط الأعمدة لبنكه', () => {
  // ذو الإدخال في البنوك: يقرأ الكشف ويحفظ سطوره، ولا يعتمد ولا يستبعد (DESIGN §١٣.٢٢)
  const M: Access = { owner: false, uid: 'U-U10', perms: { banks: 2 }, allProps: true, props: [] };
  let db: import('@/db/adapter').DB;
  let buildDoc: typeof import('@/sync/engine').buildDoc;
  let stmtId = '';
  let lineIds: string[] = [];
  let txId = '';
  let bankId = '';

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addBank } = await import('./helpers/fixtures');
    const cash = await import('@/domain/cashOps');
    const { readStatementGrid } = await import('@/domain/bankStatement/read');
    const { saveStatement } = await import('@/domain/bankStatement/store');
    const engine = await import('@/sync/engine');
    buildDoc = engine.buildDoc;
    db = memDb();
    const bank = addBank(db, 'بنك مصطنع U10', 0);
    bankId = bank;
    cash.ownerCashIn(db, { amountHalalas: 1000000, date: '2026-10-01' });
    cash.depositCashToBank(db, { bankId: bank, amountHalalas: 50000, date: '2026-10-05', notes: 'إيداع مصطنع' });
    txId = db.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ?`, [bank])!.id;
    engine.enableSync(db, ORG);
    const r0 = await engine.syncOnce(db, remoteFor(ORG, null), 'dev-owner');
    expect(r0.pending).toBe(0);
    // كشفٌ يقرؤه العضو على جهازه (لم يُرفع بعد)
    const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/05', 'إيداع مصطنع', '', '500.00', '500.00'], ['2026/10/06', 'رسوم مصطنعة', '5.00', '', '495.00'],
      ['2026/10/07', 'حوالة مصطنعة', '', '100.00', '595.00']]);
    if (!r.ok) throw new Error(r.error);
    stmtId = saveStatement(db, bank, r, { name: 'u10.csv', hash: 'u10' }).statementId;
    lineIds = db.all<{ id: string }>(`SELECT id FROM bank_statement_lines WHERE statement_id = ? ORDER BY date`, [stmtId]).map((x) => x.id);
    const put = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/members/${M.uid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(ORG) },
      body: JSON.stringify({ fields: encodeFields({ email: M.uid!.toLowerCase() + '@example.test', perm: M.perms, all: true, props: [], tokens: memberTokens(M) }) }),
    });
    expect(put.status).toBe(200);
  });

  const write = async (doc: RemoteDoc) => (await remoteFor(M.uid!, M).write([annotate(db, doc, M).doc]))[0];
  const docOf = (t: string, k: string, over: Record<string, unknown>, u: string): RemoteDoc => {
    const base = buildDoc(db, t, k, 'upsert', '2026-11-07T00:00:00.000Z', 'dev-u10');
    return { ...base, u, d: { ...base.d!, ...over } as RemoteDoc['d'] };
  };
  const DENIED = { ok: false, code: 'PERMISSION_DENIED' };

  test('حفظ الكشف وسطره المفتوح يُقبلان (البنوك ٢ كما في الجدول)', async () => {
    expect(await write(docOf('bank_statements', stmtId, {}, 's1'))).toMatchObject({ ok: true });
    expect(await write(docOf('bank_statement_lines', lineIds[2], {}, 'l3'))).toMatchObject({ ok: true });
  });

  test('سطرٌ جديد «مطابَق» بحركةٍ، أو «مستبعَد» بسبب، يُرفض من البنوك ٢', async () => {
    expect(await write(docOf('bank_statement_lines', lineIds[0], { status: 'matched', bank_tx_id: txId, matched_at: '2026-11-07T00:00:00.000Z' }, 'l1')))
      .toMatchObject(DENIED);
    expect(await write(docOf('bank_statement_lines', lineIds[1], { status: 'excluded', note: 'سببٌ مصطنع' }, 'l2'))).toMatchObject(DENIED);
  });

  test('U٢٥ · ربط الأعمدة يُحفظ في صفّ الكشف لا في صفّ البنك (S٥): saveStatement لا يمسّ البنك، فلا كتابةَ تُرفض للبنوك ٢', async () => {
    expect(db.get<{ m: string }>(`SELECT stmt_mapping AS m FROM banks WHERE id = ?`, [bankId])!.m).toBe('');
    expect(db.get<{ m: string }>(`SELECT mapping AS m FROM bank_statements WHERE id = ?`, [stmtId])!.m).not.toBe('');
    expect(db.get(`SELECT 1 FROM sync_outbox WHERE tbl = 'banks'`)).toBeUndefined();
  });
});
