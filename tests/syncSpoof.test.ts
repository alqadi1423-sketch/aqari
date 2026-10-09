/**
 * مراجعة التثبيت #56: «dev» و«u» يكتبهما العضو · فينتحل جهاز المالك فيُتجاهل مستنده صدىً، أو يقدّم وقته فيغلب كل تعارض ·
 * الصدى يُطابَق محتواه قبل إهماله، والوقت الوارد لا يتجاوز وقت كتابته في الخادم · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty } from './helpers/fixtures';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce, docId } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const dev = (db: DB) => getMeta(db, 'device_id')!;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('مستندٌ بمعرّف هذا الجهاز ومحتوى آخر لا يُهمل صدىً', async () => {
  const db = memDb();
  const r = new MemoryRemote();
  enableSync(db, 'user-1');
  addProperty(db, { id: 'PX', name: 'عقار صدى مصطنع' });
  await syncOnce(db, r, dev(db));
  const cur = r.docs.get(docId('properties', 'PX'))!;
  await r.write([{ ...cur, d: { ...cur.d, name: 'اسم منتحل مصطنع' }, u: new Date().toISOString(), dev: dev(db) }]);
  await syncOnce(db, r, dev(db));
  expect(db.get(`SELECT name FROM properties WHERE id = 'PX'`)).toEqual({ name: 'اسم منتحل مصطنع' });
  db.close();
});

test('وقتٌ وارد مقدَّمٌ إلى المستقبل لا يغلب تعديلاً محلياً أحدث من كتابته', async () => {
  const db = memDb();
  const r = new MemoryRemote();
  enableSync(db, 'user-1');
  addProperty(db, { id: 'PY', name: 'عقار تعارض مصطنع' });
  await syncOnce(db, r, dev(db));
  const cur = r.docs.get(docId('properties', 'PY'))!;
  await r.write([{ ...cur, d: { ...cur.d, name: 'اسم بوقت مزوَّر' }, u: '2999-01-01T00:00:00.000Z', dev: 'OTHER-DEVICE' }]);
  await pause(1100);
  db.run(`UPDATE properties SET name = 'اسم محلي أحدث' WHERE id = 'PY'`);
  await syncOnce(db, r, dev(db));
  expect(db.get(`SELECT name FROM properties WHERE id = 'PY'`)).toEqual({ name: 'اسم محلي أحدث' });
  db.close();
});
