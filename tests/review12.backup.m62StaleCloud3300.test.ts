/**
 * المراجعة ١٢ · مدقق المرحلة ١ المستقل · الترقية · الهجرة ٦٢ (7f494fe · A2.4) مع المزامنة · متوسط
 * src/db/schema.ts (MIGRATION_62: «ورمزٌ 3300 أنشأه المستخدم ثم حذفه … يُحذف ويُدرج حساب النظام مكانه»، والالتقاط مطفأ)
 *
 * السيناريو (بيانات مصطنعة):
 *  ١) المالك على الإصدار ٦١ وله بنكٌ افتتاحيه ٣٬٠٠٠٫٠٠ · أنشأ يوماً حساباً برمز 3300 «عهدة» ثم حذفه (deleteAccount: حذفٌ ناعم) وكلاهما
 *     رُفع إلى السحابة، فمستند accounts/3300 في السحابة: is_system = 0 وdeleted_at قائم.
 *  ٢) جهازاه يترقّيان إلى ٦٢: الهجرة تحذف صفّ «عهدة» المحذوف وتُدرج حساب النظام 3300 «أرصدة افتتاحية»، والالتقاط مطفأ عمداً فلا يُرفع
 *     شيء · فتبقى السحابة على «عهدة» المحذوفة إلى الأبد.
 *  ٣) يضيف المالك جوالاً جديداً (أو يعيد التثبيت، أو ينضمّ عضو): الجهاز الجديد يُزرع بحساب النظام 3300، ثم يسحب مستند السحابة فيكتبه فوقه ·
 *     فيصير 3300 عنده «عهدة» محذوفةً غير نظامية، وledgerBankOpenings يعيد صفراً فتخرج افتتاحيات البنوك من دفتره.
 * النتيجة الفعلية: الجهازان القديمان يريان النقدية والبنوك 1100 = ٣٬٠٠٠٫٠٠ والجديد صفراً، وميزانيته بلا الأرصدة الافتتاحية، والفرق
 * الافتتاحي يعود عنده · بلا رسالة ولا أثر، ولا يُصلح نفسه (الهجرات لا تعاد والزرع لا يعاد).
 *
 * لماذا يهم: الهجرة صُمّمت لهذه الحالة بعينها («وإلا بقي الرمز مأخوذاً فلا يُصلَح A2.4 له أبداً») فأصلحتها على الأجهزة القائمة وتركت
 * نقيضها في السحابة · فكل جهازٍ يبدأ من السحابة بعد الترقية يرجع إلى ما قبل A2.4، وتفترق دفاتر أجهزة المنشأة الواحدة في رصيد 1100 ·
 * وقرار المالك س٢: «افتتاحي البنوك في الدفتر».
 *
 * السلوك الصحيح: كل أجهزة المنشأة بعد الترقية ترى 3300 حساب النظام الحيّ، فافتتاحي البنك في دفتر الجديد كالقديم:
 * 1100 = ٣٠٠٬٠٠٠ هللة و3300 = ٣٠٠٬٠٠٠ هللة على الأجهزة الثلاثة (بأن يُرفع حساب النظام مرةً حين أزالت الهجرة صفاً كان في السحابة، أو أن
 * يُترك الوارد غير النظامي المحذوف لرمزٍ هو حساب نظامٍ حيٌّ هنا بلا سطر).
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** قاعدةٌ على الإصدار ٦١: لا 3300 (الهجرة ٦٢ تضيفه) */
const asV61 = (db: DB) => { db.run(`DELETE FROM accounts WHERE code = '3300'`); db.run(`DELETE FROM sync_outbox WHERE tbl = 'accounts' AND pk = '3300'`); };
const view = (db: DB) => {
  const a = db.get<{ s: number; del: number }>(`SELECT is_system AS s, deleted_at IS NOT NULL AS del FROM accounts WHERE code = '3300'`);
  return { system3300: Number(a?.s ?? -1) === 1 && Number(a?.del ?? 1) === 0, cash: accountBalance(db, '1100'), opening: accountBalance(db, '3300'), inLedger: ledgerBankOpenings(db) };
};

test('الهجرة ٦٢ و3300 محذوفٌ في السحابة: الجهاز الجديد بعد الترقية يرى افتتاحي البنك في دفتره كالقديمين', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  const b = memDb();
  asV61(a); asV61(b);
  enableSync(a, 'OWNER-R12-M62');
  enableSync(b, 'OWNER-R12-M62');
  const sa = () => syncOnce(a, r, getMeta(a, 'device_id')!);
  const sb = () => syncOnce(b, r, getMeta(b, 'device_id')!);
  // ١) الإصدار ٦١: بنكٌ افتتاحيه ٣٬٠٠٠٫٠٠، وحساب «عهدة» برمز 3300 أُنشئ ثم حُذف، وكله في السحابة وعلى الجهازين
  addBank(a, 'بنك مصطنع', 300_000);
  saveAccount(a, { code: '3300', name: 'عهدة مصطنعة', type: 'أصل', openingHalalas: 0 });
  await sa(); await sb();
  await wait(10);
  deleteAccount(a, '3300');
  await sa(); await sb(); await sa(); await sb();
  expect(r.docs.get('accounts__3300')?.d?.deleted_at).toBeTruthy();

  // ٢) الجهازان يترقّيان إلى ٦٢ ويتزامنان
  a.exec(MIGRATION_62);
  b.exec(MIGRATION_62);
  await sa(); await sb(); await sa(); await sb();
  const old = view(a);
  expect(old).toEqual({ system3300: true, cash: 300_000, opening: 300_000, inLedger: 300_000 });
  expect(view(b)).toEqual(old);

  // ٣) جوالٌ جديد للمالك بعد الترقية (مثبَّت على ٦٢: حساب النظام 3300 من الزرع) يسحب المنشأة
  const c = memDb();
  enableSync(c, 'OWNER-R12-M62');
  const sc = () => syncOnce(c, r, getMeta(c, 'device_id')!);
  await sc(); await sc();
  await sa(); await sb(); await sc();

  // الأجهزة الثلاثة على دفترٍ واحد: 1100 = ٣٠٠٬٠٠٠ و3300 = ٣٠٠٬٠٠٠
  expect({ a: view(a), b: view(b), c: view(c) }).toEqual({ a: old, b: old, c: old });
  a.close(); b.close(); c.close();
});
