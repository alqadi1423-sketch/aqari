/**
 * المراجعة ١٢ · مراجعة إصلاح R12-BAK-5 (المراجع المستقل) · بيانات مصطنعة والأرقام بالهللة محسوبة باليد.
 *
 * حارس applyOne الجديد (engine.ts) يجعل الجهاز الذي **يستقبل** حذف «عهدة» 3300 غير النظامية يحذف صفّها ويُدرج حساب النظام 3300 مكانها
 * (قاعدة الهجرة ٦٢) · لكن الجهاز الذي **حذفها** لا يمرّ بهذا: deleteAccount (chart.ts) ينقلها إلى السلة فقط، والهجرة ٦٢ جرت قبلُ فلا
 * تُعاد، والزرع INSERT OR IGNORE لا يُدرج 3300 وصفّها المحذوف قائم.
 *
 * السيناريو: الإصدار ٦١ · بنكٌ افتتاحيه ٣٬٠٠٠٫٠٠ (٣٠٠٬٠٠٠ هللة) و«عهدة» برمز 3300 حيّة على الجهازين · يترقّيان إلى ٦٢ و«عهدة» حيّة فتُبقيها
 * الهجرة (الجهازان سواء: لا حساب نظام، وافتتاحي البنك خارج الدفتر) · ثم بعد الترقية يحذف المالك «عهدة» من الجهاز أ.
 * قبل الإصلاح: الجهازان على «عهدة» محذوفة، دفترٌ واحد. بعده: ب يأخذ حساب النظام فـ 1100 = 3300 = ٣٠٠٬٠٠٠، وأ يبقى بلا حساب نظام فـ
 * 1100 = 3300 = ٠ · فيفترق دفترا جهازي المالك نفسه بصمت، وهو عين ما جاء البند ليمنعه.
 * الصحيح: الجهازان على حساب النظام 3300 الحيّ: 1100 = 3300 = ٣٠٠٬٠٠٠ (افتتاحي البنك مديناً في 1100 ودائناً في 3300).
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import { saveAccount, deleteAccount } from '@/domain/accounting/chart';
import { MIGRATION_62 } from '@/db/schema';
import { accountBalance, ledgerBankOpenings } from '@/domain/accounting/ledger';
import type { DB } from '@/db/adapter';

const UID = 'OWNER-R12R-M62D';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const asV61 = (db: DB) => { db.run(`DELETE FROM accounts WHERE code = '3300'`); db.run(`DELETE FROM sync_outbox WHERE tbl = 'accounts' AND pk = '3300'`); };
const view = (db: DB) => {
  const a = db.get<{ s: number; del: number }>(`SELECT is_system AS s, deleted_at IS NOT NULL AS del FROM accounts WHERE code = '3300'`);
  return { system3300: Number(a?.s ?? -1) === 1 && Number(a?.del ?? 1) === 0, cash: accountBalance(db, '1100'), opening: accountBalance(db, '3300'), inLedger: ledgerBankOpenings(db) };
};
/** افتتاحي البنك ٣٠٠٬٠٠٠ في 1100 مديناً وفي 3300 دائناً */
const RIGHT = { system3300: true, cash: 300_000, opening: 300_000, inLedger: 300_000 };

test('«عهدة» 3300 حيّة عند الترقية ثم حذفها المالك بعدها: الجهاز الذي حذفها والجهاز الذي استقبل الحذف على دفترٍ واحد', async () => {
  const r = new MemoryRemote();
  const s = (db: DB) => syncOnce(db, r, getMeta(db, 'device_id')!);
  const a = memDb();
  const b = memDb();
  asV61(a); asV61(b);
  enableSync(a, UID);
  enableSync(b, UID);
  addBank(a, 'بنك مصطنع', 300_000);
  saveAccount(a, { code: '3300', name: 'عهدة مصطنعة', type: 'أصل', openingHalalas: 0 });
  await s(a); await s(b); await s(a); await s(b);

  // الجهازان يترقّيان و«عهدة» حيّة عندهما: الهجرة تُبقيها
  a.exec(MIGRATION_62);
  b.exec(MIGRATION_62);
  expect(view(a)).toEqual(view(b));

  // بعد الترقية: المالك يحذف «عهدة» من أ (لا سطر عليها)
  await wait(10);
  deleteAccount(a, '3300');
  await s(a); await s(b); await s(a); await s(b);

  expect({ a: view(a), b: view(b) }).toEqual({ a: RIGHT, b: RIGHT });
  a.close(); b.close();
});
