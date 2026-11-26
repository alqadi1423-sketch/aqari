/**
 * مدقق مستقل على إصلاح E-1 (المراجعة الشاملة 2026-11-13 · غير مُلتزَم) · بيانات مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/review11.E_1.memberLockRace
 *
 * عالٍ · src/sync/engine.ts applyOne فرع lock === 'keep': `if (!pending && !getSyncState(db, 'membership')) enqueue(...)` ثم
 *   reject وreturn 'rejected' قبل فحص «الوارد الأقدم» · فجهاز العضو الذي أقفل المحضر ورفعه لا يعيد نسخته المقفلة أبداً، وجهاز المالك لا
 *   يعرف القفل ليعيده.
 *
 * السيناريو («وكذلك العكس» في E-1: مندوبٌ يقفل في الموقع، وتعديلٌ من جوال المالك): دورة جوال المالك تسحب قبل أن يصل القفل، وبين سحبها
 *   ورفعها يُقفل المندوب (عضو بصلاحية الاستلام) المحضر ويرفعه · فيكتب رفعُ المالك نسخته غير المقفلة فوق القفل في السحابة (الكتابة في
 *   السحابة بلا شرط، ولا قاعدة لجدول handovers). ثم يتصل الجهازان مراراً.
 *   الواقع بعد الإصلاح: جهاز العضو يرفض الوارد ويبقى مقفلاً عنده وحده، وجوال المالك والسحابة يبقيان locked = 0 والبند «تالف» إلى الأبد ·
 *   تباينٌ دائم، والمحضر الذي أقفله المندوب مفتوحٌ ومعدَّل عند المالك وفي كل جهازٍ يسحب بعدها.
 *   والحالة الأولى (تعديل المالك أسبق من القفل) كانت تتفق على القفل قبل الإصلاح: مسار «الوارد أقدم مما عرفه الجهاز» يعيد نسخة العضو
 *   المقفلة إلى السحابة · فالإصلاح أرجعها (يُرفض الوارد ويُرجَع قبل ذلك المسار).
 *
 * السلوك الصحيح: القفل باتجاهٍ واحد أياً كان الجهاز الذي أقفل · يتفق الجهازان والسحابة على المحضر المقفل كما أقفله المندوب (locked = 1
 *   والبند «سليم»)، ويُرى تعديل المالك مرفوضاً في «حالة المزامنة» · كما يفعل الإصلاح حين يكون القفل على جهاز المالك (اختبار «سباق الرفع»
 *   في review9.E.handoverLock).
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { confirmContract } from '@/domain/contracts/service';
import { getMeta } from '@/repos/settings';
import { getContractHandover, updateHandover, lockHandover, type HandoverUpdate } from '@/domain/handover/service';
import type { HandoverSection } from '@/domain/handover/build';
import type { Access } from '@/domain/access/access';
import type { RemoteDoc, WriteResult } from '@/sync/types';
import type { DB } from '@/db/adapter';

type DBT = ReturnType<typeof memDb>;
const ORG = 'owner-r11-e1';
const M: Access = { owner: false, uid: 'member-r11-e1', perms: { handover: 3, contracts: 3 }, allProps: true, props: [] };
const tick = (ms = 15) => new Promise((res) => setTimeout(res, ms));
const fill = (cond: string, json: string): HandoverUpdate => {
  const s = JSON.parse(json) as HandoverSection[];
  s[0].items[0].receiveCondition = cond;
  return { employeeName: 'موظف مصطنع', tenantName: 'مستأجر مصطنع للنموذج', idNumber: '', phone: '', address: '', unitFloor: '',
    contractPeriod: '', date: '2026-01-01', otherNotes: '', tenantSign: 'مستأجر', companySign: 'المكتب', sections: s };
};
const stateOf = (db: DBT, id: string) => {
  const x = db.get<{ locked: number; sections_json: string }>(`SELECT locked, sections_json FROM handovers WHERE id = ?`, [id])!;
  return { locked: Number(x.locked), ac: (JSON.parse(x.sections_json) as HandoverSection[])[0].items[0].receiveCondition };
};

async function ownerAndMember() {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, ORG);
  owner.run(`INSERT INTO form_templates (id, name, sections_json, created_at) VALUES ('T-R11', 'قالب مصطنع', ?, ?)`,
    [JSON.stringify([{ section: 'الصالة', items: ['مكيف', 'إنارة'] }]), new Date().toISOString()]);
  const cid = confirmContract(owner, contractInput(addUnit(owner, addProperty(owner)), { tenant: 'مستأجر مصطنع للنموذج' }));
  const h = getContractHandover(owner, cid)!;
  const ownerSync = () => syncOnce(owner, r, getMeta(owner, 'device_id')!);
  await ownerSync();
  const member = memDb();
  enableSync(member, M.uid!);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'مندوب مصطنع' } })]);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [ORG]);
  const memberSync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(member, r, getMeta(member, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  await memberSync();
  await memberSync();
  /** دورة المالك: يسحب، وقبل أن يرفع يجري ما في between (والكتابة بعدها بلا شرط كما في السحابة) */
  const ownerSyncRacing = async (between: () => Promise<void>) => {
    const write0 = r.write.bind(r);
    let once = true;
    r.write = async (docs: RemoteDoc[]): Promise<WriteResult[]> => {
      if (once && !(r as { memberMode?: boolean }).memberMode) { once = false; await between(); }
      return write0(docs);
    };
    try { await ownerSync(); } finally { r.write = write0; }
  };
  return { r, owner, member, ownerSync, memberSync, ownerSyncRacing, id: h.id, json: h.sections_json };
}

describe('E-1 · مدقق مستقل · قفل العضو يُكتب فوقه في السحابة فلا يعود', () => {
  test('تعديل المالك أسبق من قفل المندوب ورُفع في السباق: يتفق الكل على المقفَل (كان يتفق قبل الإصلاح)', async () => {
    const { r, owner, member, ownerSync, memberSync, ownerSyncRacing, id, json } = await ownerAndMember();
    updateHandover(owner, id, fill('تالف', json)); // جوال المالك: تعديلٌ في طابوره
    await tick();
    await ownerSyncRacing(async () => {
      // المندوب يعبّئ ويُقفل ويرفع بين سحب المالك ورفعه
      updateHandover(member, id, fill('سليم', json));
      lockHandover(member, id);
      await memberSync();
      expect(Number(r.docs.get('handovers__' + id)!.d!.locked)).toBe(1); // القفل وصل السحابة
    });
    for (let i = 0; i < 3; i++) { await memberSync(); await ownerSync(); }
    expect(stateOf(member, id)).toEqual({ locked: 1, ac: 'سليم' });
    expect(Number(r.docs.get('handovers__' + id)!.d!.locked)).toBe(1);
    // (الواقع بعد الإصلاح: { locked: 0, ac: 'تالف' } على جوال المالك وفي السحابة)
    expect(stateOf(owner, id)).toEqual({ locked: 1, ac: 'سليم' });
    owner.close();
    member.close();
  });

  test('المندوب أقفل بلا اتصال، وجوال المالك عدّل بعده نسخته القديمة ورُفع في السباق: يبقى المقفَل على الكل', async () => {
    const { r, owner, member, ownerSync, memberSync, ownerSyncRacing, id, json } = await ownerAndMember();
    updateHandover(member, id, fill('سليم', json));
    lockHandover(member, id); // في الموقع بلا اتصال
    await tick();
    updateHandover(owner, id, fill('تالف', json)); // تعديلٌ متأخر من جوال المالك لم يسحب القفل
    await ownerSyncRacing(async () => {
      await memberSync(); // عاد اتصال المندوب فرفع القفل بين سحب المالك ورفعه
      expect(Number(r.docs.get('handovers__' + id)!.d!.locked)).toBe(1);
    });
    for (let i = 0; i < 3; i++) { await memberSync(); await ownerSync(); }
    expect(stateOf(member, id)).toEqual({ locked: 1, ac: 'سليم' });
    expect(Number(r.docs.get('handovers__' + id)!.d!.locked)).toBe(1);
    // (الواقع بعد الإصلاح: { locked: 0, ac: 'تالف' } على جوال المالك وفي السحابة · والعضو وحده مقفل)
    expect(stateOf(owner, id)).toEqual({ locked: 1, ac: 'سليم' });
    owner.close();
    member.close();
  });
});
