/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ١: حذف الأب الوارد كان يفكّ أبناءه أو يحذفهم ويضعهم في الطابور بوقت الآن،
 * فيغلب على نسخة الابن الواردة الأحدث في الدفعة نفسها · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { mergeTenants, findOrCreateTenant } from '@/domain/tenants';
import { purgeFromTrash } from '@/domain/trash';
import { enableSync, syncOnce, docId } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

const OWN = 'owner-1';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const tenantOf = (db: DB, cid: string) => db.get<{ t: string | null }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [cid])!.t;

async function world() {
  const r = new MemoryRemote();
  const a = memDb(); const b = memDb();
  enableSync(a, OWN); enableSync(b, OWN);
  const p = addProperty(a, { name: 'عقار مصطنع' });
  const u1 = addUnit(a, p, { unit_no: 'M-1' });
  const u2 = addUnit(a, p, { unit_no: 'M-2' });
  const c1 = confirmContract(a, contractInput(u1, { tenant: 'مستأجر مكرر مصطنع', idNumber: '1000000071', phone: '0500000071' }));
  const c2 = confirmContract(a, contractInput(u2, { tenant: 'مستأجر أصلي مصطنع', idNumber: '', phone: '0500000072' }));
  await sync(a, r); await sync(b, r);
  return { r, a, b, c1, c2 };
}

test('١ دمج مستأجرين ثم إفراغ السلة ثم مزامنة: عقد المدموج على الوجهة في الجهازين لا بلا مستأجر', async () => {
  const { r, a, b, c1, c2 } = await world();
  const keep = tenantOf(a, c2)!;
  const drop = tenantOf(a, c1)!;
  mergeTenants(a, keep, [drop], { allowDifferentIds: true });
  purgeFromTrash(a, 'tenants', drop);
  expect(tenantOf(a, c1)).toBe(keep);
  await sync(a, r);
  await sync(b, r);
  expect(b.get(`SELECT 1 FROM tenants WHERE id = ?`, [drop])).toBeFalsy();
  expect(tenantOf(b, c1)).toBe(keep);
  // ولا يُرفع من ب ما يفكّ العقد في السحابة ثم في أ
  await sync(b, r); await sync(a, r);
  expect((r.docs.get(docId('contracts', c1))!.d as Record<string, unknown>).tenant_id).toBe(keep);
  expect(tenantOf(a, c1)).toBe(keep);
  a.close(); b.close();
});

test('١ والابن الذي يُفكّ لأن نسخته الواردة لم تصل يُرفع بوقت آخر نسخةٍ عرفها الجهاز له لا بوقت الآن', async () => {
  const { r, a, b, c1 } = await world();
  const drop = tenantOf(b, c1)!;
  const tomb: RemoteDoc = { id: docId('tenants', drop), t: 'tenants', k: drop, u: '2099-01-01T00:00:00.000Z', dev: 'other', del: true, d: null, dby: OWN };
  r.inject(tomb);
  // وقت الحذف الوارد وقتُ كتابته في الخادم (لا يتجاوزه u)
  const at = r.docs.get(tomb.id)!.ts;
  await sync(b, r);
  expect(tenantOf(b, c1)).toBeNull();
  // ما رفعه ب للعقد المفكوك يحمل وقت آخر نسخةٍ عرفها له (قبل الحذف) لا وقت الآن ولا وقت الحذف (التحقق المستقل: رفعٌ منقسم) ·
  // فمآل العقد عند الحاذف أحدث منه فيغلبه
  const up = r.docs.get(docId('contracts', c1))!;
  expect((up.d as Record<string, unknown>).tenant_id).toBeNull();
  expect(up.u < at).toBe(true);
  expect(up.u).toBe(b.get<{ u: string }>(`SELECT u FROM sync_rowtime WHERE tbl = 'contracts' AND pk = ?`, [c1])!.u);
  a.close(); b.close();
});

test('١ (التحقق المستقل) رفعٌ منقسم: الحذف يصل ب في دفعةٍ قبل نقل العقد · فلا يغلب فكُّه النقلَ في أي جهاز', async () => {
  const { r, a, b, c1, c2 } = await world();
  const keep = tenantOf(a, c2)!;
  const drop = tenantOf(a, c1)!;
  mergeTenants(a, keep, [drop], { allowDifferentIds: true });
  await new Promise((res) => setTimeout(res, 20));
  purgeFromTrash(a, 'tenants', drop);
  const out = a.get<{ changed_at: string }>(`SELECT changed_at FROM sync_outbox WHERE tbl = 'tenants' AND pk = ?`, [drop])!;
  // الدفعة الأولى من أ (المستأجرون قبل العقود بالرتبة) فيها شاهد الحذف وحده · وب يسحب قبل الثانية
  r.inject({ id: docId('tenants', drop), t: 'tenants', k: drop, u: out.changed_at, dev: getMeta(a, 'device_id')!, del: true, d: null, dby: OWN });
  await sync(b, r);
  await sync(a, r);
  await sync(b, r); await sync(a, r);
  expect(tenantOf(a, c1)).toBe(keep);
  expect(tenantOf(b, c1)).toBe(keep);
  expect((r.docs.get(docId('contracts', c1))!.d as Record<string, unknown>).tenant_id).toBe(keep);
  a.close(); b.close();
});

/* ═══ تتمة المراجعة الأخيرة: تأجيل حذف الأب كله إلى ما بعد الإضافات كان يكسر ترتيب «الحذف أولاً» ═══ */

const natOf = (db: DB, id: string) => db.get<{ n: string; c: number }>(`SELECT national_id AS n, credit_halalas AS c FROM tenants WHERE id = ?`, [id]);
const rejectsOf = (db: DB) => db.all<{ tbl: string; pk: string; reason: string }>(`SELECT tbl, pk, reason FROM sync_rejects`);
const waitingOf = (db: DB) => db.all<{ tbl: string; pk: string }>(`SELECT tbl, pk FROM sync_inbox`);

test('١ (المراجعة الأخيرة) دمجٌ ينقل هوية المدموج إلى الوجهة ثم إفراغ السلة: الوجهة لا تُرفض بالفهرس الفريد على الجهاز الآخر', async () => {
  const { r, a, b, c1, c2 } = await world();
  const keep = tenantOf(a, c2)!;
  const drop = tenantOf(a, c1)!;
  // رصيدٌ دائن مصطنع للمدموج ينتقل بالدمج إلى الوجهة
  a.run(`UPDATE tenants SET credit_halalas = 50000 WHERE id = ?`, [drop]);
  await sync(a, r); await sync(b, r);
  mergeTenants(a, keep, [drop], { allowDifferentIds: true });
  purgeFromTrash(a, 'tenants', drop);
  expect(natOf(a, keep)).toEqual({ n: '1000000071', c: 50000 });
  await sync(a, r);
  const rep = await sync(b, r);
  expect(rejectsOf(b)).toEqual([]);
  expect(rep.rejected).toBe(0);
  expect(natOf(b, keep)).toEqual({ n: '1000000071', c: 50000 });
  expect(b.get(`SELECT 1 FROM tenants WHERE id = ?`, [drop])).toBeFalsy();
  expect(tenantOf(b, c1)).toBe(keep);
  // ولا يتغير شيء بدوراتٍ أخرى · والسحابة على الوجهة
  await sync(b, r); await sync(a, r); await sync(b, r);
  expect(natOf(a, keep)).toEqual({ n: '1000000071', c: 50000 });
  expect(natOf(b, keep)).toEqual({ n: '1000000071', c: 50000 });
  expect((r.docs.get(docId('contracts', c1))!.d as Record<string, unknown>).tenant_id).toBe(keep);
  a.close(); b.close();
});

test('١ (المراجعة الأخيرة) والوجهة مستأجرٌ جديد: لا يتعطّل الحذف والعقد والوجهة معاً على الجهاز الآخر', async () => {
  const { r, a, b, c1 } = await world();
  const drop = tenantOf(a, c1)!;
  const fresh = findOrCreateTenant(a, { name: 'مستأجر وجهة جديد مصطنع' });
  mergeTenants(a, fresh, [drop], { allowDifferentIds: true });
  purgeFromTrash(a, 'tenants', drop);
  await sync(a, r);
  await sync(b, r);
  expect(rejectsOf(b)).toEqual([]);
  expect(waitingOf(b)).toEqual([]);
  expect(natOf(b, fresh)?.n).toBe('1000000071');
  expect(tenantOf(b, c1)).toBe(fresh);
  expect(b.get(`SELECT 1 FROM tenants WHERE id = ?`, [drop])).toBeFalsy();
  await sync(b, r); await sync(a, r);
  expect(tenantOf(a, c1)).toBe(fresh);
  expect((r.docs.get(docId('contracts', c1))!.d as Record<string, unknown>).tenant_id).toBe(fresh);
  a.close(); b.close();
});

test('١ (المراجعة الأخيرة) والابن الذي تفشل نسخته الواردة بعد فكّه هنا يبقى في الصندوق ويُعاد حتى تصل وجهته · ولا يُرفع مفكوكاً', async () => {
  const { r, a, b, c1 } = await world();
  const drop = tenantOf(a, c1)!;
  const fresh = findOrCreateTenant(a, { name: 'مستأجر وجهة جديد مصطنع' });
  mergeTenants(a, fresh, [drop], { allowDifferentIds: true });
  purgeFromTrash(a, 'tenants', drop);
  await sync(a, r);
  // الوجهة الجديدة لم تصل ب بعد (رفعٌ انقطع قبلها) · فنسخة العقد الواردة تنتظرها
  const held = r.docs.get(docId('tenants', fresh))!;
  r.docs.delete(held.id);
  await sync(b, r);
  expect(b.get(`SELECT 1 FROM tenants WHERE id = ?`, [drop])).toBeFalsy();
  expect(waitingOf(b)).toEqual([{ tbl: 'contracts', pk: c1 }]);
  expect(rejectsOf(b)).toEqual([]);
  // لم يُرفع من ب عقدٌ مفكوك يغلب نقله
  const up = r.docs.get(docId('contracts', c1))!;
  expect(up.dev).toBe(getMeta(a, 'device_id'));
  expect((up.d as Record<string, unknown>).tenant_id).toBe(fresh);
  // وصلت الوجهة: يُطبَّق العقد الذي انتظر عليها
  r.inject(held);
  await sync(b, r);
  expect(waitingOf(b)).toEqual([]);
  expect(rejectsOf(b)).toEqual([]);
  expect(tenantOf(b, c1)).toBe(fresh);
  expect(natOf(b, fresh)?.n).toBe('1000000071');
  await sync(a, r);
  expect(tenantOf(a, c1)).toBe(fresh);
  a.close(); b.close();
});

test('١ (المراجعة الأخيرة) وحذفٌ بأبناء من غير المالك لا يُسلسل ولا يُفكّ ابنه ولو كانت له نسخةٌ واردة تنقله', async () => {
  const { r, a, b, c1, c2 } = await world();
  const keep = tenantOf(b, c2)!;
  const drop = tenantOf(b, c1)!;
  const cur = r.docs.get(docId('contracts', c1))!;
  r.inject({ ...cur, d: { ...cur.d!, tenant_id: keep }, u: '2099-01-01T00:00:00.000Z', dev: 'other' });
  r.inject({ id: docId('tenants', drop), t: 'tenants', k: drop, u: '2099-01-01T00:00:00.000Z', dev: 'other', del: true, d: null, dby: 'member-1' });
  await sync(b, r);
  expect(b.get(`SELECT 1 FROM tenants WHERE id = ?`, [drop])).toBeTruthy();
  expect(rejectsOf(b).find((x) => x.pk === drop)?.reason).toMatch(/المالك/);
  expect(tenantOf(b, c1)).toBe(keep);
  // ولا يُرفع من ب شيءٌ للعقد
  expect(r.docs.get(docId('contracts', c1))!.dev).toBe('other');
  a.close(); b.close();
});

test('١ (المراجعة الأخيرة) وحذف حامل القيمة الفريدة مؤجَّلٌ لابنٍ تبقيه نسخته الواردة عليه: الصف الوارد بالقيمة نفسها يُعاد لا يُرفض', async () => {
  const { r, a, b, c1, c2 } = await world();
  const drop = tenantOf(b, c1)!;
  const other = r.docs.get(docId('tenants', tenantOf(b, c2)!))!;
  // حذف المالك للمدموج · ومستأجرٌ جديد بهويته (بعد حذفه هناك) · وتعديلٌ للعقد من جهازٍ ثالث يبقيه على المدموج
  r.inject({ id: docId('tenants', drop), t: 'tenants', k: drop, u: '2099-01-01T00:00:00.000Z', dev: 'other', del: true, d: null, dby: OWN });
  const nid = 'T_SYNTH_NEW_1';
  r.inject({ ...other, id: docId('tenants', nid), k: nid, u: '2099-01-01T00:00:00.000Z', dev: 'other',
    d: { ...other.d!, id: nid, name: 'مستأجر جديد بالهوية مصطنع', national_id: '1000000071', credit_halalas: 0 } });
  const cur = r.docs.get(docId('contracts', c1))!;
  r.inject({ ...cur, d: { ...cur.d!, tenant_name: 'اسم معدّل مصطنع' }, u: '2099-01-01T00:00:00.000Z', dev: 'third' });
  const rep = await sync(b, r);
  expect(rejectsOf(b)).toEqual([]);
  expect(rep.rejected).toBe(0);
  expect(waitingOf(b)).toEqual([]);
  expect(b.get(`SELECT 1 FROM tenants WHERE id = ?`, [drop])).toBeFalsy();
  expect(natOf(b, nid)?.n).toBe('1000000071');
  a.close(); b.close();
});
