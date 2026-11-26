/**
 * المراجعة ١٢ · R12-BAK-5 (ALSO) · الهجرة ٦٢ وحساب «عهدة» برمز 3300 أنشأه المستخدم على الإصدار ٦١ · بيانات مصطنعة والأرقام بالهللة.
 *
 * ١) كُنس من السلة قبل الترقية (purgeFromTrash): في السحابة شاهد حذفٍ {d: null, del: true} لا صفٌّ محذوف · والهجرة تُدرج حساب النظام بلا رفع،
 *    فجوالٌ يبدأ من السحابة بعد الترقية كان يطبّق الشاهد فيحذف حساب النظام المزروع عنده كله.
 * ٢) جهازٌ ترقّى و«عهدة» عنده حيّة (لم يسحب حذفها بعد) فأبقتها الهجرة، ثم وصله حذفها: كان يبقى بحسابٍ غير نظاميٍّ محذوف ولا حساب نظام،
 *    وأخوه الذي ترقّى بعد الحذف على حساب النظام · فيفترق دفترا الجهازين.
 * الصحيح في الحالتين: كل جهاز على حساب النظام 3300 الحيّ، فافتتاحي البنك (٣٠٠٬٠٠٠) في الدفتر: 1100 = 3300 = ٣٠٠٬٠٠٠.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import { saveAccount, deleteAccount } from '@/domain/accounting/chart';
import { purgeFromTrash } from '@/domain/trash';
import { MIGRATION_62 } from '@/db/schema';
import { accountBalance, ledgerBankOpenings } from '@/domain/accounting/ledger';
import type { DB } from '@/db/adapter';

const UID = 'OWNER-R12-M62T';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const asV61 = (db: DB) => { db.run(`DELETE FROM accounts WHERE code = '3300'`); db.run(`DELETE FROM sync_outbox WHERE tbl = 'accounts' AND pk = '3300'`); };
const view = (db: DB) => {
  const a = db.get<{ s: number; del: number }>(`SELECT is_system AS s, deleted_at IS NOT NULL AS del FROM accounts WHERE code = '3300'`);
  return { system3300: Number(a?.s ?? -1) === 1 && Number(a?.del ?? 1) === 0, cash: accountBalance(db, '1100'), opening: accountBalance(db, '3300'), inLedger: ledgerBankOpenings(db) };
};
/** افتتاحي البنك ٣٠٠٬٠٠٠ في 1100 مديناً وفي 3300 دائناً */
const RIGHT = { system3300: true, cash: 300_000, opening: 300_000, inLedger: 300_000 };
const syncer = (r: MemoryRemote) => (db: DB) => syncOnce(db, r, getMeta(db, 'device_id')!);

test('«عهدة» كُنست من السلة قبل الترقية (شاهد حذفٍ في السحابة): الجوال الجديد بعد الترقية يبقى على حساب النظام 3300', async () => {
  const r = new MemoryRemote();
  const s = syncer(r);
  const a = memDb();
  asV61(a);
  enableSync(a, UID);
  addBank(a, 'بنك مصطنع', 300_000);
  saveAccount(a, { code: '3300', name: 'عهدة مصطنعة', type: 'أصل', openingHalalas: 0 });
  await s(a);
  await wait(10);
  deleteAccount(a, '3300');
  await s(a);
  await wait(10);
  purgeFromTrash(a, 'accounts', '3300');
  await s(a); await s(a);
  expect(r.docs.get('accounts__3300')?.del).toBe(true);

  a.exec(MIGRATION_62);
  await s(a);
  expect(view(a)).toEqual(RIGHT);

  const c = memDb();
  enableSync(c, UID);
  await s(c); await s(c); await s(a); await s(c);
  expect({ a: view(a), c: view(c) }).toEqual({ a: RIGHT, c: RIGHT });
  a.close(); c.close();
});

test('جهازٌ ترقّى و«عهدة» عنده حيّة ثم وصله حذفها: يحلّ محلّها حساب النظام كأخيه', async () => {
  const r = new MemoryRemote();
  const s = syncer(r);
  const a = memDb();
  const b = memDb();
  asV61(a); asV61(b);
  enableSync(a, UID);
  enableSync(b, UID);
  addBank(a, 'بنك مصطنع', 300_000);
  saveAccount(a, { code: '3300', name: 'عهدة مصطنعة', type: 'أصل', openingHalalas: 0 });
  await s(a); await s(b);
  expect(b.get(`SELECT 1 FROM accounts WHERE code = '3300' AND deleted_at IS NULL AND is_system = 0`)).toBeTruthy();

  // ب يترقّى و«عهدة» عنده حيّة: الهجرة تُبقيها
  b.exec(MIGRATION_62);
  // ثم أ (على ٦١) يحذفها ويرفع الحذف، ويترقّى بعده
  await wait(10);
  deleteAccount(a, '3300');
  await s(a);
  a.exec(MIGRATION_62);
  await s(a); await s(b); await s(a); await s(b);

  expect({ a: view(a), b: view(b) }).toEqual({ a: RIGHT, b: RIGHT });
  a.close(); b.close();
});
