/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ١: حذف الأب الوارد كان يفكّ أبناءه أو يحذفهم ويضعهم في الطابور بوقت الآن،
 * فيغلب على نسخة الابن الواردة الأحدث في الدفعة نفسها · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { mergeTenants } from '@/domain/tenants';
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
