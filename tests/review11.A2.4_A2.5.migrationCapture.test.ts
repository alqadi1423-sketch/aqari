/**
 * مدقق مستقل على الهجرة ٦٢ (المراجعة الشاملة 2026-11-13 · A2.4) · المزامنة عند الترقية · بيانات مصطنعة كلها.
 * العيب: الهجرة تُدرج صف 3300 في جدولٍ مزامَن (accounts) والالتقاط شغّال، فيدخل الطابور بوقت الترقية على كل جهاز، خلافاً لنمط الهجرة ٤٨
 * («والتعبئة والالتقاط مطفأ: كل جهاز يعبّئ صفوفه بالقاعدة نفسها، فلا يُرفع كل صفٍّ بوقت الترقية فيغلب تعديلاً أحدث في جهاز آخر»):
 *  - جهاز المالك الثاني يترقّى بعد أن سمّى المالك 3300 على جهازه الأول: نسخة الترقية أحدث وقتاً فتغلب، فتعود التسمية إلى «أرصدة افتتاحية»
 *    على الجهازين وفي السحابة.
 *  - جهاز العضو يترقّى قبل المالك: يرفع حساباً نظامياً جديداً فترفضه قاعدة openingKept، فيُسجَّل «خارج صلاحيتك · بقي على هذا الجهاز ولم
 *    يُرفع»، وتظهر حالة المزامنة في الإعدادات حمراء «١ مرفوض عند الوصول» ولو ترقّى المالك بعدها.
 * السلوك الصحيح: إدراج الهجرة لا يُرفع (كل جهاز يُنشئ 3300 بهجرته)، فتبقى تسمية المالك، ولا يُسجَّل على العضو رفض.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { enableSync, syncOnce, syncStatus } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { saveAccount } from '@/domain/accounting/chart';
import { MIGRATION_62 } from '@/db/schema';
import { pair, sync } from './helpers/rederive';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** قاعدةٌ على الإصدار ٦١: لا 3300 (الهجرة ٦٢ تضيفه) · قبل تفعيل المزامنة فلا يبقى في الطابور أثر */
const asV61 = (db: DB) => { db.run(`DELETE FROM accounts WHERE code = '3300'`); db.run(`DELETE FROM sync_outbox WHERE tbl = 'accounts' AND pk = '3300'`); };
const name3300 = (db: DB) => db.get<{ n: string }>(`SELECT name AS n FROM accounts WHERE code = '3300'`)?.n;

test('جهاز المالك الثاني يترقّى بعد تسمية 3300 على الأول: تبقى تسمية المالك على الجهازين وفي السحابة', async () => {
  const s = await pair();
  asV61(s.owner); asV61(s.dev);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // الجهاز الأول يترقّى ويسمّي الحساب (الحساب النظامي يُعدَّل اسمه وحده)
  s.owner.exec(MIGRATION_62);
  await sync(s.owner, s.r);
  await wait(20);
  saveAccount(s.owner, { code: '3300', name: 'أرصدة أول المدة', type: 'حقوق ملكية', openingHalalas: 0 }, '3300');
  await sync(s.owner, s.r);
  await wait(20);
  // الجهاز الثاني (لوحٌ قليل الاستعمال) يترقّى بعدها ثم يتصل
  s.dev.exec(MIGRATION_62);
  await sync(s.dev, s.r);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  expect([name3300(s.owner), name3300(s.dev), String(s.r.docs.get('accounts__3300')?.d?.name)])
    .toEqual(['أرصدة أول المدة', 'أرصدة أول المدة', 'أرصدة أول المدة']);
  s.close();
});

test('جهاز العضو يترقّى قبل المالك: لا رفض يُسجَّل عليه، وحالة مزامنته بلا «مرفوض» بعد ترقية المالك', async () => {
  const ORG = 'owner-r11-cap';
  const M: Access = { owner: false, uid: 'member-r11-cap', perms: { banks: 3, ledger: 3 }, allProps: true, props: [] };
  const r = new MemoryRemote();
  const owner = memDb();
  asV61(owner);
  enableSync(owner, ORG);
  addBank(owner, 'بنك مصطنع', 300000);
  const ownerSync = () => syncOnce(owner, r, getMeta(owner, 'device_id')!);
  await ownerSync();
  const member = memDb();
  asV61(member);
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
  expect(syncStatus(member).rejected).toBe(0);
  // العضو يترقّى أولاً ويتصل · ثم المالك يترقّى ويتصل · ثم العضو
  member.exec(MIGRATION_62);
  await memberSync();
  await memberSync();
  owner.exec(MIGRATION_62);
  await ownerSync();
  await memberSync();
  expect(member.all<{ tbl: string; pk: string; reason: string }>(`SELECT tbl, pk, reason FROM sync_rejects`)).toEqual([]);
  expect(syncStatus(member).rejected).toBe(0);
  expect(name3300(member)).toBe('أرصدة افتتاحية');
  owner.close();
  member.close();
});
