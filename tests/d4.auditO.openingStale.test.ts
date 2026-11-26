/**
 * مدقق خارجي O · الجولة الثامنة · حارس الافتتاحي (engine.ts · applyOne) لجدولي البنوك والحسابات على e5e16f5 · بيانات مصطنعة.
 * الحارس يقارن افتتاحيّ نسخة العضو بما عند **هذا** الجهاز، والسحابة تحفظ آخر نسخةٍ وحدها: فجهاز المالك الذي لم يرَ افتتاحيّ المالك
 * (غائبٌ عن الشبكة، أو هاتفٌ بديل) ثم تصله تسميةٌ من عضو تحمل الافتتاحيّ نفسه «يرفض» ويعيد نسخته القديمة إلى السحابة.
 */
import { walletCashBalance, bankBalance } from '@/domain/accounting/ledger';
import { memDb } from './helpers/testDb';
import { enableSync } from '@/sync/engine';
import { addBank } from './helpers/fixtures';
import { pair, sync, UID } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';

const accOpening = (db: DB) => Number(db.get<{ o: number }>(`SELECT opening_halalas AS o FROM accounts WHERE code = '1100'`)!.o);
const bankOpening = (db: DB, id: string) => Number(db.get<{ o: number }>(`SELECT opening_halalas AS o FROM banks WHERE id = ?`, [id])?.o ?? NaN);

test.each([['banks', 'offline'], ['accounts', 'offline'], ['banks', 'fresh'], ['accounts', 'fresh']])('(O5) المالك يضع الافتتاحي (%s)، ثم يسمّي العضو الصفّ نفسه (افتتاحيّه كما هو)، وجهاز المالك %s (الثاني غائبٌ بينهما، أو هاتفٌ بديل ينضم): يعيد الافتتاحي القديم فيمحو افتتاحيّ المالك من كل أجهزته', async (tbl, who) => {
  const s = await pair(); // owner = جهاز المالك الأول، dev = جهازه الثاني
  const A = addBank(s.owner, 'بنك أ مصطنع O5', 0);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // المالك على جهازه الأول يضع الافتتاحي (app/banks.tsx أو app/accounts.tsx · save) · والجهاز الثاني لا يسحب الآن
  if (tbl === 'banks') s.owner.run(`UPDATE banks SET opening_halalas = 500000 WHERE id = ?`, [A]);
  else s.owner.run(`UPDATE accounts SET opening_halalas = 500000 WHERE code = '1100'`);
  await sync(s.owner, s.r);
  // العضو (مدير البنوك أو الدفتر) يسمّي الصف بعد أن سحب الافتتاحي: نموذجه يحفظ الافتتاحي كما هو (الحقل مقفلٌ له) بمسار قسمه
  const id = tbl === 'banks' ? 'banks__' + A : 'accounts__1100';
  const { ts: _ts, ...cloud } = s.r.docs.get(id)!;
  s.r.inject({ ...cloud, op: tbl === 'banks' ? 'banks' : 'ledger', u: new Date().toISOString(),
    d: { ...cloud.d, name: 'اسمٌ جديد مصطنع O5' } } as RemoteDoc);
  // ثم يعود الجهاز الثاني، ويسحب الأول بعده · وهاتفٌ بديل ينضم
  const fresh = memDb();
  enableSync(fresh, UID);
  const late = who === 'offline' ? s.dev : fresh;
  await sync(late, s.r);
  await sync(late, s.r);
  await sync(s.owner, s.r);
  await sync(s.owner, s.r);
  for (const db of [s.dev, fresh]) { await sync(db, s.r); await sync(db, s.r); }
  const op = (db: DB) => (tbl === 'banks' ? bankOpening(db, A) : accOpening(db));
  const out = { cloud: Number(s.r.docs.get(id)!.d!.opening_halalas), device1: op(s.owner), device2: op(s.dev), fresh: op(fresh),
    money: { device1: tbl === 'banks' ? bankBalance(s.owner, A) : walletCashBalance(s.owner), fresh: tbl === 'banks' ? bankBalance(fresh, A) : walletCashBalance(fresh) },
    rejectsLate: late.all<{ tbl: string; reason: string }>(`SELECT tbl, reason FROM sync_rejects`).map((r) => r.tbl + ': ' + r.reason) };
  // eslint-disable-next-line no-console
  console.log('O5', tbl, who, JSON.stringify(out));
  // افتتاحيّ المالك باقٍ في السحابة وعلى أجهزته كلها
  expect(out).toMatchObject({ cloud: 500000, device1: 500000, device2: 500000, fresh: 500000 });
  fresh.close();
  s.close();
});
