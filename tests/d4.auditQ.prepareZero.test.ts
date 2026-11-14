/**
 * المدقق الخارجي Q · الجولة التاسعة · على e7c151c · بيانات مصطنعة كلها.
 * Q٤: prepareMemberUpload (engine.ts) يصفّر على جهاز العضو افتتاحيّ كل بنكٍ أو حسابٍ في الطابور «لا وقت صفٍّ له» (sync_rowtime) ظنّاً أنه
 * جديدٌ لم يصل السحابة · وsync_rowtime أنشأته الهجرة ٤٣ بلا تعبئة (schema.ts: MIGRATION_43) · فبنك المالك الذي سحبه جهاز العضو قبل
 * الهجرة ٤٣ (أو نسخة جهازٍ قبلها استُعيدت) ثم سمّاه العضو: يُصفَّر افتتاحيّه على جهاز العضو، وترفض
 * القاعدة رفعه (صفرٌ ≠ افتتاحيّ السحابة) فيخرج من الطابور «خارج صلاحيتك»، ويبقى الجهاز بافتتاحيٍّ صفر ورصيدٍ ناقص.
 * السلوك الصحيح: لا يُمسّ افتتاحيّ صفٍّ يعرفه الجهاز من السحابة (المعيار: «لم يُرفع قط»، لا «لا وقت له»)، فيبقى رصيد البنك كما هو.
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

const ORG = 'owner-q4';
const M: Access = { owner: false, uid: 'member-q4', perms: { banks: 3, ledger: 3 }, allProps: true, props: [] };

test('Q4: جهاز عضوٍ بلا وقت صفٍّ لبنك المالك (ما قبل الهجرة ٤٣) يسمّيه: يُصفَّر افتتاحيّه عنده ويُرفض رفعه', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, ORG);
  const A = addBank(owner, 'بنك مصطنع Q4', 500000);
  await syncOnce(owner, r, getMeta(owner, 'device_id')!);

  const member = memDb();
  enableSync(member, M.uid!);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'عضو مصطنع Q4' } })]);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [ORG]);
  const memberSync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(member, r, getMeta(member, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  await memberSync();
  await memberSync();
  expect(bankBalance(member, A)).toBe(500000);
  // جهازٌ سحب البنك بإصدارٍ قبل الهجرة ٤٣ (sync_rowtime فارغٌ لما طبّقه قبلها)
  member.run(`DELETE FROM sync_rowtime WHERE tbl = 'banks'`);
  // العضو يسمّي البنك (app/banks.tsx · save: الافتتاحي مقفلٌ له فيُحفظ كما هو)
  member.run(`UPDATE banks SET name = 'اسمٌ جديد مصطنع Q4' WHERE id = ?`, [A]);
  await memberSync();
  await memberSync();
  const out = { memberOpening: Number(member.get<{ o: number }>(`SELECT opening_halalas AS o FROM banks WHERE id = ?`, [A])!.o),
    memberBalance: bankBalance(member, A), cloudOpening: Number(r.docs.get('banks__' + A)!.d!.opening_halalas),
    cloudName: String(r.docs.get('banks__' + A)!.d!.name),
    rejects: member.all<{ tbl: string; reason: string }>(`SELECT tbl, reason FROM sync_rejects`).map((x) => x.tbl + ': ' + x.reason) };
  // eslint-disable-next-line no-console
  console.log('Q4', JSON.stringify(out));
  expect({ memberOpening: out.memberOpening, memberBalance: out.memberBalance, cloudName: out.cloudName })
    .toEqual({ memberOpening: 500000, memberBalance: 500000, cloudName: 'اسمٌ جديد مصطنع Q4' });
  owner.close();
  member.close();
});
