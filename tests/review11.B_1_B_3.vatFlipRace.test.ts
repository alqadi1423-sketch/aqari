/**
 * المدقق المستقل على إصلاح B-3 · منخفض · src/sync/engine.ts: ownerColsIssue (يرفض الصف كله إذا خالف vat_enabled ما على جهاز المالك)
 * ومسار التعارض في applyOne (لا نظير لـ keepOpening لأعمدة OWNER_ONLY_COLS)
 *
 * السيناريو (بيانات مصطنعة): المنشأة غير مسجّلة. المالك يفعّل التسجيل على جهازه ولم يزامن بعد (الدورة كل دقيقة، أو هو بلا اتصال).
 * عضوٌ له «كامل» المنشأة والقوالب يعدّل اسم المنشأة ويزامن: نسخته تحمل التسجيل كما عرفه (مطفأ) وهي أحدث. جهاز المالك يسحبها فيغلب
 * الوارد تعديله المعلَّق، ثم يرفضها ownerColsIssue لأن vat_enabled فيها غير ما عنده، ويرفع نسخته: يضيع تعديل الاسم المشروع من المالك
 * ومن السحابة ومن جهاز العضو، ويظهر عند المالك رفضٌ لكتابةٍ لم يزوّر فيها أحد.
 *
 * لماذا يهم: الإصلاح نفسه يَعِد بألا يُرفض «تعديل اسم المنشأة المشروع بقيمةٍ قديمة» (adoptOwnerCols على جهاز العضو)، لكنه يغطي ترتيباً
 * واحداً · والمشروع حلّ الحالة نفسها للافتتاحي (keepOpening · المدقق الخارجي Q١): يبقى عمود المالك المعلَّق ويُقبل باقي الصف من العضو.
 *
 * السلوك الصحيح: يبقى تسجيل الضريبة كما فعّله المالك، ويُقبل اسم العضو، ولا رفض · وتتفق السحابة والجهازان على (الاسم الجديد، مسجّلة).
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce, setSyncState } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteStore } from '@/sync/types';

const OWNER = 'OWNER-R11V';
const dev = (db: DB) => getMeta(db, 'device_id')!;

test('B-3 · تفعيل المالك التسجيلَ قبل أن يزامن لا يُسقط تعديل العضو المشروع لاسم المنشأة', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, OWNER);
  owner.run(`UPDATE company SET vat_enabled = 0, name = 'منشأة مصطنعة' WHERE id = 1`);
  await syncOnce(owner, r, dev(owner));

  const a: Access = { owner: false, uid: 'MEMBER-R11V', perms: { company: 3 }, allProps: true, props: [] };
  const m = memDb();
  enableSync(m, a.uid!);
  m.run(`DELETE FROM sync_outbox`);
  m.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: OWNER, profile: { name: 'عضو مصطنع' } })]);
  setSyncState(m, 'org', OWNER);
  const remote: RemoteStore = {
    pull: (c, l) => r.pull(c, l), write: (d) => r.write(d), clockSample: () => r.clockSample(),
    reserveBlocks: (q) => r.reserveBlocks(q), takeInvoiceSeq: (f) => r.takeInvoiceSeq(f), memberMode: true,
    annotate: (d, doc) => annotate(d, doc, a).doc,
  };
  const msync = () => syncOnce(m, remote, dev(m));
  await msync();

  // المالك يفعّل التسجيل ولم يزامن، والعضو يعدّل الاسم بعده ويزامن
  owner.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
  await new Promise((res) => setTimeout(res, 5));
  m.run(`UPDATE company SET name = 'منشأة مصطنعة معدّلة' WHERE id = 1`);
  await msync();
  await syncOnce(owner, r, dev(owner));
  await syncOnce(owner, r, dev(owner));
  await msync();

  const o = owner.get<{ name: string; v: number }>(`SELECT name, vat_enabled AS v FROM company WHERE id = 1`)!;
  const mm = m.get<{ name: string; v: number }>(`SELECT name, vat_enabled AS v FROM company WHERE id = 1`)!;
  const rejects = owner.all<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE tbl = 'company'`);
  // eslint-disable-next-line no-console
  console.log('B-3 سباق التسجيل · المالك:', o, '· العضو:', mm, '· المرفوض:', rejects.length);
  expect(o).toEqual({ name: 'منشأة مصطنعة معدّلة', v: 1 });
  expect(mm).toEqual({ name: 'منشأة مصطنعة معدّلة', v: 1 });
  expect(rejects).toEqual([]);
  owner.close(); m.close();
});
