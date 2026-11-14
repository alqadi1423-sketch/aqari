/**
 * المدقق W · الجولة الحادية عشرة · اعتماد التحصيل من كشف البنك في قاعدة السحابة · بياناتٌ مصطنعة كلها.
 *   npx firebase emulators:exec --only firestore --project demo-aqari "TZ=Asia/Riyadh npx jest -i tests/d4.auditW.approveRules.emulator.test.ts"
 *
 * W2 · عالٍ · الشاشة (app/bankStatement.tsx: canCollect) وجدول الصلاحيات (DESIGN §١٣.٢٢ · سجل القرارات ٥٩) يجيزان اعتماد تحصيل المطالبة
 * لمن له «البنوك ٣» ومعه «إدخال» (٢) في المطالبات، والفاتورة لمن معه «إدخال» في الفواتير · والاعتماد يعدّل صفّ المطالبة (الحالة وتاريخ
 * التحصيل) وصفّ الفاتورة (مدفوعة وقيد تحصيلها)، وقاعدة السحابة (rulesGen.ts: memberUpdates) لا تجيز تعديل جدول القسم إلا لـ«كامل» (٣)،
 * وصفّ الفاتورة غير المسودة لا يُكتب إلا لفواتير ٣ · فعضوٌ له الصلاحيتان كما يشترطها القرار يعتمد فيُسجَّل التحصيل على جهازه وتُرفع
 * القيود والحركة وسطر الكشف، ويُرفض صفّ المطالبة أو الفاتورة «خارج صلاحيتك»: في السحابة وعند المالك قيد تحصيلٍ وحركة بنكٍ لمطالبةٍ
 * ما زالت «مفتوحة» (جهاز المالك ينتظر وسم التحصيل ثم يرفض القيد والحركة) · فيفترق الجهازان في المال والذمة.
 * السلوك الصحيح: ما تجيزه الشاشة والقرار يُرفع كله بلا رفض (أو لا تجيزه الشاشة لمن لا تقبله القاعدة).
 * الإصلاح: الشاشة تشترط للمطالبة والفاتورة «كامل» في قسمهما كشاشتيهما (collectPermission · سجل القرارات ٥٩ معدَّلاً)، فالحالتان هنا
 * بالمستوى ٣ وتُقبلان كلهما · واختبار الشرط نفسه في tests/d6.bankStatementCollect.test.ts
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

async function scenario(org: string, M: Access, kind: 'claim' | 'invoice') {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  const { memDb } = await import('./helpers/testDb');
  const { addBank, addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
  const { enableSync, syncOnce } = await import('@/sync/engine');
  const { confirmContract } = await import('@/domain/contracts/service');
  const { saveClaim } = await import('@/domain/claims');
  const { saveInvoice } = await import('@/domain/invoices');
  const { readStatementGrid } = await import('@/domain/bankStatement/read');
  const { saveStatement } = await import('@/domain/bankStatement/store');
  const { collectionSuggestions, approveCollection } = await import('@/domain/bankStatement/collect');
  const owner = memDb();
  enableSync(owner, org);
  const bank = addBank(owner, 'بنك مصطنع W', 0);
  const prop = addProperty(owner, { name: 'عقار مصطنع W' });
  const c = confirmContract(owner, contractInput(addUnit(owner, prop, { unit_no: 'W-1' }), {
    tenant: 'وليد المصطنع', idNumber: '1000000901', phone: '0500000901', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const target = kind === 'claim'
    ? saveClaim(owner, { contractId: c, amountHalalas: 35000, reason: 'إصلاح مصطنع W', date: '2026-10-05' })
    : saveInvoice(owner, { customer: 'نجم المصطنع W', customerVat: '', issue: '2026-10-01', due: '2026-10-15', notes: '',
      lines: [{ descr: 'خدمة مصطنعة W', qty: 1, priceHalalas: 50000, taxPct: 15 }], propertyId: prop }, 'مستحقة');
  expect((await syncOnce(owner, remoteFor(org, org, null), 'dev-owner-w')).pending).toBe(0);
  expect((await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${org}/members/${M.uid}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(org) },
    body: JSON.stringify({ fields: encodeFields({ email: M.uid!.toLowerCase() + '@example.test', perm: M.perms, all: true, props: [], tokens: memberTokens(M) }) }),
  })).status).toBe(200);

  const member = memDb();
  enableSync(member, M.uid!);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org, profile: { name: 'عضو مصطنع W' } })]);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [org]);
  const rm = remoteFor(org, M.uid!, M);
  await syncOnce(member, rm, 'dev-member-w');
  await syncOnce(member, rm, 'dev-member-w');
  const amount = kind === 'claim' ? '350.00' : '575.00';
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/12', 'حوالة واردة مصطنعة', '', amount, amount]]);
  if (!r.ok) throw new Error(r.error);
  saveStatement(member, bank, r, { name: 'oct-w.csv', hash: 'h-w-' + kind });
  const sg = collectionSuggestions(member, bank);
  expect(sg.map((s) => s.target)).toEqual([kind === 'claim' ? { kind: 'claim', claimId: target } : { kind: 'invoice', invoiceId: target }]);
  approveCollection(member, sg[0].line.id, sg[0].target);
  await syncOnce(member, rm, 'dev-member-w');
  const rejects = member.all<{ tbl: string; reason: string }>(`SELECT tbl, reason FROM sync_rejects`).map((x) => x.tbl + ': ' + x.reason);
  const tbl = kind === 'claim' ? 'claims' : 'invoices';
  const cloud = await (await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${org}/rows/${tbl}__${target}`,
    { headers: { Authorization: 'Bearer ' + token(org) } })).json() as { fields?: { d?: { mapValue?: { fields?: Record<string, { stringValue?: string }> } } } };
  const status = cloud.fields?.d?.mapValue?.fields?.status?.stringValue ?? '';
  owner.close();
  member.close();
  return { rejects, status };
}

d('W2 · عضوٌ له «البنوك ٣» وصلاحية قسم الهدف كما تشترطها الشاشة يعتمد تحصيلاً من الكشف (سجل القرارات ٥٩)', () => {
  test('W2أ · المطالبة: البنوك ٣ والمطالبات ٣ · كل ما كتبه الاعتماد يُقبل في السحابة، والمطالبة فيها «محصَّلة»', async () => {
    const M: Access = { owner: false, uid: 'U-W2A', perms: { banks: 3, claims: 3 }, allProps: true, props: [] };
    const out = await scenario('OWNER-W2A', M, 'claim');
    // eslint-disable-next-line no-console
    console.log('W2a', JSON.stringify(out));
    expect(out.rejects).toEqual([]);
    expect(out.status).toBe('محصَّلة');
  });

  test('W2ب · الفاتورة: البنوك ٣ والفواتير ٣ · كل ما كتبه الاعتماد يُقبل في السحابة، والفاتورة فيها «مدفوعة»', async () => {
    const M: Access = { owner: false, uid: 'U-W2B', perms: { banks: 3, invoices: 3 }, allProps: true, props: [] };
    const out = await scenario('OWNER-W2B', M, 'invoice');
    // eslint-disable-next-line no-console
    console.log('W2b', JSON.stringify(out));
    expect(out.rejects).toEqual([]);
    expect(out.status).toBe('مدفوعة');
  });
});
