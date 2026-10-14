/**
 * المراجعة الخارجية ٧ · النتيجة ٢ (قرار المالك «رابعاً ٢» 2026-10-10: «ولا يُسلسل جهاز المالك شاهد حذفٍ لم يكتبه المالك»):
 * شاهد حذف عقارٍ من عضوٍ كان يُسلسله جهاز المالك فيفكّ العقد عن وحدته ويحذف ما تحته ويعيد نشر ذلك للمنشأة كلها ·
 * الآن: حذفٌ له أبناء يُسلسل من المالك وحده (حاذفه dby، والقواعد تشترطه لحذف العضو) · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { enableSync, syncOnce, docId, buildDoc } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

const OWN = 'owner-1';
const AT = '2099-01-01T00:00:00.000Z';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const reasonOf = (db: DB, pk: string) => db.get<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE pk = ? ORDER BY id DESC`, [pk])?.reason ?? '';
const tomb = (t: string, k: string, dby?: string): RemoteDoc =>
  ({ id: docId(t, k), t, k, u: AT, dev: 'other', del: true, d: null, ...(dby ? { dby } : {}) });

async function world() {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, OWN);
  const p = addProperty(a, { name: 'عقار مصطنع' });
  const u = addUnit(a, p, { unit_no: 'A-1' });
  const cid = confirmContract(a, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '1000000055', phone: '0500000055' }));
  const p2 = addProperty(a, { name: 'عقار ثانٍ مصطنع' });
  addUnit(a, p2, { unit_no: 'B-1' });
  await sync(a, r);
  return { r, a, p, u, cid, p2 };
}

test('٢ شاهد حذف عقارٍ من عضو لا يُسلسل على جهاز المالك: العقد على وحدته ولا يُرفع شيء · ويُسجَّل الرفض', async () => {
  const { r, a, p, u, cid } = await world();
  const writes = r.writes;
  r.inject(tomb('properties', p, 'member-1'));
  await sync(a, r);
  expect(a.get(`SELECT 1 FROM properties WHERE id = ?`, [p])).toBeTruthy();
  expect(a.get<{ u: string }>(`SELECT unit_id AS u FROM contracts WHERE id = ?`, [cid])!.u).toBe(u);
  expect(reasonOf(a, p)).toMatch(/المالك/);
  expect(r.writes).toBe(writes);
  a.close();
});

test('٢ وشاهدٌ بلا حاذف لا يُسلسل', async () => {
  const { r, a, p } = await world();
  r.inject(tomb('properties', p));
  await sync(a, r);
  expect(a.get(`SELECT 1 FROM properties WHERE id = ?`, [p])).toBeTruthy();
  expect(reasonOf(a, p)).toMatch(/المالك/);
  a.close();
});

test('وحذف المالك نفسه (من جهازه الآخر) يُسلسل كما كان', async () => {
  const { r, a, p2 } = await world();
  r.inject(tomb('properties', p2, OWN));
  await sync(a, r);
  expect(a.get(`SELECT 1 FROM properties WHERE id = ?`, [p2])).toBeFalsy();
  expect(a.get(`SELECT 1 FROM units WHERE property_id = ?`, [p2])).toBeFalsy();
  a.close();
});

test('وشاهد الحذف المرفوع بحاذفه', () => {
  const db = memDb();
  enableSync(db, OWN);
  expect(buildDoc(db, 'meters', 'NOPE', 'delete', AT, 'dev')).toMatchObject({ del: true, dby: OWN });
  db.close();
});

test('٢ (الجولة العشرون) الكنس الدوري للسلة على جهاز المالك وحده: جهاز العضو لا يحذف نهائياً فلا يُرسل حذف أبناء ما في سلة المالك', async () => {
  const { purgeExpiredTrash, trashItems } = await import('@/domain/trash');
  for (const member of [true, false]) {
    const db = memDb();
    const p = addProperty(db, { name: 'عقار مصطنع' });
    const u = addUnit(db, p, { unit_no: 'T-1' });
    db.run(`UPDATE units SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, [u]);
    if (member) db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', '{"org":"OWN"}')`);
    expect(trashItems(db).length).toBeGreaterThan(0);
    const n = await purgeExpiredTrash(db);
    expect(n === 0).toBe(member);
    expect(!!db.get(`SELECT 1 FROM units WHERE id = ?`, [u])).toBe(member);
    db.close();
  }
});
