/**
 * أول مزامنة كبيرة: آلاف الصفوف على دفعات بتقدّم ظاهر، وانتظار يتضاعف عند رفض الحصة مع تصغير
 * الدفعة، وتأجيلٌ بعد رفض طويل ثم استئناف، واستئناف بعد انقطاع في المنتصف · ولا ضياع ولا تكرار:
 * كل صف في السحابة مرة واحدة بمضمونه، والطابور فارغ في النهاية.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit } from './helpers/fixtures';
import { MemoryRemote } from './helpers/memoryRemote';
import {
  enableSync, syncOnce, outboxCount, syncBackoffUntil, setSyncState, SyncBusyError, isTransientRemoteError, docId,
} from '@/sync/engine';
import { SYNC_TABLES } from '@/db/syncTables';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';
import type { RemoteDoc, WriteResult } from '@/sync/types';

const UID = 'user-1';
const noWait = async () => {};

/** سحابة ترفض بالحصة (429) حين يُطلب منها ذلك · وتنقطع حين يُطلب · كما يفعل الخادم */
class FlakyRemote extends MemoryRemote {
  /** عدد الرفضات القادمة بالحصة */
  quotaFails = 0;
  /** أكبر دفعة يقبلها قبل أن يرفض بالحصة */
  maxBatch = Infinity;
  /** ينقطع بعد هذا العدد من الكتابات الناجحة */
  dropAfterWrites = Infinity;
  batches: number[] = [];
  async write(docs: RemoteDoc[]): Promise<WriteResult[]> {
    this.batches.push(docs.length);
    if (this.quotaFails > 0 || docs.length > this.maxBatch) {
      if (this.quotaFails > 0) this.quotaFails--;
      throw Object.assign(new Error('Firestore 429: RESOURCE_EXHAUSTED'), { status: 429 });
    }
    if (this.writes >= this.dropAfterWrites) throw new Error('Network request failed');
    return super.write(docs);
  }
}

/** بيانات كبيرة · عقار بألفي وحدة ومستأجرون */
function big(db: DB, units = 2000): number {
  const p = addProperty(db, { name: 'برج كبير' });
  db.transaction(() => {
    for (let i = 0; i < units; i++) addUnit(db, p, { unit_no: 'U-' + i, rent: 100000 + i });
    for (let i = 0; i < 500; i++) {
      db.run(`INSERT INTO tenants (id, name, phone, created_at) VALUES (?,?,?,?)`, ['T' + i, 'مستأجر ' + i, '05' + String(i).padStart(8, '0'), 'x']);
    }
  });
  return SYNC_TABLES.reduce((s, t) => s + Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t.name}"`)!.n), 0);
}

/** كل صف محلي في السحابة مرة واحدة بمضمونه · لا ناقص ولا زائد */
function cloudMatches(db: DB, r: MemoryRemote): void {
  const units = db.all<{ id: string; unit_no: string; rent_monthly_halalas: number }>(`SELECT id, unit_no, rent_monthly_halalas FROM units`);
  for (const u of units) {
    const d = r.docs.get(docId('units', u.id));
    expect(d?.d?.unit_no).toBe(u.unit_no);
    expect(d?.d?.rent_monthly_halalas).toBe(u.rent_monthly_halalas);
  }
  const live = [...r.docs.values()].filter((d) => !d.del);
  const local = SYNC_TABLES.reduce((s, t) => s + Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t.name}"`)!.n), 0);
  expect(live.length).toBe(local);
  expect(new Set(live.map((d) => d.id)).size).toBe(live.length);
}

test('الخطأ العابر يُعرف من الحالة أو الرمز · والانقطاع ليس منه', () => {
  expect(isTransientRemoteError(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
  expect(isTransientRemoteError(Object.assign(new Error('x'), { status: 503 }))).toBe(true);
  expect(isTransientRemoteError(new Error('RESOURCE_EXHAUSTED: Quota exceeded'))).toBe(true);
  expect(isTransientRemoteError(Object.assign(new Error('x'), { status: 403 }))).toBe(false);
  expect(isTransientRemoteError(new Error('Network request failed'))).toBe(false);
});

test('آلاف الصفوف على دفعات بتقدّم «ن من م» · والحصة تُنتظر وتصغّر الدفعة', async () => {
  const db = memDb();
  const rows = big(db);
  expect(rows).toBeGreaterThan(2500);
  enableSync(db, UID);
  const r = new FlakyRemote();
  r.quotaFails = 3;
  r.maxBatch = 120; // الخادم لا يقبل دفعة أكبر حتى تصغر
  const progress: string[] = [];
  const waits: number[] = [];
  const rep = await syncOnce(db, r, getMeta(db, 'device_id')!, (m) => progress.push(m),
    { sleep: async (ms) => { waits.push(ms); }, baseDelayMs: 1000 });
  expect(rep.pending).toBe(0);
  expect(outboxCount(db)).toBe(0);
  // مهلة تتضاعف · والدفعة صغرت حتى قُبلت
  expect(waits.slice(0, 3)).toEqual([1000, 2000, 4000]);
  expect(Math.max(...r.batches.slice(-5))).toBeLessThanOrEqual(120);
  expect(progress.some((m) => /جاري رفع التغييرات · \d+ من \d+/.test(m))).toBe(true);
  expect(progress.some((m) => m.startsWith('السحابة مشغولة'))).toBe(true);
  cloudMatches(db, r);
  db.close();
});

test('رفضٌ طويل يؤجّل المزامنة بسبب عربي · ثم تُستأنف من حيث وقفت بلا تكرار', async () => {
  const db = memDb();
  big(db, 1200);
  enableSync(db, UID);
  const r = new FlakyRemote();
  const dev = getMeta(db, 'device_id')!;
  // يقبل ثلاث دفعات ثم يرفض بالحصة رفضاً طويلاً
  r.dropAfterWrites = Infinity;
  let calls = 0;
  const orig = r.write.bind(r);
  r.write = async (docs) => { calls++; if (calls > 3) r.quotaFails = 1; return orig(docs); };
  const err = await syncOnce(db, r, dev, undefined, { sleep: noWait, maxRetries: 2 }).catch((e) => e);
  expect(err).toBeInstanceOf(SyncBusyError);
  expect(err.message).toMatch(/رُفع \d+ من \d+ والباقي محفوظ في الطابور/);
  expect(syncBackoffUntil(db)).not.toBeNull();
  const left = outboxCount(db);
  expect(left).toBeGreaterThan(0);
  const writesSoFar = r.writes;

  // انقضت المهلة · الاستئناف يرفع الباقي وحده
  setSyncState(db, 'backoff_until', null);
  r.write = orig;
  r.quotaFails = 0;
  await syncOnce(db, r, dev, undefined, { sleep: noWait });
  expect(outboxCount(db)).toBe(0);
  expect(r.writes - writesSoFar).toBe(left);
  expect(syncBackoffUntil(db)).toBeNull();
  cloudMatches(db, r);
  db.close();
});

test('انقطاع في منتصف الرفع · الطابور محفوظ ويُكمل عند العودة بلا ضياع ولا تكرار', async () => {
  const db = memDb();
  big(db, 1500);
  enableSync(db, UID);
  const r = new FlakyRemote();
  const dev = getMeta(db, 'device_id')!;
  r.dropAfterWrites = 800;
  await expect(syncOnce(db, r, dev, undefined, { sleep: noWait })).rejects.toThrow('Network request failed');
  expect(r.writes).toBe(800); // دفعتان كاملتان قبل الانقطاع
  expect(outboxCount(db)).toBeGreaterThan(0);
  r.dropAfterWrites = Infinity;
  // جهاز يعدّل صفاً رُفع قبل الانقطاع · يُرفع بقيمته الجديدة
  db.run(`UPDATE units SET rent_monthly_halalas = 7 WHERE unit_no = 'U-0'`);
  await syncOnce(db, r, dev, undefined, { sleep: noWait });
  expect(outboxCount(db)).toBe(0);
  cloudMatches(db, r);
  db.close();
});
