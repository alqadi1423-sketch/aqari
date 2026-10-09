/**
 * دراسة ٨ (تحمّل المنشأة الكبيرة) · قرار المالك 2026-10-09: «سقف ٥٠٠ كتابة للالتزام الآن، وقسمة الدفعة عند ٤٠٠ كما عند
 * ٤٠٣. إصلاح فوري.» و«القوائم المالية بعبارة مجمّعة واحدة. إصلاح فوري.» · بيانات مصطنعة.
 */
import { FirestoreRemote } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';
import { memDb } from './helpers/testDb';
import { financialStatementBlock } from '@/domain/finStatements';
import { postEntry } from '@/domain/accounting/post';

function fakeRemote(reject: (writes: number) => number | null) {
  const sizes: number[] = [];
  const fetchImpl = (async (_url: string, init?: { body?: string }) => {
    const n = (JSON.parse(String(init?.body ?? '{}')) as { writes?: unknown[] }).writes?.length ?? 0;
    const status = reject(n);
    if (status) return { ok: false, status, text: async () => '{"error":{"status":"INVALID_ARGUMENT"}}' };
    sizes.push(n);
    return { ok: true, status: 200, text: async () => JSON.stringify({ commitTime: new Date().toISOString() }) };
  }) as unknown as typeof fetch;
  const remote = new FirestoreRemote({ projectId: 'demo', uid: 'U', org: 'O', idToken: async () => 'T', baseUrl: 'http://x', fetchImpl });
  return { remote, sizes };
}
const docs = (n: number): RemoteDoc[] => Array.from({ length: n }, (_, i) => ({
  id: 'units__U' + i, t: 'units', k: 'U' + i, d: { id: 'U' + i }, u: '2026-01-01T00:00:00Z', dev: 'D', del: false,
  g: ['units|P1'], pids: ['P1'],
  companions: [{ id: 'units~pub__U' + i, t: 'units~pub', k: 'U' + i, d: { id: 'U' + i }, u: '2026-01-01T00:00:00Z', dev: 'D', del: false, g: ['units|P1'], pids: ['P1'] }],
} as unknown as RemoteDoc));

test('الالتزام لا يتجاوز ٥٠٠ كتابة · والصف وإسقاطه في التزامٍ واحد', async () => {
  const { remote, sizes } = fakeRemote(() => null);
  const r = await remote.write(docs(400));
  expect(r.every((x) => x.ok)).toBe(true);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
  expect(sizes.reduce((s, n) => s + n, 0)).toBe(800);
  expect(sizes.every((n) => n % 2 === 0)).toBe(true);
});

test('الخطأ ٤٠٠ يقسم الدفعة كما يقسمها ٤٠٣', async () => {
  const { remote, sizes } = fakeRemote((n) => (n > 120 ? 400 : null));
  const r = await remote.write(docs(200));
  expect(r.every((x) => x.ok)).toBe(true);
  expect(sizes.reduce((s, n) => s + n, 0)).toBe(400);
});

test('القوائم المالية بعبارات ثابتة العدد لا بعدد الحسابات', () => {
  const db = memDb();
  postEntry(db, { date: '2026-02-01', memo: 'قيد مصطنع', lines: [{ account: '1100', debit: 5000, credit: 0 }, { account: '3100', debit: 0, credit: 5000 }] });
  let n = 0;
  const counted: DB = new Proxy(db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if ((prop === 'get' || prop === 'all') && typeof v === 'function') return (...a: unknown[]) => { n++; return (v as (...x: unknown[]) => unknown).apply(target, a); };
      return v;
    },
  });
  const before = financialStatementBlock(db, 'balance', '2026-01-01', '2026-12-31');
  n = 0;
  const after = financialStatementBlock(counted, 'balance', '2026-01-01', '2026-12-31');
  expect(after).toEqual(before);
  expect(n).toBeLessThan(12);
  n = 0;
  financialStatementBlock(counted, 'income', '2026-01-01', '2026-12-31');
  expect(n).toBeLessThan(12);
  db.close();
});
