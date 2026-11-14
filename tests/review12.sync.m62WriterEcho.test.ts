/**
 * المراجعة ١٢ · إصلاح مراجعة R12-BAK-5 · حذف «عهدة» 3300 (أنشأها المستخدم وأبقتها الهجرة ٦٢ حيّةً) بعد الترقية · بيانات مصطنعة كلها،
 * والأرقام بالهللة محسوبة باليد: بنكٌ افتتاحيه ٣٬٠٠٠٫٠٠ = ٣٠٠٬٠٠٠ هللة.
 *
 * ١) العضو يحذفها (قسم الدفتر): جهازه يمرّ بحارس 3300 بصدى حذفه كما يمرّ جهاز المالك بوصوله، فالجهازان على حساب النظام 3300 الحيّ ·
 *    افتتاحي البنك مدينٌ في 1100 ودائنٌ في 3300: ٣٠٠٬٠٠٠ في كلٍّ منهما · ولا رفض يُسجَّل على العضو (لا يُرفع حساب نظامٍ من جهازه).
 * ٢) المالك يحذفها ثم يستعيدها من السلة قبل أن يصله صدى الحذف: الاستعادة تعديلٌ لم يُرفع، فالصدى لا يحوّلها · فتبقى «عهدة» حيّةً على
 *    الجهازين وافتتاحي البنك خارج الدفتر كما قبل الحذف: 1100 = 3300 = ٠ (R11-A2.4-1).
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { saveAccount, deleteAccount } from '@/domain/accounting/chart';
import { restoreFromTrash } from '@/domain/trash';
import { MIGRATION_62 } from '@/db/schema';
import { accountBalance, ledgerBankOpenings } from '@/domain/accounting/ledger';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const asV61 = (db: DB) => { db.run(`DELETE FROM accounts WHERE code = '3300'`); db.run(`DELETE FROM sync_outbox WHERE tbl = 'accounts' AND pk = '3300'`); };
const view = (db: DB) => {
  const a = db.get<{ s: number; del: number }>(`SELECT is_system AS s, deleted_at IS NOT NULL AS del FROM accounts WHERE code = '3300'`);
  return { system3300: Number(a?.s ?? -1) === 1 && Number(a?.del ?? 1) === 0, cash: accountBalance(db, '1100'), opening: accountBalance(db, '3300'), inLedger: ledgerBankOpenings(db) };
};
/** افتتاحي البنك ٣٠٠٬٠٠٠ في 1100 مديناً وفي 3300 دائناً */
const RIGHT = { system3300: true, cash: 300_000, opening: 300_000, inLedger: 300_000 };

test('١) العضو يحذف «عهدة» 3300 بعد الترقية: جهازه وجهاز المالك على حساب النظام، ولا رفض عليه', async () => {
  const ORG = 'owner-r12-m62w';
  const M: Access = { owner: false, uid: 'member-r12-m62w', perms: { banks: 3, ledger: 3 }, allProps: true, props: [] };
  const r = new MemoryRemote();
  const owner = memDb();
  asV61(owner);
  enableSync(owner, ORG);
  addBank(owner, 'بنك مصطنع', 300_000);
  saveAccount(owner, { code: '3300', name: 'عهدة مصطنعة', type: 'أصل', openingHalalas: 0 });
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
  await memberSync(); await memberSync();
  expect(member.get(`SELECT 1 FROM accounts WHERE code = '3300' AND is_system = 0 AND deleted_at IS NULL`)).toBeTruthy();

  owner.exec(MIGRATION_62);
  member.exec(MIGRATION_62);
  await wait(10);
  deleteAccount(member, '3300');
  for (let i = 0; i < 3; i++) { await memberSync(); await ownerSync(); }

  expect({ owner: view(owner), member: view(member) }).toEqual({ owner: RIGHT, member: RIGHT });
  expect(member.all(`SELECT tbl, pk, reason FROM sync_rejects`)).toEqual([]);
  owner.close(); member.close();
});

test('٢) المالك يحذف «عهدة» ثم يستعيدها من السلة قبل صدى الحذف: تبقى حيّةً على الجهازين', async () => {
  const UID = 'OWNER-R12-M62W2';
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
  a.exec(MIGRATION_62);
  b.exec(MIGRATION_62);

  await wait(10);
  deleteAccount(a, '3300');
  await s(a); // يُرفع الحذف · وصداه في الدورة التالية
  await wait(10);
  restoreFromTrash(a, 'accounts', '3300'); // تعديلٌ لم يُرفع بعد
  await s(b); await s(a); await s(b); await s(a); await s(b);

  // «عهدة» أصلٌ أنشأه المستخدم وحيّة: افتتاحي البنك خارج الدفتر، 1100 = ٠ و3300 = ٠
  const KEPT = { system3300: false, cash: 0, opening: 0, inLedger: 0 };
  expect({ a: view(a), b: view(b) }).toEqual({ a: KEPT, b: KEPT });
  expect([a, b].map((db) => db.get<{ n: string }>(`SELECT name AS n FROM accounts WHERE code = '3300' AND deleted_at IS NULL`)?.n))
    .toEqual(['عهدة مصطنعة', 'عهدة مصطنعة']);
  a.close(); b.close();
});
