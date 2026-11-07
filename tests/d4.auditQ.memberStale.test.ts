/**
 * المدقق الخارجي Q · الجولة التاسعة · على e7c151c · بيانات مصطنعة كلها.
 * Q٢: جهاز العضو يبقى على افتتاحيٍّ قديم إلى الأبد. المالك يغيّر افتتاحيّ البنك، والعضو يسمّي البنك بلا اتصال بعده وقتاً: عند سحبه
 * يغلب تعديله المحلي (conflict-local) فيبقى صفّه بالافتتاحي القديم، ثم ترفض القاعدة (openingKept) رفعه لأن افتتاحيّه ليس افتتاحيّ
 * السحابة، فيخرج من الطابور «خارج صلاحيتك» ولا يُسحب الصف ثانيةً (المؤشر تجاوزه): الافتتاحي القديم يبقى على جهاز العضو، وتُرفض
 * كل تسميةٍ له بعدها، ورصيد البنك عنده خطأٌ تحرس به شاشاته السداد (requireBankCovers في purchases.ts) ·
 * وفي e5e16f5 كانت كتابته تُقبل فيرفضها جهاز المالك ويعيد نسخته، فيسحبها العضو ويتفق الجهازان.
 * السلوك الصحيح: جهاز العضو يأخذ افتتاحيّ السحابة (حقل المالك وحده) ولو غلب تعديله المحلي، فيُقبل رفعه ويتفق الجهازان.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { bankBalance } from '@/domain/accounting/ledger';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

const ORG = 'owner-q2';
const M: Access = { owner: false, uid: 'member-q2', perms: { banks: 3, ledger: 3 }, allProps: true, props: [] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Q2: العضو يسمّي البنك بعد تغيير المالك افتتاحيّه، فيبقى جهازه على الافتتاحي القديم ويُرفض كل رفعٍ له', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, ORG);
  const A = addBank(owner, 'بنك مصطنع Q2', 100000);
  const ownerSync = () => syncOnce(owner, r, getMeta(owner, 'device_id')!);
  await ownerSync();

  const member = memDb();
  enableSync(member, M.uid!);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'عضو مصطنع Q2' } })]);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [ORG]);
  const memberSync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(member, r, getMeta(member, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  await memberSync();
  await memberSync();
  expect(Number(member.get<{ o: number }>(`SELECT opening_halalas AS o FROM banks WHERE id = ?`, [A])!.o)).toBe(100000);

  // المالك يصحّح الافتتاحي (أخطأ في إدخاله) · ويرفعه
  owner.run(`UPDATE banks SET opening_halalas = 20000 WHERE id = ?`, [A]);
  await ownerSync();
  await wait(15);
  // العضو بلا اتصال يسمّي البنك بعده (نموذجه يحفظ الافتتاحي كما عنده: الحقل مقفلٌ له)
  member.run(`UPDATE banks SET name = 'اسمٌ جديد مصطنع Q2' WHERE id = ?`, [A]);
  // ثم يتصل، ويتصل الطرفان مراراً
  for (let i = 0; i < 3; i++) { await memberSync(); await ownerSync(); }
  // والعضو يسمّيه ثانيةً بعد أيام
  member.run(`UPDATE banks SET name = 'اسمٌ ثالث مصطنع Q2' WHERE id = ?`, [A]);
  for (let i = 0; i < 2; i++) { await memberSync(); await ownerSync(); }

  const out = {
    memberOpening: Number(member.get<{ o: number }>(`SELECT opening_halalas AS o FROM banks WHERE id = ?`, [A])!.o),
    memberBankBalance: bankBalance(member, A),
    cloudOpening: Number(r.docs.get('banks__' + A)!.d!.opening_halalas),
    cloudName: String(r.docs.get('banks__' + A)!.d!.name),
    ownerBankBalance: bankBalance(owner, A),
    memberRejects: member.all<{ tbl: string; reason: string }>(`SELECT tbl, reason FROM sync_rejects`).map((x) => x.tbl + ': ' + x.reason),
  };
  // eslint-disable-next-line no-console
  console.log('Q2', JSON.stringify(out));
  // جهاز العضو على افتتاحيّ السحابة، ورصيد البنك عنده رصيده عند المالك، وتسميته وصلت
  expect({ memberOpening: out.memberOpening, memberBankBalance: out.memberBankBalance, cloudName: out.cloudName })
    .toEqual({ memberOpening: 20000, memberBankBalance: 20000, cloudName: 'اسمٌ ثالث مصطنع Q2' });
  owner.close();
  member.close();
});
