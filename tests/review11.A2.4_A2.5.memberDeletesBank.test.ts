/**
 * مدقق مستقل على إصلاح A2.4 (المراجعة الشاملة 2026-11-13 · قرار المالك س٢) · كتابة العضو · بيانات مصطنعة كلها.
 * العيب: منذ الهجرة ٦٢ افتتاحي البنك جزءٌ من الدفتر (مدين 1100 ودائن 3300) مشتقاً من البنوك الحية، والبنك المحذوف يخرج افتتاحيه منهما.
 * والافتتاحي يضعه المالك وحده (القاعدة ٩٩ · المدقق الخارجي I١ وM٧ وO٥): قاعدة openingKept تحرس قيمته، ولا تحرس حذف البنك. فالعضو بقسم
 * البنوك (perm.manage: زر «حذف» لبنكٍ بلا حركة في app/banks.tsx) يحذف ناعماً بنكاً وضع المالك افتتاحيه ٥٠٬٠٠٠٫٠٠، فيصل جهاز المالك
 * ويُطبَّق بلا رفض: النقدية 1100 و«أرصدة افتتاحية» 3300 في دفتر المالك تنقصان ٥٠٬٠٠٠٫٠٠ بكتابة عضو · كما مُنع العضو من حذف الحساب
 * النظامي لأنه يغيّر المال بلا قيد (O١).
 * السلوك الصحيح: حذف العضو لبنكٍ افتتاحيه غير صفر يُرفض على جهاز المالك (وتُعاد نسخته)، فيبقى البنك حياً وافتتاحيه في 1100 و3300.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { accountBalance } from '@/domain/accounting/ledger';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

const ORG = 'owner-r11-bank';
const M: Access = { owner: false, uid: 'member-r11-bank', perms: { banks: 3 }, allProps: true, props: [] };

test('عضوٌ بقسم البنوك يحذف بنكاً افتتاحيه للمالك ٥٠٬٠٠٠٫٠٠: لا ينقص به 1100 و3300 في دفتر المالك', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, ORG);
  const A = addBank(owner, 'بنك المالك المصطنع', 5000000);
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
  // قبل الحذف: افتتاحي البنك في دفتر المالك مدينٌ في 1100 ودائنٌ في 3300
  expect([accountBalance(owner, '1100'), accountBalance(owner, '3300')]).toEqual([5000000, 5000000]);

  // العضو يحذف البنك (بلا حركة) كما يفعل زر «حذف» في app/banks.tsx: حذفٌ ناعم
  member.run(`UPDATE banks SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), A]);
  for (let i = 0; i < 2; i++) { await memberSync(); await ownerSync(); }

  // دفتر المالك: الافتتاحي باقٍ في الطرفين، والبنك حيٌّ عنده
  expect({
    cash: accountBalance(owner, '1100'),
    opening: accountBalance(owner, '3300'),
    deleted: owner.get<{ d: string | null }>(`SELECT deleted_at AS d FROM banks WHERE id = ?`, [A])!.d,
  }).toEqual({ cash: 5000000, opening: 5000000, deleted: null });
  owner.close();
  member.close();
});
