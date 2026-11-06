/**
 * المراجعة الشاملة (الالتزام ac76adc) · البنود ١٣ و١٤ و١٥ و١٦ في محرّك المزامنة · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce, docId, applyInbox, stageInbox } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

const UID = 'user-1';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const tenant = (db: DB, id: string, phone: string) =>
  db.run(`INSERT INTO tenants (id, name, phone, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')`, [id, 'مستأجر مصطنع ' + id, phone]);
const phoneOf = (db: DB, id: string) => db.get<{ p: string }>(`SELECT phone AS p FROM tenants WHERE id = ?`, [id])?.p;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** سحابة يُقطع فيها الرفع وحده (السحب يعمل) */
class PushCut extends MemoryRemote {
  cut = false;
  async write(docs: RemoteDoc[]) {
    if (this.cut) throw new Error('Network request failed');
    return super.write(docs);
  }
}
const once = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!, undefined, { maxRetries: 0, sleep: async () => undefined })
  .catch(() => undefined);

test('١٣ إعادة تأكيد النسخة المحلية أمام واردٍ أقدم تُرفع بوقتها المعروف لا بوقت الآن: فلا تغلب تعديلاً أحدث من جهاز آخر', async () => {
  const r = new PushCut();
  const a = memDb(); const b = memDb();
  enableSync(a, UID); enableSync(b, UID);
  tenant(a, 'T1', '0500000001');
  await sync(a, r); await sync(b, r);
  await wait(5);
  // ب يعدّل التعديل الأحدث ولم يرفعه بعد
  b.run(`UPDATE tenants SET phone = '0500000002' WHERE id = 'T1'`);
  await wait(5);
  // جهازٌ ساعته متأخرة كتب نسخةً قديمة (وقتها المعلن قبل ما عرفه أ)
  r.inject({ id: docId('tenants', 'T1'), t: 'tenants', k: 'T1', u: '2020-01-01T00:00:00.000Z', dev: 'slow-device', del: false,
    d: { id: 'T1', name: 'مستأجر مصطنع T1', vat: '', phone: '0500000009', credit_halalas: 0, archived: 0, created_at: '2026-01-01T00:00:00.000Z', deleted_at: null } });
  await wait(5);
  // أ يسحب القديم فيعيد تأكيد نسخته · ورفعه مقطوع
  r.cut = true;
  await once(a, r);
  r.cut = false;
  // ب يرفع تعديله الأحدث · ثم يسحبه أ: إعادة التأكيد لا تغلبه
  await sync(b, r);
  await sync(a, r);
  expect(phoneOf(a, 'T1')).toBe('0500000002');
  await sync(b, r);
  expect(phoneOf(b, 'T1')).toBe('0500000002');
  expect((r.docs.get(docId('tenants', 'T1'))!.d as Record<string, unknown>).phone).toBe('0500000002');
  a.close(); b.close();
});
const unitDoc = (id: string, prop: string): RemoteDoc => ({ id: docId('units', id), t: 'units', k: id, u: '2026-02-01T00:00:00.000Z',
  ts: '2026-02-01T00:00:00.000Z', dev: 'other', del: false, d: { id, property_id: prop, unit_no: 'U-' + id, created_at: '2026-02-01T00:00:00.000Z', deleted_at: null } });
const propDoc = (id: string): RemoteDoc => ({ id: docId('properties', id), t: 'properties', k: id, u: '2026-02-02T00:00:00.000Z',
  ts: '2026-02-02T00:00:00.000Z', dev: 'other', del: false, d: { id, name: 'عقار مصطنع ' + id, created_at: '2026-02-02T00:00:00.000Z', deleted_at: null } });
const rejects = (db: DB, pk: string) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE pk = ?`, [pk])!.n);

test('١٤ أبٌ غائب مؤقتاً لا يصير رفضاً نهائياً بعد دورات قليلة: الابن ينتظر ويُطبَّق حين يصل أبوه', () => {
  const db = memDb();
  enableSync(db, UID);
  stageInbox(db, [unitDoc('UW1', 'P-LATE1')]);
  for (let i = 0; i < 30; i++) applyInbox(db, 'this-device');
  expect(rejects(db, 'UW1')).toBe(0);
  expect(db.get(`SELECT 1 FROM sync_inbox WHERE pk = 'UW1'`)).toBeTruthy();
  stageInbox(db, [propDoc('P-LATE1')]);
  applyInbox(db, 'this-device');
  expect(db.get(`SELECT property_id AS p FROM units WHERE id = 'UW1'`)).toEqual({ p: 'P-LATE1' });
  db.close();
});

test('١٤ وما رُفض لانتظار أبيه (من إصدارٍ سابق) يعود إلى الوارد حين يصل أبوه ويُطبَّق', () => {
  const db = memDb();
  enableSync(db, UID);
  const doc = unitDoc('UW2', 'P-LATE2');
  db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`,
    [doc.id, 'units', 'UW2', 'سجل أب غير موجود بعد محاولات متكررة', JSON.stringify(doc), '2026-02-03T00:00:00.000Z']);
  stageInbox(db, [propDoc('P-LATE2')]);
  applyInbox(db, 'this-device');
  expect(db.get(`SELECT property_id AS p FROM units WHERE id = 'UW2'`)).toEqual({ p: 'P-LATE2' });
  expect(rejects(db, 'UW2')).toBe(0);
  db.close();
});

test('١٤ وما طال انتظاره (أكثر من مهلة الانتظار) يُرفض كما كان فلا يبقى الوارد معلّقاً أبداً', () => {
  const db = memDb();
  enableSync(db, UID);
  stageInbox(db, [unitDoc('UW3', 'P-NEVER')]);
  applyInbox(db, 'this-device');
  db.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50 WHERE pk = 'UW3'`);
  applyInbox(db, 'this-device');
  expect(rejects(db, 'UW3')).toBe(1);
  expect(db.get(`SELECT 1 FROM sync_inbox WHERE pk = 'UW3'`)).toBeFalsy();
  db.close();
});

