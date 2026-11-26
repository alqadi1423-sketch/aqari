/**
 * المدقق الخارجي Q · الجولة التاسعة · على e7c151c · بيانات مصطنعة كلها.
 * Q١: افتتاحيّ المالك المعلَّق في طابوره (لم يُرفع بعد) تمحوه تسميةٌ من عضوٍ أحدث منه وقتاً. القاعدة (openingKept) تجيز للعضو
 * افتتاحيّ النسخة السابقة في السحابة (القديم)، وجهاز المالك صار يثق به (engine.ts applyOne: أُزيل فحص الافتتاحي) فيغلب الواردُ
 * تعديلَ المالك بحسم التعارض «الأحدث يغلب» ويُحذف من طابوره، فيضيع افتتاحيّ المالك من جهازه ومن السحابة.
 * السلوك الصحيح: الافتتاحي حقٌّ للمالك وحده، فتعديله المعلَّق يبقى (يُدمج مع تسمية العضو أو تُعاد نسخته) ويصل السحابة.
 */
import { bankBalance } from '@/domain/accounting/ledger';
import { addBank } from './helpers/fixtures';
import { pair, sync, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const opening = (db: DB, tbl: string, k: string) => Number(db.get<{ o: number }>(
  `SELECT opening_halalas AS o FROM ${tbl} WHERE ${tbl === 'accounts' ? 'code' : 'id'} = ?`, [k])?.o ?? NaN);

test.each([['banks'], ['accounts']])('Q1 (%s): المالك يضع الافتتاحي بلا اتصال، ثم يسمّي عضوٌ الصفّ بالافتتاحي القديم (كما تجيز القاعدة)، فيمحو افتتاحيّ المالك', async (tbl) => {
  const s = await pair();
  const A = addBank(s.owner, 'بنك مصطنع Q1', 100000);
  s.owner.run(`UPDATE accounts SET opening_halalas = 100000 WHERE code = '1100'`);
  await sync(s.owner, s.r);
  const k = tbl === 'banks' ? A : '1100';
  const id = tbl + '__' + k;
  // المالك بلا اتصال يغيّر الافتتاحي (app/banks.tsx · app/accounts.tsx) · يبقى في طابوره
  s.owner.run(tbl === 'banks' ? `UPDATE banks SET opening_halalas = 500000 WHERE id = ?` : `UPDATE accounts SET opening_halalas = 500000 WHERE code = ?`, [k]);
  await wait(15);
  // العضو (مدير البنوك أو الدفتر) يسمّي الصف بعده: افتتاحيّ نسخته هو افتتاحيّ السحابة السابق، فتقبله القاعدة
  const { ts: _ts, ...cloud } = s.r.docs.get(id)!;
  const memberDoc = { ...cloud, by: cloud.by ?? MEMBER, op: tbl === 'banks' ? 'banks' : 'ledger', dev: 'dev-member-q1', u: new Date().toISOString(),
    d: { ...cloud.d, name: 'اسمٌ جديد مصطنع Q1' } } as RemoteDoc;
  const res = await s.r.write([memberDoc]);
  expect(res[0].ok).toBe(true); // القاعدة (openingKept كما تحاكيها MemoryRemote) تجيزه
  // المالك يتصل
  await sync(s.owner, s.r);
  await sync(s.owner, s.r);
  const out = { device: opening(s.owner, tbl, k), cloud: Number(s.r.docs.get(id)!.d!.opening_halalas),
    bankBalance: tbl === 'banks' ? bankBalance(s.owner, A) : null,
    conflicts: s.owner.all<{ entity_name: string }>(`SELECT entity_name FROM audit_log WHERE entity_type = 'تعارض مزامنة'`).map((x) => x.entity_name) };
  // eslint-disable-next-line no-console
  console.log('Q1', tbl, JSON.stringify(out));
  // افتتاحيّ المالك (500000) باقٍ على جهازه وفي السحابة
  expect({ device: out.device, cloud: out.cloud }).toEqual({ device: 500000, cloud: 500000 });
  s.close();
});

/**
 * Q١ب: والمستند المرفوض نفسه يكتب الافتتاحي: حسابٌ مستعملٌ في قيد يغيّر العضو مجموعته (grp) فيرفضه حارس الحساب (engine.ts applyOne «forged»)،
 * لكنه قبل الرفض يكتب «افتتاحيّ نسخة العضو» فوق افتتاحيّ المالك المعلَّق ثم يعيد نسخة المالك بها إلى السحابة.
 * (القاعدة تمنع العضو من تغيير مجموعة النظامي في السحابة، فالمثال بحسابٍ غير نظامي مستعملٍ في قيد: مجموعته يحرسها جهاز المالك وحده.)
 */
import { postEntry } from '@/domain/accounting/post';
test('Q1b: مستند عضوٍ مرفوض (يغيّر مجموعة حسابٍ مستعمل) يمحو افتتاحيّ المالك المعلَّق ويرفع القديم إلى السحابة', async () => {
  const s = await pair();
  s.owner.run(`INSERT INTO accounts (code, name, type, grp, opening_halalas, created_at) VALUES ('1180', 'عهدة نقدية مصطنعة Q1', 'أصل', 'النقدية وما في حكمها', 100000, ?)`, [new Date().toISOString()]);
  postEntry(s.owner, { date: '2026-10-01', memo: 'قيد مصطنع Q1b', lines: [
    { account: '1180', descr: 'مصطنع', debit: 5000, credit: 0 }, { account: '1100', descr: 'مصطنع', debit: 0, credit: 5000 }] });
  await sync(s.owner, s.r);
  // المالك بلا اتصال يصحّح الافتتاحي
  s.owner.run(`UPDATE accounts SET opening_halalas = 500000 WHERE code = '1180'`);
  await wait(15);
  // العضو (كامل الدفتر) يكتب الحساب بمجموعةٍ أخرى (القاعدة تجيزها لغير النظامي) وبافتتاحيّ السحابة
  const { ts: _ts, ...cloud } = s.r.docs.get('accounts__1180')!;
  const res = await s.r.write([{ ...cloud, by: cloud.by ?? MEMBER, op: 'ledger', dev: 'dev-member-q1b', u: new Date().toISOString(),
    d: { ...cloud.d, grp: 'مجموعة أخرى مصطنعة' } } as RemoteDoc]);
  expect(res[0].ok).toBe(true);
  await sync(s.owner, s.r);
  await sync(s.owner, s.r);
  const out = { device: opening(s.owner, 'accounts', '1180'), cloud: Number(s.r.docs.get('accounts__1180')!.d!.opening_halalas),
    grp: s.owner.get<{ g: string }>(`SELECT grp AS g FROM accounts WHERE code = '1180'`)!.g,
    rejects: s.owner.all<{ reason: string }>(`SELECT reason FROM sync_rejects`).map((x) => x.reason) };
  // eslint-disable-next-line no-console
  console.log('Q1b', JSON.stringify(out));
  expect(out.rejects.length).toBe(1); // رُفض المستند (المجموعة كما هي)
  expect({ device: out.device, cloud: out.cloud }).toEqual({ device: 500000, cloud: 500000 });
  s.close();
});
