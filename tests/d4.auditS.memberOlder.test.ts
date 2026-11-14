/**
 * المدقق الخارجي S · الجولة العاشرة · على 7e3b492 · بيانات مصطنعة كلها.
 * S٤: إصلاح Q٢ (engine.ts applyOne: جهاز العضو يأخذ الافتتاحي من الوارد) في مسار «التعديل المعلَّق يغلب» وحده · ومسار «الوارد أقدم مما
 * عرفه الجهاز» (لا طابور، incomingAt < sync_rowtime) يعيد نسخة العضو إلى الطابور بافتتاحيّه القديم كما هو · فإن رفع جهاز المالك تصحيح
 * الافتتاحي بوقت تعديله (u) الأسبق من تسمية العضو (سحب المالك قبل التسمية ودفع بعدها، أو كان بلا اتصال)، أخذ العضو نسخة المالك «أقدم»
 * وأعاد نسخته بالافتتاحي القديم فترفضها القاعدة (openingKept) «خارج صلاحيتك»: يبقى جهاز العضو على الافتتاحي القديم ورصيد البنك عنده
 * خطأ، وتُرفض كل تسميةٍ له بعدها، وتسميته الأولى ضائعة من السحابة ومن جهاز المالك · وهي الأعراض التي أصلحها Q٢ في مسارٍ واحد.
 * السلوك الصحيح كـ Q٢: جهاز العضو يحمل افتتاحيّ السحابة في كل نسخةٍ يعيدها، فيُقبل رفعه ويتفق الجهازان.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { bankBalance } from '@/domain/accounting/ledger';
import type { Access } from '@/domain/access/access';
import type { RemoteDoc, WriteResult } from '@/sync/types';
import type { DB } from '@/db/adapter';

const ORG = 'owner-s4';
const M: Access = { owner: false, uid: 'member-s4', perms: { banks: 3, ledger: 3 }, allProps: true, props: [] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('S4: تصحيح المالك للافتتاحي يصل جهاز العضو «أقدم» من تسميته، فيبقى العضو على الافتتاحي القديم ويُرفض رفعه', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, ORG);
  const A = addBank(owner, 'بنك مصطنع S4', 100000);
  const ownerSync = () => syncOnce(owner, r, getMeta(owner, 'device_id')!);
  await ownerSync();

  const member = memDb();
  enableSync(member, M.uid!);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'عضو مصطنع S4' } })]);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [ORG]);
  const memberSync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(member, r, getMeta(member, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  await memberSync();
  await memberSync();

  // ١) المالك يصحّح الافتتاحي (في طابوره بوقت تعديله)
  owner.run(`UPDATE banks SET opening_halalas = 20000 WHERE id = ?`, [A]);
  await wait(15);
  // ٢) دورة المالك تسحب أولاً، وبين سحبها ودفعها يسمّي العضو البنك ويرفع (بافتتاحيّ السحابة 100000 فتقبله القاعدة)
  const write0 = r.write.bind(r);
  let once = true;
  r.write = async (docs: RemoteDoc[]): Promise<WriteResult[]> => {
    if (once && !(r as { memberMode?: boolean }).memberMode) {
      once = false;
      member.run(`UPDATE banks SET name = 'تسمية العضو مصطنعة S4' WHERE id = ?`, [A]);
      await memberSync();
    }
    return write0(docs);
  };
  await ownerSync();
  r.write = write0;
  // ٣) يتصل الطرفان مراراً، والعضو يسمّيه ثانيةً بعدها
  for (let i = 0; i < 2; i++) { await memberSync(); await ownerSync(); }
  member.run(`UPDATE banks SET name = 'تسمية العضو الثانية مصطنعة S4' WHERE id = ?`, [A]);
  for (let i = 0; i < 2; i++) { await memberSync(); await ownerSync(); }

  const out = {
    memberOpening: Number(member.get<{ o: number }>(`SELECT opening_halalas AS o FROM banks WHERE id = ?`, [A])!.o),
    memberBankBalance: bankBalance(member, A), ownerBankBalance: bankBalance(owner, A),
    cloudOpening: Number(r.docs.get('banks__' + A)!.d!.opening_halalas), cloudName: String(r.docs.get('banks__' + A)!.d!.name),
    memberRejects: member.all<{ tbl: string; reason: string }>(`SELECT tbl, reason FROM sync_rejects`).map((x) => x.tbl + ': ' + x.reason),
  };
  // eslint-disable-next-line no-console
  console.log('S4', JSON.stringify(out));
  expect(out.cloudOpening).toBe(20000);
  // جهاز العضو على افتتاحيّ السحابة، ورصيد البنك عنده رصيده عند المالك، وتسميته الأخيرة وصلت ولا مرفوض
  expect({ memberOpening: out.memberOpening, memberBankBalance: out.memberBankBalance, cloudName: out.cloudName, memberRejects: out.memberRejects })
    .toEqual({ memberOpening: 20000, memberBankBalance: 20000, cloudName: 'تسمية العضو الثانية مصطنعة S4', memberRejects: [] });
  owner.close();
  member.close();
});
