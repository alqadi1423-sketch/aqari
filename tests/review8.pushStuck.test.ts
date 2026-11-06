/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ١٥: صفوفٌ يرفضها الخادم رفضاً دائماً (INVALID_ARGUMENT أو مستندٌ فوق ١ ميغابايت)
 * كانت تبقى في رأس الطابور فتسدّه · الآن تنتقل إلى سجل المرفوض ويُرفع ما بعدها · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce, docId, outboxCount } from '@/sync/engine';
import { FirestoreRemote } from '@/cloud/firestore';
import { getMeta } from '@/repos/settings';
import type { RemoteDoc, WriteResult } from '@/sync/types';

/** سحابة ترفض رفضاً دائماً كل مستندٍ مفتاحه يبدأ بـ BAD */
class Refusing extends MemoryRemote {
  async write(docs: RemoteDoc[]): Promise<WriteResult[]> {
    const out: WriteResult[] = [];
    for (const d of docs) {
      if (d.k.startsWith('BAD')) out.push({ ok: false, code: 'INVALID_ARGUMENT', message: 'invalid' });
      else out.push(...(await super.write([d])));
    }
    return out;
  }
}

test('١٥ أكثر من دفعةٍ كاملة من المرفوض رفضاً دائماً في رأس الطابور لا تمنع رفع ما بعدها', async () => {
  const r = new Refusing();
  const db = memDb();
  enableSync(db, 'user-1');
  await syncOnce(db, r, getMeta(db, 'device_id')!);
  for (let i = 0; i < 410; i++) {
    db.run(`INSERT INTO tenants (id, name, created_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')`, ['BAD' + String(i).padStart(3, '0'), 'مستأجر مصطنع ' + i]);
  }
  db.run(`INSERT INTO tenants (id, name, created_at) VALUES ('GOOD1', 'مستأجر سليم مصطنع', '2026-01-01T00:00:00.000Z')`);
  await syncOnce(db, r, getMeta(db, 'device_id')!);
  expect(r.docs.has(docId('tenants', 'GOOD1'))).toBe(true);
  expect(outboxCount(db)).toBe(0);
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE pk LIKE 'BAD%'`)!.n)).toBe(410);
  db.close();
});

test('١٥ والمستند فوق حدّ الخادم (١ ميغابايت) لا يُرسل ويُرفض دائماً بسببه', async () => {
  const sent: string[] = [];
  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    sent.push(init?.body ?? '');
    return { ok: true, status: 200, text: async () => JSON.stringify({ commitTime: new Date().toISOString() }) };
  }) as unknown as typeof fetch;
  const fs = new FirestoreRemote({ projectId: 'demo-p', uid: 'U1', idToken: async () => 'T', baseUrl: 'http://x', fetchImpl });
  const doc = (k: string, size: number): RemoteDoc => ({ id: 'tenants__' + k, t: 'tenants', k, u: '2026-01-01T00:00:00.000Z', dev: 'd', del: false,
    d: { id: k, name: 'س'.repeat(size) } });
  const res = await fs.write([doc('BIG', 600_000), doc('OK', 10)]);
  expect(res.map((x) => [x.ok, x.code])).toEqual([[false, 'DOC_TOO_LARGE'], [true, 'OK']]);
  expect(sent.every((b) => !b.includes('BIG'))).toBe(true);
});
