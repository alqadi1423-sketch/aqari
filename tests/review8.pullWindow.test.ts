/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ٢: ts وقت الطلب لا وقت الالتزام، فمستندٌ قواعده ثقيلة قد يظهر بعد مستندٍ ts أكبر منه ·
 * والمؤشر كان يتقدم إلى آخر ما قُرئ فيتخطاه نهائياً · الآن: المؤشر المحفوظ لا يتجاوز وقت القراءة في الخادم ناقص نافذة الأمان ·
 * والمحادثة تعيد الاستعلام من مؤشرها ناقص النافذة · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { FirestoreRemote, docToFields } from '@/cloud/firestore';
import { enableSync, syncOnce, stageInbox, applyInbox, docId } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { RemoteDoc } from '@/sync/types';

type Row = { name: string; ts: string; fields: Record<string, unknown> };
const iso = (ms: number) => new Date(ms).toISOString();

/** خادمٌ مصطنع: runQuery بترتيب (ts، الاسم) وبدايته، ووقت قراءة، ومستندات تظهر متأخرة عن وقتها */
function fakeFirestore(nowMs: () => number) {
  const rows: Row[] = [];
  const queries: Array<Record<string, any>> = [];
  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
    const ok = (v: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(v), json: async () => v });
    if (!init?.method || init.method === 'GET') return { ok: false, status: 404, text: async () => '{}', json: async () => ({}) };
    const body = JSON.parse(init.body ?? '{}');
    if (url.endsWith(':commit')) return ok({ commitTime: iso(nowMs()) });
    if (url.endsWith(':runQuery')) {
      const q = body.structuredQuery;
      queries.push(q);
      let list = [...rows].sort((a, b) => (a.ts === b.ts ? (a.name < b.name ? -1 : 1) : a.ts < b.ts ? -1 : 1));
      if (q.startAt) {
        const [tsV, refV] = q.startAt.values as Array<{ timestampValue?: string; referenceValue?: string }>;
        list = list.filter((r) => {
          if (!refV) return q.startAt.before ? r.ts >= tsV.timestampValue! : r.ts > tsV.timestampValue!;
          if (r.ts !== tsV.timestampValue) return r.ts > tsV.timestampValue!;
          return q.startAt.before ? r.name >= refV.referenceValue! : r.name > refV.referenceValue!;
        });
      }
      list = list.slice(0, q.limit);
      const readTime = iso(nowMs());
      return ok(list.length ? list.map((r) => ({ document: { name: r.name, fields: { ...r.fields, ts: { timestampValue: r.ts } } }, readTime })) : [{ readTime }]);
    }
    return ok({});
  }) as unknown as typeof fetch;
  const remote = new FirestoreRemote({ projectId: 'demo-p', uid: 'U1', idToken: async () => 'T', baseUrl: 'http://x', fetchImpl });
  const add = (id: string, tsMs: number) => {
    const doc: RemoteDoc = { id: 'tenants__' + id, t: 'tenants', k: id, u: iso(tsMs), dev: 'other', del: false,
      d: { id, name: 'مستأجر مصطنع ' + id, vat: '', phone: '', credit_halalas: 0, archived: 0, created_at: iso(tsMs), deleted_at: null } };
    rows.push({ name: remote.docName(doc.id), ts: iso(tsMs), fields: docToFields(doc) as Record<string, unknown> });
  };
  return { remote, add, queries };
}

test('٢ مستندٌ ظهر بعد مستندٍ وقته أكبر منه لا يتخطاه المؤشر: يُسحب في الدورة التالية', async () => {
  let now = Date.parse('2026-06-01T12:00:00.000Z');
  const f = fakeFirestore(() => now);
  const db = memDb();
  enableSync(db, 'U1');
  const dev = getMeta(db, 'device_id')!;
  f.add('A', now - 120_000);
  f.add('B', now - 10_000);
  await syncOnce(db, f.remote, dev);
  expect(db.get(`SELECT 1 FROM tenants WHERE id = 'B'`)).toBeTruthy();
  // التزامٌ بطيء: وقته قبل B ولم يظهر إلا الآن
  f.add('C', now - 30_000);
  now += 5_000;
  await syncOnce(db, f.remote, dev);
  expect(db.get(`SELECT 1 FROM tenants WHERE id = 'C'`)).toBeTruthy();
  db.close();
});

test('٢ وما تجاوز النافذة لا يُعاد سحبه: المؤشر يتقدم إليه', async () => {
  let now = Date.parse('2026-06-01T12:00:00.000Z');
  const f = fakeFirestore(() => now);
  const db = memDb();
  enableSync(db, 'U1');
  const dev = getMeta(db, 'device_id')!;
  f.add('A', now - 120_000);
  f.add('B', now - 10_000);
  await syncOnce(db, f.remote, dev);
  now += 5 * 60_000;
  await syncOnce(db, f.remote, dev);
  const before = f.queries.length;
  now += 60_000;
  await syncOnce(db, f.remote, dev);
  const q = f.queries[before];
  expect(q.startAt.values[1].referenceValue).toBe(f.remote.docName('tenants__B'));
  db.close();
});

test('٢ (التحقق المستقل) صفحتان في دورة: مستندٌ يلتزم بين قراءتيهما ووقته قبل آخر الأولى لا يتخطاه الموضع الآمن', async () => {
  const T = Date.parse('2026-06-01T12:00:00.000Z');
  let reads = 0;
  let now = T;
  const f = fakeFirestore(() => now);
  const db = memDb();
  enableSync(db, 'U1');
  const dev = getMeta(db, 'device_id')!;
  for (let i = 0; i < 499; i++) f.add('A' + String(i).padStart(3, '0'), T - 600_000 + i);
  f.add('L', T - 59_500); // آخر الصفحة الأولى (٥٠٠) بعد حدّها
  f.add('M', T - 58_000); // في الصفحة الثانية قبل حدّها
  // Z طُلب قبل L ويلتزم بعد قراءة الصفحة الأولى · والثانية بعد ثلاث ثوانٍ
  const realPull = f.remote.pull.bind(f.remote);
  f.remote.pull = async (c, l) => {
    const page = await realPull(c, l);
    if (++reads === 1) { f.add('Z', T - 59_800); now = T + 3_000; }
    return page;
  };
  await syncOnce(db, f.remote, dev);
  await syncOnce(db, f.remote, dev);
  expect(db.get(`SELECT 1 FROM tenants WHERE id = 'M'`)).toBeTruthy();
  expect(db.get(`SELECT 1 FROM tenants WHERE id = 'Z'`)).toBeTruthy();
  db.close();
});

test('٢ (التحقق المستقل) المستند المرفوض يُسحب ثانيةً في النافذة فلا يتكرر رفضه في السجل', () => {
  const db = memDb();
  enableSync(db, 'U1');
  const bad = { id: docId('tenants', 'TB'), t: 'tenants', k: 'TB', u: '2026-01-01T00:00:00.000Z', dev: 'other', del: false,
    d: { id: 'غيره', name: 'مستأجر مصطنع', created_at: '2026-01-01T00:00:00.000Z' } };
  for (let i = 0; i < 3; i++) { stageInbox(db, [bad]); applyInbox(db, 'this-device'); }
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE pk = 'TB'`)!.n)).toBe(1);
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'رفض وارد'`)!.n)).toBe(1);
  db.close();
});
