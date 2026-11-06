/**
 * المراجعة الشاملة · البند ٢ (تتمة · المراجعة الأخيرة): حال المحادثة تُسحب من مؤشرها ناقص نافذة الستين ثانية، والاستعلام صفحةٌ واحدة
 * بحدّ ٣٠٠ · فإن وقع ٣٠٠ عنصر حالة أو أكثر في النافذة أعاد كل سحبٍ الثلاثمئة نفسها ووقف المؤشر أبداً · الآن تُقلَّب الصفحات في الدورة
 * الواحدة بمؤشر (الوقت، اسم المستند) حتى صفحةٍ قصيرة كما تُقلَّب الرسائل · بعميل المحادثة الحقيقي فوق خادمٍ مصطنع · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { encodeFields } from '@/cloud/firestore';
import { ChatRemote } from '@/chat/remote';
import { applyRemoteThread, acksOf, pinnedIds, stateCursor } from '@/chat/store';
import { chatSyncOnce } from '@/chat/sync';
import { chatAcknowledge, type ChatSession } from '@/chat';
import { normTs, type ChatMe } from '@/chat/types';

const ROOT = 'projects/demo-p/databases/(default)/documents';
const G = 'G1';
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

type Row = { name: string; ts: string; fields: Record<string, unknown> };

/** خادمٌ مصطنع لمجموعة حال المحادثة: runQuery بترتيب (ts، الاسم) وحدّه وبدايته كما يفعل Firestore، والالتزام يكتب ts بوقته */
function fakeFirestore(nowMs: () => number) {
  const st: Row[] = [];
  const queries: Array<Record<string, any>> = [];
  const ok = (v: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(v), json: async () => v });
  const upsert = (name: string, ts: string, fields: Record<string, unknown>) => {
    const i = st.findIndex((r) => r.name === name);
    if (i >= 0) st.splice(i, 1);
    st.push({ name, ts, fields });
  };
  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method || init.method === 'GET') return ok({});
    const body = JSON.parse(init.body ?? '{}');
    if (url.endsWith(':commit')) {
      for (const w of body.writes ?? []) if (w.update && /\/st\//.test(w.update.name)) upsert(w.update.name, iso(nowMs()), w.update.fields);
      return ok({ commitTime: iso(nowMs()) });
    }
    if (url.endsWith(':runQuery')) {
      const q = body.structuredQuery;
      if (q.from[0].collectionId !== 'st') return ok([{ readTime: iso(nowMs()) }]);
      queries.push(q);
      let list = [...st].sort((a, b) => {
        const x = normTs(a.ts); const y = normTs(b.ts);
        return x === y ? (a.name < b.name ? -1 : 1) : x < y ? -1 : 1;
      });
      if (q.where) list = list.filter((r) => normTs(r.ts) >= normTs(q.where.fieldFilter.value.timestampValue));
      if (q.startAt) {
        const [tsV, refV] = q.startAt.values as Array<{ timestampValue?: string; referenceValue?: string }>;
        const at = normTs(tsV.timestampValue);
        list = list.filter((r) => {
          const t = normTs(r.ts);
          if (!refV) return q.startAt.before ? t >= at : t > at;
          if (t !== at) return t > at;
          return q.startAt.before ? r.name >= refV.referenceValue! : r.name > refV.referenceValue!;
        });
      }
      list = list.slice(0, q.limit);
      return ok(list.length ? list.map((r) => ({ document: { name: r.name, fields: { ...r.fields, ts: { timestampValue: r.ts } } } })) : [{ readTime: iso(nowMs()) }]);
    }
    return ok({});
  }) as unknown as typeof fetch;
  const remote = (uid: string) => new ChatRemote({ projectId: 'demo-p', org: 'ORG', uid, idToken: async () => 'T', baseUrl: 'http://x', fetchImpl });
  const docName = (sid: string) => `${ROOT}/orgs/ORG/chats/${G}/st/${sid}`;
  const add = (sid: string, tsMs: number, fields: Record<string, unknown>) => upsert(docName(sid), iso(tsMs), encodeFields(fields) as Record<string, unknown>);
  return { remote, add, docName, queries };
}

const B: ChatMe = { org: 'ORG', uid: 'u-b', email: 'u-b@example.test', name: 'عضو مصطنع', owner: false };
const pad = (i: number) => String(i).padStart(3, '0');

function deviceB() {
  const db = memDb();
  applyRemoteThread(db, { id: G, k: 'group', p: ['u-a', 'u-b'], name: 'مجموعة مصطنعة', by: 'u-a', at: iso(T0 - 3_600_000) });
  return db;
}
const stateCount = (db: ReturnType<typeof memDb>) =>
  Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM chat_state WHERE thread_id = ?`, [G])!.n);

test('٢ (المراجعة الأخيرة) ٤٠٠ تأكيد اطلاع في أربعين ثانية لا توقف مؤشر الحال: تُسحب كلها وما جاء بعدها', async () => {
  let now = T0 + 3_600_000;
  const f = fakeFirestore(() => now);
  const db = deviceB();
  for (let i = 0; i < 400; i++) f.add(`a_M1_u${pad(i)}`, T0 + i * 100, { k: 'ack', m: 'M1', by: 'u' + pad(i) });
  for (let i = 0; i < 6; i++) { now += 31_000; await chatSyncOnce(db, f.remote(B.uid), B, { threadId: G, now }); }
  expect(stateCount(db)).toBe(400);
  expect(stateCursor(db, G)).toBe(normTs(iso(T0 + 39_900)));
  // وما كُتب بعدها (تثبيتٌ وتأكيدٌ آخر) يصل
  f.add('p_M2', T0 + 45_000, { k: 'pin', on: true, by: 'u-a' });
  f.add('a_M2_u-a', T0 + 46_000, { k: 'ack', m: 'M2', by: 'u-a' });
  now += 31_000;
  await chatSyncOnce(db, f.remote(B.uid), B, { threadId: G, now });
  expect(pinnedIds(db, G)).toEqual(['M2']);
  expect(acksOf(db, G).M2).toEqual(['u-a']);
  db.close();
});

test('٢ (المراجعة الأخيرة) الصفحة التالية تبدأ بعد (وقت، اسم) آخر الصفحة لا عند وقته · والوقت بأجزاء المليار التسعة', async () => {
  let now = T0 + 3_600_000;
  const f = fakeFirestore(() => now);
  const db = deviceB();
  // ٣٠٠ بوقتٍ واحد ثم واحدٌ بعدها: صفحةٌ كاملة بوقتٍ واحد لا توقف السحب
  for (let i = 0; i < 300; i++) f.add(`a_M1_u${pad(i)}`, T0 + 1_000, { k: 'ack', m: 'M1', by: 'u' + pad(i) });
  f.add('p_M1', T0 + 2_000, { k: 'pin', on: true, by: 'u-a' });
  now += 31_000;
  await chatSyncOnce(db, f.remote(B.uid), B, { threadId: G, now });
  expect(stateCount(db)).toBe(301);
  const second = f.queries[1];
  expect(second.orderBy.map((o: { field: { fieldPath: string } }) => o.field.fieldPath)).toEqual(['ts', '__name__']);
  expect(second.startAt).toEqual({ values: [{ timestampValue: '2026-01-01T00:00:01.000000000Z' }, { referenceValue: f.docName('a_M1_u299') }], before: false });
  db.close();
});

test('٢ (المراجعة الأخيرة) نافذة الرجوع باقية: حالٌ تأخر التزامه عن وقته داخل النافذة يُسحب في الدورة التالية', async () => {
  let now = T0 + 3_600_000;
  const f = fakeFirestore(() => now);
  const db = deviceB();
  for (let i = 0; i < 400; i++) f.add(`a_M1_u${pad(i)}`, T0 + i * 100, { k: 'ack', m: 'M1', by: 'u' + pad(i) });
  now += 31_000;
  await chatSyncOnce(db, f.remote(B.uid), B, { threadId: G, now });
  // تثبيتٌ طُلب قبل آخر ما سُحب بعشرين ثانية ولم يلتزم إلا الآن
  f.add('p_M9', T0 + 19_900, { k: 'pin', on: true, by: 'u-a' });
  now += 31_000;
  await chatSyncOnce(db, f.remote(B.uid), B, { threadId: G, now });
  expect(pinnedIds(db, G)).toEqual(['M9']);
  // والاستعلام الأول في الدورة من المؤشر ناقص الستين ثانية بصيغته التسعية
  const first = f.queries.find((q, i) => i > 0 && !q.startAt)!;
  expect(first.where.fieldFilter.value.timestampValue).toBe('2025-12-31T23:59:39.900000000Z');
  db.close();
});

test('٢ (المراجعة الأخيرة) بعد تأكيدي الاطلاع تظهر الحال كما في الخادم ولو سبقها أكثر من ٣٠٠ عنصر لم يُسحب', async () => {
  let now = T0 + 3_600_000;
  const f = fakeFirestore(() => now);
  const db = deviceB();
  now += 31_000;
  await chatSyncOnce(db, f.remote(B.uid), B, { threadId: G, now });
  for (let i = 0; i < 350; i++) f.add(`a_M1_u${pad(i)}`, now + i * 10, { k: 'ack', m: 'M1', by: 'u' + pad(i) });
  now += 10_000;
  const s: ChatSession = { projectId: 'demo-p', uid: B.uid, email: B.email, idToken: async () => 'T' };
  await chatAcknowledge(db, s, 'ORG', G, 'M1', f.remote(B.uid));
  expect(acksOf(db, G).M1).toContain('u-b');
  expect(stateCount(db)).toBe(351);
  db.close();
});
