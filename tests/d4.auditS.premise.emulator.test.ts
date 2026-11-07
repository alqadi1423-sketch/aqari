/**
 * المدقق الخارجي S · الجولة العاشرة · على 7e3b492 · بيانات مصطنعة كلها.
 * شواهد القاعدة الحقيقية (firestore.rules) لما تفترضه اختبارات S (هذا الملف يمرّ على 7e3b492: يثبت أن مستندات العضو فيها تقبلها السحابة،
 * لا أنها حُقنت):
 *  - S١: حركة بنكٍ جديدة من عضوٍ (البنوك أو المشتريات) برقم قيدٍ يدويٍّ للمالك و«u» مؤخَّرٍ إلى سنة 2000 تُقبل (القاعدة: r.u is string وحده).
 *  - S١ب: عاكسٌ «مرحّل» بمصدر manual_rev ليس مرآة أصله (عضو الدفتر كامل) يُقبل، ثم ربط قيد المالك به يُقبل.
 *  - S٢: تسمية العضو للبنك وللحساب 1100 بافتتاحيّ السحابة تُقبل (كـ Q١)، وتغيير مجموعة حسابٍ غير نظامي يُقبل (كـ Q١ب).
 *  - S٣ب: عضو المشتريات (كامل) يغيّر طريقة سداد فاتورةٍ سدّدها المالك نقداً وبنكَها: يُقبل.
 *   firebase emulators:exec --only firestore --project demo-aqari "TZ=Asia/Riyadh npx jest -i tests/d4.auditS.premise.emulator.test.ts"
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import type { Access } from '@/domain/access/access';
import { memberTokens, annotate, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'OWNER-S10';
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

d('S · شواهد القاعدة لاختبارات S١ وS١ب وS٢ وS٣ب', () => {
  const M: Access = { owner: false, uid: 'U-S10', perms: { banks: 3, ledger: 3, purchases: 3, props: 1 }, allProps: true, props: [] };
  let db: import('@/db/adapter').DB;
  let engine: typeof import('@/sync/engine');
  let A = '';
  let entry = { id: '', no: '' };
  let pid = '';

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { memDb } = await import('./helpers/testDb');
    const { addBank } = await import('./helpers/fixtures');
    const { postEntry } = await import('@/domain/accounting/post');
    const { ownerCashIn } = await import('@/domain/cashOps');
    const { savePurchase, payPurchase } = await import('@/domain/purchases');
    engine = await import('@/sync/engine');
    db = memDb();
    engine.enableSync(db, ORG);
    A = addBank(db, 'بنك فارغ مصطنع S10', 0);
    db.run(`INSERT INTO accounts (code, name, type, grp, opening_halalas, created_at) VALUES ('1180', 'عهدة مصطنعة S10', 'أصل', 'النقدية وما في حكمها', 100000, ?)`, [new Date().toISOString()]);
    ownerCashIn(db, { amountHalalas: 600000, date: '2026-10-01' });
    const e = postEntry(db, { date: '2026-10-02', memo: 'رواتب نقداً مصطنعة S10', lines: [
      { account: '5200', descr: 'رواتب مصطنعة', debit: 300000, credit: 0 },
      { account: '1100', descr: 'نقداً من المحفظة', debit: 0, credit: 300000 }] })!;
    entry = { id: e.id, no: e.no };
    db.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
      ['SUP-S10', 'مورد مصطنع S10', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
    pid = savePurchase(db, {
      supplier: 'مورد مصطنع S10', date: '2026-10-02', due: '2026-11-02', category: 'صيانة', incorpItem: '', amortize: false,
      amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: null, propertyId: null, meterId: null, meterReading: null,
      subtotalHalalas: 100000, taxHalalas: 0, totalHalalas: 100000,
    } as never);
    payPurchase(db, pid, 'cash', null, '2026-10-02');
    expect((await engine.syncOnce(db, remoteFor(ORG, null), 'dev-owner-s10')).pending).toBe(0);
    db.exec((await import('@/db/schema')).MIGRATION_42);
    const put = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/members/${M.uid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(ORG) },
      body: JSON.stringify({ fields: encodeFields({ email: M.uid!.toLowerCase() + '@example.test', perm: M.perms, all: true, props: [], tokens: memberTokens(M) }) }),
    });
    expect(put.status).toBe(200);
  });

  const write = async (doc: RemoteDoc) => (await remoteFor(M.uid!, M).write([annotate(db, doc, M).doc]))[0];
  const docOf = (t: string, k: string, over: Record<string, unknown>, u: string): RemoteDoc => {
    const base = engine.buildDoc(db, t, k, 'upsert', '2026-11-07T00:00:00.000Z', 'dev-s10');
    return { ...base, u, d: { ...base.d!, ...over } as RemoteDoc['d'] };
  };

  test('S1: حركة بنكٍ جديدة بـ«u» سنة 2000 برقم قيد رواتب المالك من بنكٍ فارغ تُقبل', async () => {
    const k = 'S10-TX-1';
    const doc: RemoteDoc = { id: 'bank_tx__' + k, t: 'bank_tx', k, u: '2000-01-01T00:00:00.000Z', dev: 'dev-member-s10', del: false,
      d: { id: k, bank_id: A, date: '2026-10-02', descr: 'حركة مصطنعة S10', amount_halalas: -300000, matched: 1, journal_no: entry.no,
        source: 'سداد مصطنع', created_at: '2000-01-01T00:00:00.000Z', deleted_at: null } };
    expect(['banks', 'purchases']).toContain(annotate(db, doc, M).doc.op);
    expect(await write(doc)).toMatchObject({ ok: true });
  });

  test('S1b: عاكسٌ مرحّل manual_rev ليس مرآةً يُقبل، وربط قيد الرواتب به يُقبل', async () => {
    const base = engine.buildDoc(db, 'journal_entries', entry.id, 'upsert', '2026-11-07T00:00:00.000Z', 'dev-s10');
    const R = 'S10-REV';
    const rev: RemoteDoc = { ...base, id: 'journal_entries__' + R, k: R, u: new Date().toISOString(),
      d: { ...base.d!, id: R, no: 'S10-REV-NO', src_type: 'manual_rev', src_id: entry.id, reversed_by: null },
      lines: base.lines!.map((l, i) => ({ ...l, id: R + '-l' + i, entry_id: R })) };
    expect(annotate(db, rev, M).doc.op).toBe('ledger');
    expect(await write(rev)).toMatchObject({ ok: true });
    expect(await write({ ...base, u: new Date().toISOString(), d: { ...base.d!, reversed_by: R } })).toMatchObject({ ok: true });
  });

  test('S2: تسمية البنك والحساب 1100 بافتتاحيّ السحابة، ومجموعة حسابٍ غير نظامي: تُقبل', async () => {
    const r = [await write(docOf('banks', A, { name: 'تسمية العضو مصطنعة S10' }, new Date().toISOString())),
      await write(docOf('accounts', '1100', { name: 'النقدية · تسمية العضو مصطنعة' }, new Date().toISOString())),
      await write(docOf('accounts', '1180', { grp: 'مجموعة أخرى مصطنعة' }, new Date().toISOString()))];
    expect(r.map((x) => x.ok)).toEqual([true, true, true]);
  });

  test('S3b: عضو المشتريات يجعل طريقة سداد الفاتورة النقدية «تحويل بنكي» وبنكها: يُقبل', async () => {
    const doc = docOf('purchases', pid, { payment_method: 'تحويل بنكي', payment_bank_id: A }, new Date().toISOString());
    expect(annotate(db, doc, M).doc.op).toBe('purchases');
    expect(await write(doc)).toMatchObject({ ok: true });
  });
});
