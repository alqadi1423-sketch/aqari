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
