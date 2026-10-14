/**
 * المراجعة الخارجية ٧ · النتيجتان ٨ و٩ · بيانات مصطنعة.
 * ٨: وارد أقدم يكتب فوق تعديل أحدث حين لا طابور · قائمة القبول: «PROBE2a ينتهي بـ0522222222 على الجهازين».
 * ٩ (قرار المالك «رابعاً ٦»: «تُزال «أبقِ بياناتي» للأعضاء») · قائمة القبول: «جهاز عضو عليه بيانات، عهد مرفوع، يختار «أبقِ»
 *   فيبقى outboxCount == 0 والسحابة فارغة».
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { enableSync, syncOnce, docId, outboxCount } from '@/sync/engine';
import { resolveEpoch } from '@/services/org';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

jest.mock('@/services/cloud', () => ({}));

const UID = 'owner-8';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const phone = (db: DB, id: string) => db.get<{ p: string }>(`SELECT phone AS p FROM tenants WHERE id = ?`, [id])!.p;

test('٨ وارد أقدم (دورة جهازٍ سحبت قبل التعديل ودفعت بعده) لا يكتب فوق تعديلٍ أحدث بلا طابور · والجهازان على الأحدث', async () => {
  const r = new MemoryRemote();
  const a = memDb(); const b = memDb();
  enableSync(a, UID); enableSync(b, UID);
  confirmContract(a, contractInput(addUnit(a, addProperty(a, { name: 'عقار مصطنع' })), { tenant: 'مستأجر مصطنع', idNumber: '1000000801', phone: '0500000801' }));
  await sync(a, r); await sync(b, r);
  const tid = a.get<{ id: string }>(`SELECT id FROM tenants LIMIT 1`)!.id;
  // تعديل ب أولاً (أقدم) · ثم أ (أحدث) ويُرفع
  b.run(`UPDATE tenants SET phone = '0511111111' WHERE id = ?`, [tid]);
  const older = '2026-01-01T00:00:00.000Z';
  b.run(`UPDATE sync_outbox SET changed_at = ? WHERE tbl = 'tenants' AND pk = ?`, [older, tid]);
  a.run(`UPDATE tenants SET phone = '0522222222' WHERE id = ?`, [tid]);
  await sync(a, r);
  // دورة ب سحبت قبل التزام أ ودفعت بعده: نسخته الأقدم تصل السحابة بعد نسخة أ
  const bDoc = r.docs.get(docId('tenants', tid))!;
  r.inject({ ...bDoc, d: { ...bDoc.d!, phone: '0511111111' }, u: older, dev: getMeta(b, 'device_id')! });
  b.run(`DELETE FROM sync_outbox WHERE tbl = 'tenants' AND pk = ?`, [tid]);
  // كما يحفظه ب بعد دفعه (الهجرة ٤٣) · وقبلها لا جدول
  try { b.run(`INSERT OR REPLACE INTO sync_rowtime (tbl, pk, u) VALUES ('tenants', ?, ?)`, [tid, older]); } catch { /* قبل الهجرة ٤٣ */ }
  await sync(a, r); await sync(b, r); await sync(a, r); await sync(b, r);
  expect(phone(a, tid)).toBe('0522222222');
  expect(phone(b, tid)).toBe('0522222222');
  expect((r.docs.get(docId('tenants', tid))!.d as Record<string, unknown>).phone).toBe('0522222222');
  expect(Number(a.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'تعارض مزامنة'`)!.n)).toBeGreaterThan(0);
  a.close(); b.close();
});

test('٩ جهاز العضو لا يُبقي بياناته بعد مسح المالك: «أبقِ» يُرفض ولا يُرفع شيء · والمالك يُبقي', async () => {
  for (const member of [true, false]) {
    const db = memDb();
    addProperty(db, { name: 'عقار مصطنع' });
    enableSync(db, 'U');
    if (member) db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', '{"org":"OWN"}')`);
    db.run(`DELETE FROM sync_outbox`);
    db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('epoch_pending', '2')`);
    const run = resolveEpoch(db, 'keep', async () => undefined);
    if (member) {
      await expect(run).rejects.toThrow();
      expect(outboxCount(db)).toBe(0);
    } else {
      await run;
      expect(outboxCount(db)).toBeGreaterThan(0);
    }
    db.close();
  }
});
