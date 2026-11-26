/**
 * A2.4 · عالٍ · src/domain/accounting/chart.ts:43 (openingDifference) مع src/domain/finStatements.ts:97 و
 *         src/domain/accounting/ledger.ts:239 (cashOnHand) و src/domain/accounting/integrity.ts (الفحص ٦)
 *
 * السيناريو (بيانات مصطنعة): المالك يبدأ بحسابٍ بنكي رصيده الافتتاحي ٥٠٬٠٠٠٫٠٠ (banks.opening_halalas، خارج الدفتر).
 *  - دليل الحسابات يقول «الأرصدة الافتتاحية غير متوازنة: الفرق ٥٠٬٠٠٠ (المدين أكبر) … تُصحَّح بإكمال الطرف الناقص».
 *  - فيُكمل المالك الطرف الناقص: افتتاحي رأس المال 3100 = ٥٠٬٠٠٠٫٠٠ → يختفي التنبيه، لكن قائمة المركز المالي تقول «الميزانية
 *    غير متوازنة» (الأصول صفر، وحقوق الملكية ٥٠٬٠٠٠)، وفحص المطابقة ٦ أحمر، وبطاقة «النقد في ١ حسابات» في الرئيسية صفر.
 *  - ولا إعداد يتّسق: وضع الخمسين ألفاً في افتتاحي 1100 أيضاً يضاعف الفرق ويُظهر في المحفظة نقداً ليس في اليد.
 *
 * لماذا يهم: كل مالكٍ يبدأ وله رصيد في البنك (الحال الطبيعي) يرى ميزانيةً غير متوازنة أو تنبيهاً دائماً، والرئيسية تُخفي ماله البنكي.
 * وقرار المالك (#60 · 2026-10-07): «يُحفظ ويظهر الفرق، وأرصدة البنوك تُسجَّل في الدفتر».
 * السلوك الصحيح: الرصيد الافتتاحي للبنك جزءٌ من 1100 في الدفتر (قيدٌ افتتاحي أو اشتقاقٌ في الأرصدة)، فبعد إكمال الطرف المقابل:
 * لا فرق افتتاحي، والميزانية متوازنة وأصولها ٥٠٬٠٠٠٫٠٠، وبطاقة النقد ٥٠٬٠٠٠٫٠٠، والمحفظة صفر.
 * وقرار المالك (س٢ · 2026-11-13): الطرف المقابل حساب 3300 «أرصدة افتتاحية» (الهجرة ٦٢)، فلا طرف ناقص يُكمَل برأس المال: الفرق صفرٌ
 * منذ إضافة البنك، و3300 سطرٌ في حقوق الملكية بالمبلغ · ورأس مالٍ افتتاحي فوقه يظهر فرقاً دائناً صريحاً لا يُسوّى صامتاً.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { saveAccount, openingDifference } from '@/domain/accounting/chart';
import { integrityChecks } from '@/domain/accounting/integrity';
import { financialStatementBlock } from '@/domain/finStatements';
import { cashOnHand, walletCashBalance, bankBalance, accountBalance, trialBalance } from '@/domain/accounting/ledger';
import { schemaAt, fill } from './helpers/oldSchema';
import { pair, sync } from './helpers/rederive';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { t } from '@/i18n';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import { migrate } from '@/db/migrations';
import { seed } from '@/db/seed';

test('A2.4 رصيدٌ بنكي افتتاحي يقابله 3300 «أرصدة افتتاحية»: الميزانية متوازنة والنقد يظهر', () => {
  const db = memDb();
  const b = addBank(db, 'بنك مصطنع', 5000000);
  // مدين 1100 ودائن 3300 بالمبلغ نفسه (قرار المالك س٢) · فلا فرق ولا طرف ناقص
  expect(openingDifference(db)).toBe(0);
  expect(bankBalance(db, b)).toBe(5000000);
  expect(walletCashBalance(db)).toBe(0);

  const bs = financialStatementBlock(db, 'balance', null, '2026-12-31');
  const total = (label: string) => (bs.totals.find((r) => r[0] === label)?.[1] as { money: number }).money;
  expect(total('إجمالي الأصول')).toBe(5000000);
  expect(total('إجمالي الخصوم وحقوق الملكية')).toBe(5000000);
  expect(bs.totals.some((r) => String(r[0]).includes('غير متوازنة'))).toBe(false);
  // 3300 في حقوق الملكية بالخمسين ألفاً
  expect((bs.sections[2].rows.find((r) => r[0] === 'أرصدة افتتاحية')?.[1] as { money: number }).money).toBe(5000000);

  expect(integrityChecks(db).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  // بطاقة «النقد في N حسابات» في الرئيسية
  expect(cashOnHand(db)).toBe(5000000);

  // ورأس مالٍ افتتاحي ٥٠٬٠٠٠٫٠٠ فوق ذلك (الطريق القديم لإكمال الطرف الناقص) فرقٌ دائن ظاهر: ١٠٠٬٠٠٠ دائن مقابل ٥٠٬٠٠٠ مدين
  saveAccount(db, { code: '3100', name: 'رأس المال', type: 'حقوق ملكية', openingHalalas: 5000000 }, '3100');
  expect(openingDifference(db)).toBe(-5000000);
  db.close();
});

test('A2.4 الترقية: بنكٌ قائم بافتتاحيه قبل الهجرة ٦٢ يدخل 1100 مقابل 3300 بلا قيدٍ جديد، والمحفظة كما كانت', () => {
  const db = schemaAt(':memory:', 61);
  fill(db); // بنك افتتاحيه ٥٠٠٫٠٠، وقبض نقدي ٦٬٠٠٠٫٠٠ (تأمين ٢٬٠٠٠ وإيجار ٣٬٠٠٠ و١٬٠٠٠)
  // قبل الهجرة: لا 3300، فالافتتاحي خارج الدفتر كما كان وفرقٌ مدين
  expect(openingDifference(db)).toBe(50000);
  expect(walletCashBalance(db)).toBe(600000);
  const entries = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n);
  migrate(db);
  seed(db);
  expect(db.get(`SELECT type FROM accounts WHERE code = '3300' AND is_system = 1`)).toEqual({ type: 'حقوق ملكية' });
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n)).toBe(entries);
  expect(openingDifference(db)).toBe(0);
  // 1100 = ٦٬٠٠٠ + ٥٠٠ · المحفظة = ٦٬٥٠٠ - ٥٠٠ (البنك) = ٦٬٠٠٠ · 3300 = ٥٠٠
  expect(accountBalance(db, '1100')).toBe(650000);
  expect(walletCashBalance(db)).toBe(600000);
  expect(cashOnHand(db)).toBe(650000);
  expect(accountBalance(db, '3300')).toBe(50000);
  const bs = financialStatementBlock(db, 'balance', null, '2026-12-31');
  const total = (label: string) => (bs.totals.find((r) => r[0] === label)?.[1] as { money: number }).money;
  // الأصول ٦٬٥٠٠ = الخصوم (تأمين) ٢٬٠٠٠ + حقوق الملكية (3300 ٥٠٠ + أرباح غير مقفلة ٤٬٠٠٠)
  expect(total('إجمالي الأصول')).toBe(650000);
  expect(total('إجمالي الخصوم وحقوق الملكية')).toBe(650000);
  // وميزان المراجعة: 3300 أول المدة دائن ٥٠٠، و1100 ختامه مدين ٦٬٥٠٠، ومجموع الختامي صفر
  const tb = trialBalance(db, '2026-01-01', '2026-12-31');
  expect(tb.find((r) => r.code === '3300')!.openingHalalas).toBe(-50000);
  expect(tb.find((r) => r.code === '1100')!.closingHalalas).toBe(650000);
  expect(tb.reduce((s, r) => s + r.closingHalalas, 0)).toBe(0);
  expect(integrityChecks(db).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  // والبنك المحذوف يخرج افتتاحيه من الطرفين معاً
  db.run(`UPDATE banks SET deleted_at = '2026-06-01' WHERE id = 'B1'`);
  expect([accountBalance(db, '1100'), accountBalance(db, '3300'), walletCashBalance(db)]).toEqual([600000, 0, 600000]);
  db.close();
});

test('A2.4 المزامنة: افتتاحي البنك يصل جهاز المالك الآخر مع صفّه فيتفقان على 1100 و3300 بلا قيدٍ يُرحَّل ولا رفض', async () => {
  const s = await pair();
  const A = addBank(s.owner, 'بنك مصطنع للمزامنة', 5000000);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const state = (db: typeof s.owner) => ({
    cash: accountBalance(db, '1100'), ob: accountBalance(db, '3300'), wallet: walletCashBalance(db), diff: openingDifference(db),
    entries: Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n),
    rejects: Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects`)!.n),
  });
  const want = { cash: 5000000, ob: 5000000, wallet: 0, diff: 0, entries: 0, rejects: 0 };
  expect([state(s.owner), state(s.dev)]).toEqual([want, want]);
  // وتعديل الافتتاحي من الجهاز الآخر (٣٠٬٠٠٠٫٠٠) يصل الأول فيتغيّر الطرفان معاً
  s.dev.run(`UPDATE banks SET opening_halalas = 3000000 WHERE id = ?`, [A]);
  await sync(s.dev, s.r);
  await sync(s.owner, s.r);
  const want2 = { ...want, cash: 3000000, ob: 3000000 };
  expect([state(s.owner), state(s.dev)]).toEqual([want2, want2]);
  expect(integrityChecks(s.owner).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  s.close();
});

test('A2.4 العضو بقسم البنوك: استعادته بنكاً افتتاحيه ٢٠٬٠٠٠٫٠٠ حذفه المالك تُرفض على جهاز المالك، وحذفه بنكاً افتتاحيه صفر يُطبَّق', async () => {
  // (R11-A2.4-2: افتتاحي البنك الحيّ في 1100 و3300، فاستعادته أو حذفه يغيّر المال · وما افتتاحيه صفر لا يمسّ الدفتر فلا يُمنع)
  const ORG = 'owner-a24-member';
  const M: Access = { owner: false, uid: 'member-a24', perms: { banks: 3 }, allProps: true, props: [] };
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, ORG);
  const A = addBank(owner, 'بنك افتتاحيه للمالك', 2000000);
  const Z = addBank(owner, 'بنك بلا افتتاحي', 0);
  owner.run(`UPDATE banks SET deleted_at = ? WHERE id = ?`, ['2026-06-01T00:00:00.000Z', A]);
  const ownerSync = () => syncOnce(owner, r, getMeta(owner, 'device_id')!);
  await ownerSync();
  const member = memDb();
  enableSync(member, M.uid!);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'عضو مصطنع' } })]);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [ORG]);
  const memberSync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(member, r, getMeta(member, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  await memberSync();
  await memberSync();
  const ledger = (db: DB) => [accountBalance(db, '1100'), accountBalance(db, '3300')];
  // البنك المحذوف خارج الطرفين، والآخر افتتاحيه صفر
  expect(ledger(owner)).toEqual([0, 0]);

  member.run(`UPDATE banks SET deleted_at = NULL WHERE id = ?`, [A]);
  member.run(`UPDATE banks SET deleted_at = ? WHERE id = ?`, ['2026-06-02T00:00:00.000Z', Z]);
  for (let i = 0; i < 2; i++) { await memberSync(); await ownerSync(); }
  await memberSync();

  const deleted = (db: DB, id: string) => db.get<{ d: string | null }>(`SELECT deleted_at AS d FROM banks WHERE id = ?`, [id])!.d !== null;
  // جهاز المالك: A باقٍ في السلة ودفتره كما كان، وZ حُذف بكتابة العضو · والرفض باسمه
  expect({ ledger: ledger(owner), A: deleted(owner, A), Z: deleted(owner, Z) }).toEqual({ ledger: [0, 0], A: true, Z: true });
  expect(owner.get<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE tbl = 'banks' AND pk = ?`, [A])?.reason)
    .toBe(t('sync.bankOpeningLocked', { lng: 'ar' }));
  expect(Number(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE pk = ?`, [Z])!.n)).toBe(0);
  // وجهاز العضو يأخذ نسخة المالك المعادة: A في السلة ثانيةً
  expect({ ledger: ledger(member), A: deleted(member, A), Z: deleted(member, Z) }).toEqual({ ledger: [0, 0], A: true, Z: true });
  owner.close();
  member.close();
});
