/**
 * الاستعادة مع المزامنة: قراءة ما في السحابة لا تكتب شيئاً، والاعتماد يجعل السحابة مطابقة للنسخة
 * المستعادة (ما تغيّر بعدها يُستبدل، وما أُضيف بعدها يُحذف بشاهد حذف)، وجهازٌ ينضمّ بعدها يصله
 * ما في النسخة لا ما قبلها · والقيد المرحّل لا يُحذف: يُضمّ إلى القاعدة قبل الاعتماد (keepPosted.ts).
 */
import * as path from 'node:path';
import { memDb, tempDir, rmrf } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { MemoryRemote } from './helpers/memoryRemote';
import { confirmContract } from '@/domain/contracts/service';
import { postEntry } from '@/domain/accounting/post';
import { enableSync, syncOnce, outboxCount, planCloudReplace, adoptAsCloudTruth, CloudReplaceBlockedError, readCloud, planFromSnapshot } from '@/sync/engine';
import { planKeepPosted, applyKeepPosted } from '@/domain/backup/keepPosted';
import { logAudit } from '@/domain/audit';
import { openNodeDb } from '@/db/nodeAdapter';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'user-1';
const dev = (db: DB) => getMeta(db, 'device_id')!;
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, dev(db));

/** ما يقارَن بين الأجهزة · الصفوف التي يحملها المستخدم */
function rows(db: DB) {
  return {
    properties: db.all(`SELECT id, name FROM properties ORDER BY id`),
    tenants: db.all(`SELECT id, name, phone FROM tenants ORDER BY id`),
    contracts: db.all(`SELECT id, tenant_name, value_halalas, status FROM contracts ORDER BY id`),
    inst: db.all(`SELECT id, amount_halalas, paid_halalas FROM contract_installments ORDER BY id`),
  };
}

let dir: string;
beforeEach(() => { dir = tempDir('aqari-rsync-'); });
afterEach(() => rmrf(dir));

test('قراءة السحابة قبل الاعتماد لا تكتب شيئاً · والاعتماد يستبدل ما في السحابة بالنسخة', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  const b = memDb(); // جهاز ثانٍ على الحساب نفسه
  enableSync(a, UID);
  enableSync(b, UID);
  const p = addProperty(a, { name: 'قبل النسخة' });
  const u = addUnit(a, p, { unit_no: '1', rent: 100000 });
  confirmContract(a, contractInput(u, { tenant: 'مستأجر النسخة', phone: '0511111111', valueHalalas: 1200000, depositHalalas: 0 }));
  await sync(a, r);

  // النسخة الاحتياطية في هذه اللحظة
  const backupFile = path.join(dir, 'backup.db').replace(/\\/g, '/');
  a.exec(`VACUUM INTO '${backupFile}'`);
  const atBackup = rows(a);

  // بعد النسخة: تعديل وإضافة وسطر في سجل العمليات · كلها تُرفع
  a.run(`UPDATE tenants SET phone = '0599999999'`);
  addProperty(a, { name: 'بعد النسخة' });
  logAudit(a, 'اختبار', 'update', 'بعد النسخة', 'سطر سجل');
  await sync(a, r);
  await sync(b, r);
  expect(outboxCount(a)).toBe(0);
  expect(rows(b).tenants[0]).toMatchObject({ phone: '0599999999' });

  // الاستعادة على الجهاز الأول نفسه: قاعدته تُستبدل بالنسخة وتبقى هويته · والمزامنة متوقفة
  a.close();
  const restored = openNodeDb(backupFile);
  const writesBefore = r.writes;
  const plan = await planCloudReplace(restored, r);
  expect(r.writes).toBe(writesBefore); // القراءة لا تكتب
  expect(plan.tombstones.map((x) => x.t)).toContain('properties');
  expect(plan.immutable.entries).toBe(0);
  expect(plan.absorb.length).toBeGreaterThan(0); // سطر السجل يُضمّ ولا يُحذف

  adoptAsCloudTruth(restored, UID, plan);
  await sync(restored, r);
  expect(outboxCount(restored)).toBe(0);
  expect(rows(restored)).toEqual(atBackup); // لم يُسحب فوقها ما كان بعد النسخة

  // جهاز جديد ينضم: يصله ما في النسخة
  const c = memDb();
  enableSync(c, UID);
  await sync(c, r);
  expect(rows(c)).toEqual(atBackup);

  // والجهاز الثاني يتبع السحابة في دورته التالية · فيطابق النسخة
  await sync(b, r);
  expect(rows(b)).toEqual(atBackup);
  b.close(); c.close(); restored.close();
});

test('قيد مرحّل في السحابة بعد النسخة: الاعتماد بلا ضمّه يُمنع (حزام) بلا كتابة · وبعد ضمّه يمضي ولا يُحذف القيد', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  addProperty(a, { name: 'قبل النسخة' });
  await sync(a, r);
  const backupFile = path.join(dir, 'old.db').replace(/\\/g, '/');
  a.exec(`VACUUM INTO '${backupFile}'`);
  postEntry(a, { date: '2026-02-01', memo: 'بعد النسخة', lines: [{ account: '1100', debit: 5000, credit: 0 }, { account: '4200', debit: 0, credit: 5000 }] });
  await sync(a, r);
  a.close();

  const restored = openNodeDb(backupFile);
  const plan = await planCloudReplace(restored, r);
  expect(plan.immutable.entries).toBe(1);
  const before = outboxCount(restored);
  const writes = r.writes;
  expect(() => adoptAsCloudTruth(restored, UID, plan)).toThrow(CloudReplaceBlockedError);
  expect(() => adoptAsCloudTruth(restored, UID, plan)).toThrow(/قيد مرحّل ليس في بيانات هذا الجهاز/);
  expect(outboxCount(restored)).toBe(before);
  expect(r.writes).toBe(writes);
  // الضمّ (keepPosted.ts) ثم الاعتماد
  const snap = await readCloud(r);
  const keep = planKeepPosted(restored, { cloud: snap.docs });
  expect(keep.entries.map((e) => e.memo)).toEqual(['بعد النسخة']);
  applyKeepPosted(restored, keep);
  const plan2 = planFromSnapshot(restored, snap);
  expect(plan2.immutable.entries).toBe(0);
  adoptAsCloudTruth(restored, UID, plan2);
  await sync(restored, r);
  expect(restored.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE memo = 'بعد النسخة'`)!.n).toBe(1);
  restored.close();
});

test('نسخة من حساب لم يُزامَن بعد · الاعتماد يرفع كل صف بلا انضمام يغلب فيه ما في السحابة', async () => {
  const r = new MemoryRemote();
  // جهاز آخر كتب في الحساب قبل الاستعادة
  const other = memDb();
  enableSync(other, UID);
  addProperty(other, { name: 'من جهاز آخر' });
  await sync(other, r);

  const local = memDb();
  const p = addProperty(local, { name: 'من النسخة' });
  addUnit(local, p, { unit_no: '7' });
  const plan = await planCloudReplace(local, r);
  expect(plan.tombstones.filter((x) => x.t === 'properties')).toHaveLength(1);
  adoptAsCloudTruth(local, UID, plan);
  await sync(local, r);
  await sync(other, r);
  expect(rows(other)).toEqual(rows(local));
  local.close(); other.close();
});
