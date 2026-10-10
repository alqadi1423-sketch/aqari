/**
 * المراجعات الخارجية «ثالثاً أ ١٠» (قرار المالك 2026-10-09): تقسيم الدفعة عند الرفض بسقف · دفعةٌ يُرفض كل ما فيها لا تصير مئات
 * الطلبات، وما بعد السقف يبقى في الطابور لدورةٍ تالية · والدفعة المقبولة كما هي · بيانات مصطنعة.
 */
import { FirestoreRemote, MAX_SPLIT_REQUESTS } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';

const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 'units__U' + i, t: 'units', k: 'U' + i, d: { id: 'U' + i },
  u: '2026-01-01T00:00:00Z', dev: 'D', del: false, g: ['units|P1'], pids: ['P1'] })) as unknown as RemoteDoc[];

function remote(status: number | null) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return status ? { ok: false, status, text: async () => '{"error":{}}' } : { ok: true, status: 200, text: async () => '{}' };
  }) as unknown as typeof fetch;
  const r = new FirestoreRemote({ projectId: 'demo', uid: 'U', org: 'O', idToken: async () => 'T', baseUrl: 'http://x', fetchImpl });
  return { r, calls: () => calls };
}

test('دفعةٌ يُرفض كل ما فيها بـ٤٠٣ أو ٤٠٠ لا تتجاوز سقف الطلبات · وكل صفٍّ له نتيجة', async () => {
  for (const status of [403, 400]) {
    const { r, calls } = remote(status);
    const out = await r.write(docs(400));
    expect(out).toHaveLength(400);
    expect(out.every((x) => !x.ok)).toBe(true);
    expect(calls()).toBeLessThanOrEqual(MAX_SPLIT_REQUESTS);
  }
});

test('الدفعة المقبولة بطلبٍ واحد', async () => {
  const { r, calls } = remote(null);
  expect((await r.write(docs(50))).every((x) => x.ok)).toBe(true);
  expect(calls()).toBe(1);
});
