/**
 * E-1 · عالٍ · src/domain/handover/service.ts:117-125 (updateHandover يفحص القفل على الجهاز وحده) و:128-134 (lockHandover)
 *        مع src/sync/engine.ts (حسم التعارض على مستوى الصف كله، بلا حارسٍ لجدول handovers)
 *
 * السيناريو (بيانات مصطنعة كلها): جهازان على الحساب نفسه (جوال المالك وجهاز المكتب، أو جهاز موظف الاستلام بصلاحية «كامل»).
 *   ١. الجهاز (أ) يعبّئ نموذج الاستلام: «المكيف · سليم»، ثم يُقفله ويزامن.
 *   ٢. الجهاز (ب) بلا اتصال، ولم يسحب القفل بعد، فيعدّل نسخته غير المقفلة: «المكيف · تالف»، ثم يزامن.
 *   الواقع: على الجهازين النموذج صار locked = 0 ومحتواه «تالف» · القفل ضاع والمحضر المقفَل تغيّر بصمت.
 *
 * لماذا يهم: محضر الاستلام دليلٌ بين المؤجر والمستأجر، وعليه تُبنى خصومات التأمين. وقرار المالك صريح:
 *   «لا يتم تعديل نموذج الاستلام والتسليم بعد اقفاله» (2026-08-18) و«والمُقفَل لا يُعدَّل» (2026-08-19).
 *   والعمل الميداني بلا اتصال (قبو العمارة، موقع بلا شبكة) هو الحال الطبيعي لمندوب الاستلام.
 *
 * السلوك الصحيح: القفل باتجاهٍ واحد. نسخةٌ غير مقفلة تصل بعد القفل لا تفتحه ولا تغيّر بنوده: يبقى locked = 1
 *   والبند «سليم» على الجهازين، ويُرفض التعديل الوارد (أو يُحفظ مسودةً تصحيحية منفصلة) لا أن يغلب المقفَل.
 *
 *   TZ=Asia/Riyadh npx jest tests/review9.E.handoverLock
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce, syncStatus, buildDoc } from '@/sync/engine';
import { confirmContract } from '@/domain/contracts/service';
import { getMeta } from '@/repos/settings';
import { getContractHandover, updateHandover, lockHandover, type HandoverUpdate } from '@/domain/handover/service';
import type { HandoverSection } from '@/domain/handover/build';
import { t } from '@/i18n';
import { retagUnitTree } from '@/domain/unitMove';
import { annotate } from '@/sync/acl';
import type { Access } from '@/domain/access/access';
import type { RemoteDoc, WriteResult } from '@/sync/types';
import type { DB } from '@/db/adapter';

type DBT = ReturnType<typeof memDb>;

describe('E-1 · [عالٍ] نموذج الاستلام المقفَل يُفتح ويتغيّر بتعديلٍ متأخر من جهازٍ آخر', () => {
  test('القفل يبقى والبند المقفَل لا يتغيّر بعد مزامنة تعديلٍ من نسخةٍ قديمة', async () => {
    const r = new MemoryRemote();
    const a = memDb();
    const b = memDb();
    const sync = (db: DBT) => syncOnce(db, r, getMeta(db, 'device_id')!);
    enableSync(a, 'u-review9-e1');
    enableSync(b, 'u-review9-e1');
    // قالبٌ يبني منه النموذج (لا قالب يُزرع) · أسماء مصطنعة
    a.run(`INSERT INTO form_templates (id, name, sections_json, created_at) VALUES ('T-E1', 'قالب مصطنع', ?, ?)`,
      [JSON.stringify([{ section: 'الصالة', items: ['مكيف', 'إنارة'] }]), new Date().toISOString()]);
    const cid = confirmContract(a, contractInput(addUnit(a, addProperty(a)), { tenant: 'مستأجر مصطنع للنموذج' }));
    const h = getContractHandover(a, cid)!;
    expect(h).toBeTruthy();
    await sync(a);
    await sync(b);
    const hb = getContractHandover(b, cid)!;
    expect(hb.id).toBe(h.id);

    const filled = (cond: string, json: string): HandoverSection[] => {
      const s = JSON.parse(json) as HandoverSection[];
      s[0].items[0].receiveCondition = cond;
      return s;
    };
    const base: HandoverUpdate = {
      employeeName: 'موظف مصطنع', tenantName: 'مستأجر مصطنع للنموذج', idNumber: '', phone: '', address: '', unitFloor: '',
      contractPeriod: '', date: '2026-01-01', otherNotes: '', tenantSign: 'مستأجر', companySign: 'المكتب', sections: [],
    };

    // ١. (أ) يعبّئ «سليم» ويُقفل ويزامن
    updateHandover(a, h.id, { ...base, sections: filled('سليم', h.sections_json) });
    lockHandover(a, h.id);
    await sync(a);
    await new Promise((res) => setTimeout(res, 5));

    // ٢. (ب) بلا اتصال على نسخته غير المقفلة: «تالف» · ثم يزامن
    updateHandover(b, hb.id, { ...base, sections: filled('تالف', hb.sections_json) });
    await sync(b);
    await sync(a);
    await sync(b);

    const state = (db: DBT) => {
      const x = db.get<{ locked: number; sections_json: string }>(`SELECT locked, sections_json FROM handovers WHERE id = ?`, [h.id])!;
      return { locked: Number(x.locked), ac: (JSON.parse(x.sections_json) as HandoverSection[])[0].items[0].receiveCondition };
    };
    // (الواقع: على الجهازين { locked: 0, ac: 'تالف' })
    expect(state(a)).toEqual({ locked: 1, ac: 'سليم' });
    expect(state(b)).toEqual({ locked: 1, ac: 'سليم' });
    a.close();
    b.close();
  });
});

/* ═══ ما بعد الإصلاح: الرفض ظاهرٌ في «حالة المزامنة» (قرار المالك س٢٩)، والسباق، وما قبل القفل يمضي كما كان ═══ */

async function twoDevices() {
  const r = new MemoryRemote();
  const a = memDb();
  const b = memDb();
  const sync = (db: DBT) => syncOnce(db, r, getMeta(db, 'device_id')!);
  enableSync(a, 'u-review9-e1');
  enableSync(b, 'u-review9-e1');
  a.run(`INSERT INTO form_templates (id, name, sections_json, created_at) VALUES ('T-E1', 'قالب مصطنع', ?, ?)`,
    [JSON.stringify([{ section: 'الصالة', items: ['مكيف', 'إنارة'] }]), new Date().toISOString()]);
  const p1 = addProperty(a);
  const p2 = addProperty(a, { name: 'عقار مصطنع ثانٍ' });
  const unit = addUnit(a, p1);
  const cid = confirmContract(a, contractInput(unit, { tenant: 'مستأجر مصطنع للنموذج' }));
  const h = getContractHandover(a, cid)!;
  await sync(a);
  await sync(b);
  return { r, a, b, sync, id: h.id, json: h.sections_json, unit, p1, p2 };
}
const tick = () => new Promise((res) => setTimeout(res, 5));
const fill = (cond: string, json: string): HandoverUpdate => {
  const s = JSON.parse(json) as HandoverSection[];
  s[0].items[0].receiveCondition = cond;
  return {
    employeeName: 'موظف مصطنع', tenantName: 'مستأجر مصطنع للنموذج', idNumber: '', phone: '', address: '', unitFloor: '',
    contractPeriod: '', date: '2026-01-01', otherNotes: '', tenantSign: 'مستأجر', companySign: 'المكتب', sections: s,
  };
};
const stateOf = (db: DBT, id: string) => {
  const x = db.get<{ locked: number; sections_json: string; deleted_at: string | null }>(
    `SELECT locked, sections_json, deleted_at FROM handovers WHERE id = ?`, [id])!;
  return { locked: Number(x.locked), ac: (JSON.parse(x.sections_json) as HandoverSection[])[0].items[0].receiveCondition, deleted: x.deleted_at != null };
};
const lockRejects = (db: DBT) => db.all<{ tbl: string; payload: string }>(`SELECT tbl, payload FROM sync_rejects WHERE reason = ?`,
  [t('sync.handoverLocked', { lng: 'ar' })]).map((x) => {
  const d = (JSON.parse(x.payload) as { d: { locked: number; sections_json: string } }).d;
  return { tbl: x.tbl, locked: Number(d.locked), ac: (JSON.parse(d.sections_json) as HandoverSection[])[0].items[0].receiveCondition };
});

describe('E-1 · بعد الإصلاح', () => {
  test('التعديل الساقط يظهر مرفوضاً في «حالة المزامنة» على جهازه، ولا رفض على جهاز القفل', async () => {
    const { a, b, sync, id, json } = await twoDevices();
    updateHandover(a, id, fill('سليم', json));
    lockHandover(a, id);
    await sync(a);
    await tick();
    updateHandover(b, id, fill('تالف', json));
    await sync(b);
    await sync(a);
    await sync(b);
    expect(stateOf(a, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    expect(stateOf(b, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    expect(lockRejects(b)).toEqual([{ tbl: 'handovers', locked: 0, ac: 'تالف' }]);
    expect(syncStatus(b).rejected).toBe(1);
    expect(syncStatus(a).rejected).toBe(0);
    expect(syncStatus(b).pending).toBe(0);
    a.close();
    b.close();
  });

  test('القفل لم يُرفع بعد والتعديل سبقه إلى السحابة: يُرفض على جهاز القفل ويعود المقفَل إلى الكل', async () => {
    const { a, b, sync, id, json } = await twoDevices();
    updateHandover(a, id, fill('سليم', json));
    lockHandover(a, id); // بلا اتصال
    await tick();
    updateHandover(b, id, fill('تالف', json));
    await sync(b); // التعديل في السحابة قبل القفل
    await sync(a);
    await sync(b);
    await sync(a);
    expect(stateOf(a, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    expect(stateOf(b, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    expect(lockRejects(a)).toEqual([{ tbl: 'handovers', locked: 0, ac: 'تالف' }]);
    a.close();
    b.close();
  });

  test('القفل في السحابة وتعديلٌ غير مقفل يكتب فوقه (سباق الرفع): جهاز المالك يرفضه ويعيد نسخته المقفلة بوقتها', async () => {
    const { r, a, b, sync, id, json } = await twoDevices();
    updateHandover(a, id, fill('سليم', json));
    lockHandover(a, id);
    await sync(a);
    const lockedAt = r.docs.get('handovers__' + id)!.u;
    await tick();
    updateHandover(b, id, fill('تالف', json));
    // رفع (ب) قبل أن يسحب القفل: نسخته غير المقفلة تكتب فوق المقفلة في السحابة
    const at = b.get<{ c: string }>(`SELECT changed_at AS c FROM sync_outbox WHERE tbl = 'handovers' AND pk = ?`, [id])!.c;
    await r.write([buildDoc(b, 'handovers', id, 'upsert', at, getMeta(b, 'device_id')!)]);
    b.run(`DELETE FROM sync_outbox WHERE tbl = 'handovers'`);
    await sync(a);
    expect(lockRejects(a)).toEqual([{ tbl: 'handovers', locked: 0, ac: 'تالف' }]);
    await sync(b);
    await sync(a);
    expect(stateOf(a, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    expect(stateOf(b, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    const cloud = r.docs.get('handovers__' + id)!;
    expect(Number(cloud.d!.locked)).toBe(1);
    expect(cloud.u).toBe(lockedAt); // بوقت القفل لا بوقت الإعادة
    a.close();
    b.close();
  });

  test('قبل القفل: تعديل المالك من الجهازين يمضي بالحسم المعتاد ثم يُقفل بلا رفض', async () => {
    const { a, b, sync, id, json } = await twoDevices();
    updateHandover(a, id, fill('سليم', json));
    await sync(a);
    await sync(b);
    expect(stateOf(b, id)).toEqual({ locked: 0, ac: 'سليم', deleted: false });
    await tick();
    updateHandover(b, id, fill('تالف', json));
    await sync(b);
    await sync(a);
    expect(stateOf(a, id)).toEqual({ locked: 0, ac: 'تالف', deleted: false });
    lockHandover(a, id);
    await sync(a);
    await sync(b);
    expect(stateOf(a, id)).toEqual({ locked: 1, ac: 'تالف', deleted: false });
    expect(stateOf(b, id)).toEqual({ locked: 1, ac: 'تالف', deleted: false });
    expect(syncStatus(a).rejected).toBe(0);
    expect(syncStatus(b).rejected).toBe(0);
    a.close();
    b.close();
  });

  test('إقفالٌ ثانٍ بلا اتصال لنسخةٍ أخرى: يغلب القفل الذي بلغ السحابة أولاً ويُسجَّل المتأخر مرفوضاً', async () => {
    const { a, b, sync, id, json } = await twoDevices();
    updateHandover(a, id, fill('سليم', json));
    lockHandover(a, id);
    await sync(a);
    await tick();
    updateHandover(b, id, fill('تالف', json));
    lockHandover(b, id); // بلا اتصال ولم يسحب قفل (أ)
    await sync(b);
    await sync(a);
    await sync(b);
    expect(stateOf(a, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    expect(stateOf(b, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    expect(lockRejects(b)).toEqual([{ tbl: 'handovers', locked: 1, ac: 'تالف' }]);
    expect(syncStatus(a).rejected).toBe(0);
    a.close();
    b.close();
  });

  test('ما سوى البنود والقفل يمضي على المقفَل: نقله إلى السلة يصل الجهاز الآخر بلا رفض', async () => {
    const { a, b, sync, id, json } = await twoDevices();
    updateHandover(a, id, fill('سليم', json));
    lockHandover(a, id);
    await sync(a);
    await sync(b);
    await tick();
    a.run(`UPDATE handovers SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    await sync(a);
    await sync(b);
    expect(stateOf(b, id)).toEqual({ locked: 1, ac: 'سليم', deleted: true });
    expect(syncStatus(a).rejected).toBe(0);
    expect(syncStatus(b).rejected).toBe(0);
    a.close();
    b.close();
  });
});

/* ═══ المدقق المستقل (review11): قفل العضو، ونافذة أمان السحب، ونقل الوحدة بعد الإقفال · وما يتصل بها ═══ */

/** دورة الجهاز في run تسحب، وقبل أن ترفع يجري ما في between (والكتابة بعدها بلا شرط كما في السحابة) */
async function racing(r: MemoryRemote, run: () => Promise<unknown>, between: () => Promise<unknown>) {
  const write0 = r.write.bind(r);
  let once = true;
  r.write = async (docs: RemoteDoc[]): Promise<WriteResult[]> => {
    if (once) { once = false; await between(); }
    return write0(docs);
  };
  try { await run(); } finally { r.write = write0; }
}
/** مضمون المحضر في السحابة */
const cloudOf = (r: MemoryRemote, id: string) => {
  const d = r.docs.get('handovers__' + id)!.d!;
  return { locked: Number(d.locked), ac: (JSON.parse(String(d.sections_json)) as HandoverSection[])[0].items[0].receiveCondition };
};
const moveUnit = (db: DBT, unit: string, from: string, to: string) => {
  db.run(`UPDATE units SET property_id = ? WHERE id = ?`, [to, unit]);
  retagUnitTree(db, unit, from, to);
};

describe('E-1 · بعد المدقق المستقل', () => {
  test('قفلان مختلفان رُفعا في سباق ثم نُقلت الوحدة قبل السحب: يغلب ما بلغ السحابة أولاً على الجهازين', async () => {
    const { r, a, b, sync, id, json, unit, p1, p2 } = await twoDevices();
    updateHandover(a, id, fill('سليم', json));
    lockHandover(a, id);
    await tick();
    updateHandover(b, id, fill('تالف', json));
    lockHandover(b, id);
    // (ب) يسحب قبل قفل (أ) ويرفع بعده: قفله يكتب فوق قفل (أ) في السحابة
    await racing(r, () => sync(b), () => sync(a));
    expect(cloudOf(r, id)).toEqual({ locked: 1, ac: 'تالف' });
    // و(أ) ينقل الوحدة قبل أن يسحب: يُعاد رفع محضره المقفل بوقت النقل لا بوقت قفله
    await tick();
    moveUnit(a, unit, p1, p2);
    for (let i = 0; i < 3; i++) { await sync(a); await sync(b); }
    expect(stateOf(a, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    expect(stateOf(b, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    expect(cloudOf(r, id)).toEqual({ locked: 1, ac: 'سليم' });
    expect(lockRejects(b)).toContainEqual({ tbl: 'handovers', locked: 1, ac: 'تالف' });
    expect(lockRejects(a).every((x) => x.ac === 'تالف')).toBe(true);
    expect(syncStatus(a).pending + syncStatus(b).pending).toBe(0);
    a.close();
    b.close();
  });

  test('قفلٌ بلا اتصال لم يُرفع وقفلٌ آخر بلغ السحابة قبله: يغلب ما في السحابة ولو أُقفل بعده، ويُرى الأول مرفوضاً على جهازه', async () => {
    const { a, b, sync, id, json } = await twoDevices();
    updateHandover(a, id, fill('سليم', json));
    lockHandover(a, id); // بلا اتصال
    await tick();
    updateHandover(b, id, fill('تالف', json));
    lockHandover(b, id);
    await sync(b); // قفل (ب) في السحابة أولاً: صار هو المحضر النهائي عند كل من يسحب
    await sync(a);
    await sync(b);
    expect(stateOf(a, id)).toEqual({ locked: 1, ac: 'تالف', deleted: false });
    expect(stateOf(b, id)).toEqual({ locked: 1, ac: 'تالف', deleted: false });
    expect(lockRejects(a)).toEqual([{ tbl: 'handovers', locked: 1, ac: 'سليم' }]);
    expect(syncStatus(b).rejected).toBe(0);
    expect(syncStatus(a).pending).toBe(0);
    a.close();
    b.close();
  });

  test('إعادة رفع نسخةٍ غير مقفلة ببنود القفل نفسها (نقل الوحدة) يغلبها القفل بلا رفض', async () => {
    const { a, b, sync, id, json, unit, p1, p2 } = await twoDevices();
    updateHandover(a, id, fill('سليم', json));
    await sync(a);
    await sync(b);
    lockHandover(a, id);
    await sync(a);
    await tick();
    moveUnit(b, unit, p1, p2); // (ب) لم يسحب القفل بعد
    await sync(b);
    await sync(a);
    await sync(b);
    expect(stateOf(a, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    expect(stateOf(b, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    expect(syncStatus(a).rejected).toBe(0);
    expect(syncStatus(b).rejected).toBe(0);
    a.close();
    b.close();
  });

  test('عضوٌ يقرأ المحضر ولا يكتبه: يُبقي القفل الذي سحبه ولا يرفعه، ويعيده جهاز المالك الذي أقفله', async () => {
    const { r, a, sync, id, json } = await twoDevices();
    const ro: Access = { owner: false, uid: 'member-ro-e1', perms: { contracts: 1 }, allProps: true, props: [] };
    const m = memDb();
    enableSync(m, ro.uid!);
    m.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'u-review9-e1', profile: { name: 'عضو مصطنع' } })]);
    m.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, ['u-review9-e1']);
    const memberSync = async () => {
      Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, ro).doc });
      try { return await syncOnce(m, r, getMeta(m, 'device_id')!); }
      finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
    };
    updateHandover(a, id, fill('سليم', json));
    lockHandover(a, id);
    await sync(a);
    await memberSync();
    expect(stateOf(m, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    // جهاز مالكٍ آخر كتب في سباق نسخته غير المقفلة فوق القفل
    const cur = r.docs.get('handovers__' + id)!;
    const s = JSON.parse(String(cur.d!.sections_json)) as HandoverSection[];
    s[0].items[0].receiveCondition = 'تالف';
    r.inject({ ...cur, d: { ...cur.d!, locked: 0, sections_json: JSON.stringify(s) }, u: new Date().toISOString(), dev: 'DEV-OWNER-OTHER' });
    await memberSync();
    expect(stateOf(m, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    expect(lockRejects(m)).toEqual([{ tbl: 'handovers', locked: 0, ac: 'تالف' }]);
    expect(m.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'handovers' AND reason != ?`, [t('sync.handoverLocked', { lng: 'ar' })])!.n).toBe(0);
    expect(m.get(`SELECT 1 FROM sync_outbox WHERE tbl = 'handovers'`)).toBeUndefined();
    await sync(a);
    await memberSync();
    expect(cloudOf(r, id)).toEqual({ locked: 1, ac: 'سليم' });
    expect(stateOf(a, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    expect(stateOf(m, id)).toEqual({ locked: 1, ac: 'سليم', deleted: false });
    a.close();
    m.close();
  });
});
