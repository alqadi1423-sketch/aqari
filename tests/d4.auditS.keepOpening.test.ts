/**
 * المدقق الخارجي S · الجولة العاشرة · على 7e3b492 · بيانات مصطنعة كلها.
 * S٢: إصلاح Q١ (engine.ts applyOne «keepOpening») وQ١ب (حارس الحساب لا يكتب افتتاحيّ نسخة العضو إن كان للصف طابور) يعدّان كل
 * تعديلٍ معلَّقٍ للصف على جهاز المالك تعديلاً لافتتاحيّه · فجهاز المالك الأول الذي له تعديلٌ معلَّق لا يمسّ الافتتاحي (تسمية البنك أو
 * الحساب بلا اتصال) يكتب افتتاحيّه القديم فوق افتتاحيٍّ أحدث وضعه المالك من جهازه الثاني (ووصله في نسخة العضو كما تقضي openingKept)،
 * ثم يرفعه إلى السحابة فيمحو تصحيح المالك من السحابة ومن جهازه الثاني.
 * على e7c151c كان الوارد يغلب بافتتاحيّه (افتتاحيّ المالك الأحدث) فيبقى في كل مكان.
 * السلوك الصحيح: الافتتاحي يُبقى من الجهاز حين يكون تعديله المعلَّق قد مسّ الافتتاحي (أو كان أحدث من افتتاحيّ الوارد)، لا لكل طابور.
 */
import { addBank } from './helpers/fixtures';
import { pair, sync, MEMBER } from './helpers/rederive';
import { postEntry } from '@/domain/accounting/post';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const opening = (db: DB, tbl: string, k: string) => Number(db.get<{ o: number }>(
  `SELECT opening_halalas AS o FROM ${tbl} WHERE ${tbl === 'accounts' ? 'code' : 'id'} = ?`, [k])?.o ?? NaN);

test.each([['banks'], ['accounts']])('S2 (%s): جهاز المالك الأول بتسميةٍ معلَّقة يمحو افتتاحيّ المالك الأحدث من جهازه الثاني', async (tbl) => {
  const s = await pair(); // s.owner = جهاز المالك الأول، s.dev = جهاز المالك الثاني (الحساب نفسه)
  const A = addBank(s.owner, 'بنك مصطنع S2', 100000);
  s.owner.run(`UPDATE accounts SET opening_halalas = 100000 WHERE code = '1100'`);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const k = tbl === 'banks' ? A : '1100';
  const id = tbl + '__' + k;
  const set = (db: DB, col: string, v: unknown) => db.run(`UPDATE ${tbl} SET ${col} = ? WHERE ${tbl === 'accounts' ? 'code' : 'id'} = ?`, [v as never, k]);
  // ١) جهاز المالك الأول بلا اتصال يغيّر اسم الصف وحده (لا الافتتاحي) · يبقى في طابوره
  set(s.owner, 'name', 'اسمٌ من جهاز المالك الأول مصطنع S2');
  await wait(15);
  // ٢) المالك من جهازه الثاني يصحّح الافتتاحي ويرفعه
  set(s.dev, 'opening_halalas', 500000);
  await sync(s.dev, s.r);
  await wait(15);
  // ٣) العضو يسمّي الصف بعده، بافتتاحيّ السحابة (500000 · ما تقضيه openingKept)
  const { ts: _ts, ...cloud } = s.r.docs.get(id)!;
  expect(Number(cloud.d!.opening_halalas)).toBe(500000);
  const res = await s.r.write([{ ...cloud, by: cloud.by ?? MEMBER, op: tbl === 'banks' ? 'banks' : 'ledger', dev: 'dev-member-s2',
    u: new Date().toISOString(), d: { ...cloud.d, name: 'تسمية العضو مصطنعة S2' } } as RemoteDoc]);
  expect(res[0].ok).toBe(true);
  // ٤) جهاز المالك الأول يتصل، ثم الثاني
  await sync(s.owner, s.r);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const out = { first: opening(s.owner, tbl, k), second: opening(s.dev, tbl, k), cloud: Number(s.r.docs.get(id)!.d!.opening_halalas) };
  // eslint-disable-next-line no-console
  console.log('S2', tbl, JSON.stringify(out));
  // افتتاحيّ المالك الأحدث (500000) باقٍ في كل مكان
  expect(out).toEqual({ first: 500000, second: 500000, cloud: 500000 });
  s.close();
});

/**
 * S٢ب: وحارس الحساب (Q١ب) كذلك: مستند عضوٍ يغيّر مجموعة حسابٍ مستعمل يحمل افتتاحيّ السحابة الأحدث (من جهاز المالك الثاني)، فيرفضه
 * جهاز المالك الأول ويعيد نسخته · ولأن للصف عنده طابوراً (تسميةٌ معلَّقة) لا يكتب افتتاحيّ الوارد، فيرفع افتتاحيّه القديم فوق الأحدث.
 * على e7c151c كان يكتب افتتاحيّ الوارد ثم يعيد النسخة، فيبقى الأحدث.
 */
test('S2b: رفضُ مستند عضوٍ لحسابٍ مستعمل على جهاز المالك الأول (له تسميةٌ معلَّقة) يرفع افتتاحيّه القديم فوق تصحيح الجهاز الثاني', async () => {
  const s = await pair(); // s.owner = جهاز المالك الأول، s.dev = جهاز المالك الثاني
  s.owner.run(`INSERT INTO accounts (code, name, type, grp, opening_halalas, created_at) VALUES ('1180', 'عهدة نقدية مصطنعة S2b', 'أصل', 'النقدية وما في حكمها', 100000, ?)`, [new Date().toISOString()]);
  postEntry(s.owner, { date: '2026-10-01', memo: 'قيد مصطنع S2b', lines: [
    { account: '1180', descr: 'مصطنع', debit: 5000, credit: 0 }, { account: '1100', descr: 'مصطنع', debit: 0, credit: 5000 }] });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // ١) جهاز المالك الأول بلا اتصال يسمّي الحساب (لا الافتتاحي)
  s.owner.run(`UPDATE accounts SET name = 'اسمٌ من الجهاز الأول مصطنع S2b' WHERE code = '1180'`);
  await wait(15);
  // ٢) المالك من جهازه الثاني يصحّح الافتتاحي ويرفعه
  s.dev.run(`UPDATE accounts SET opening_halalas = 500000 WHERE code = '1180'`);
  await sync(s.dev, s.r);
  await wait(15);
  // ٣) العضو (كامل الدفتر) يغيّر مجموعة الحساب، بافتتاحيّ السحابة 500000 (تقبله القاعدة لغير النظامي)
  const { ts: _t, ...cloud } = s.r.docs.get('accounts__1180')!;
  expect(Number(cloud.d!.opening_halalas)).toBe(500000);
  expect((await s.r.write([{ ...cloud, by: cloud.by ?? MEMBER, op: 'ledger', dev: 'dev-member-s2b', u: new Date().toISOString(),
    d: { ...cloud.d, grp: 'مجموعة أخرى مصطنعة' } } as RemoteDoc]))[0].ok).toBe(true);
  // ٤) جهاز المالك الأول يتصل (يرفض مستند العضو ويعيد نسخته)، ثم الثاني
  await sync(s.owner, s.r);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const out = { first: opening(s.owner, 'accounts', '1180'), second: opening(s.dev, 'accounts', '1180'),
    cloud: Number(s.r.docs.get('accounts__1180')!.d!.opening_halalas),
    rejects: s.owner.all<{ reason: string }>(`SELECT reason FROM sync_rejects`).length };
  // eslint-disable-next-line no-console
  console.log('S2b', JSON.stringify(out));
  expect(out.rejects).toBe(1);
  expect({ first: out.first, second: out.second, cloud: out.cloud }).toEqual({ first: 500000, second: 500000, cloud: 500000 });
  s.close();
});
