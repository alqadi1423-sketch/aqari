/**
 * ثغرات الأعضاء على الجهاز (مراجعة التثبيت #17 و#20 و#21) · بيانات مصطنعة:
 *  #١٧ ما لا يقرؤه العضو (المبالغ في الإسقاط) لا يُرفع منه، بكتابة جزئية تُبقي قيمته في السحابة
 *  #٢٠ مستندٌ وارد مفتاحه داخله غير مفتاحه يُرفض ولا يستبدل صفاً آخر
 *  #٢١ صف ملفٍ وارد ببصمة أو امتداد يخرجان بالمسار عن المرفقات يُرفض · والتنظيف لا يحذف خارجها
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { memDb, tempDir, rmrf } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { MemoryRemote } from './helpers/memoryRemote';
import { makeBackupEnv } from './helpers/backupEnv';
import { confirmContract } from '@/domain/contracts/service';
import { enableSync, syncOnce } from '@/sync/engine';
import { FirestoreRemote } from '@/cloud/firestore';
import { hiddenColumns, memberTokens } from '@/sync/acl';
import { gcBlobs } from '@/files/store';
import { getMeta } from '@/repos/settings';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

const dev = (db: DB) => getMeta(db, 'device_id')!;
const member = (perms: Access['perms'], props: string[] | 'all'): Access =>
  ({ owner: false, uid: 'U-M', perms, allProps: props === 'all', props: props === 'all' ? [] : props });

test('#١٧ ما يقرؤه العضو إسقاطاً لا يُرفع منه: كتابة جزئية بالحقول التي يقرؤها', async () => {
  const db = memDb();
  addProperty(db, { id: 'P1', name: 'عقار مصطنع' });
  addUnit(db, 'P1', { id: 'UQ1', rent: 250000 });
  const tech = member({ props: 3 }, ['P1']);
  const unit = db.get<Record<string, unknown>>(`SELECT * FROM units WHERE id = 'UQ1'`)!;
  expect(hiddenColumns(tech, 'units', unit)).toEqual(Object.keys(unit).filter((k) => k.endsWith('_halalas')));
  // من يقرأ المبالغ، والمالك، ومن لا يقرأ الجدول أصلاً (صفوفه ما أنشأه): لا شيء مخفي
  expect(hiddenColumns(member({ props: 3, contracts: 1 }, ['P1']), 'units', unit)).toEqual([]);
  expect(hiddenColumns({ owner: true, uid: 'O', perms: {}, allProps: true, props: [] }, 'units', unit)).toEqual([]);
  // والمستأجر المشترك: المحصور بعقار لا يقرأ رصيده ولا ملاحظاته
  expect(hiddenColumns(member({ collect: 2 }, ['P1']), 'tenants', { id: 'T', name: 'x', credit_halalas: 0, notes: '' })).toEqual(['credit_halalas', 'notes']);

  const bodies: Array<{ writes: Array<{ update: { fields: Record<string, unknown> }; updateMask?: { fieldPaths: string[] } }> }> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '{}' };
  }) as unknown as typeof fetch;
  const r = new FirestoreRemote({ projectId: 'p', uid: 'U-M', org: 'ORG', idToken: async () => 't', fetchImpl,
    memberTokens: () => memberTokens(tech), fullReadTables: () => new Set(), access: () => tech });
  const doc = r.annotate!(db, { id: 'units__UQ1', t: 'units', k: 'UQ1', u: 'x', dev: 'd', del: false, d: { ...unit, rent_halalas: 0 } as never });
  await r.write([doc]);
  const w = bodies[0].writes[0];
  expect(w.updateMask).toBeTruthy();
  expect(w.updateMask!.fieldPaths).toContain('d.unit_no');
  expect(w.updateMask!.fieldPaths.some((p) => p.endsWith('_halalas'))).toBe(false);
  expect(JSON.stringify(w.update.fields)).not.toContain('rent_halalas');
  db.close();
});

test('#٢٠ مستندٌ وارد مفتاحه داخله غير مفتاحه يُرفض ولا يستبدل صفاً آخر', async () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'A-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر أصلي مصطنع', idNumber: '1000000074', phone: '0500000031' }));
  enableSync(db, 'U1');
  const remote = new MemoryRemote();
  await syncOnce(db, remote, dev(db));
  const row = db.get<Record<string, unknown>>(`SELECT * FROM contracts WHERE id = ?`, [cid])!;
  await remote.write([{ id: 'contracts__FORGED', t: 'contracts', k: 'FORGED', u: '2099-01-01T00:00:00.000Z', dev: 'other', del: false,
    d: { ...row, tenant_name: 'اسم مزوّر' } as never }]);
  await syncOnce(db, remote, dev(db));
  expect(db.get<{ n: string }>(`SELECT tenant_name AS n FROM contracts WHERE id = ?`, [cid])!.n).toBe('مستأجر أصلي مصطنع');
  expect(db.get(`SELECT 1 FROM contracts WHERE id = 'FORGED'`)).toBeUndefined();
  expect(db.get<{ r: string }>(`SELECT reason AS r FROM sync_rejects WHERE doc = 'contracts__FORGED'`)).toBeTruthy();
  db.close();
});

test('#٢١ صف ملفٍ وارد يخرج مساره عن المرفقات يُرفض · والتنظيف لا يحذف خارجها', async () => {
  const dir = tempDir('aqari-gap21-');
  try {
    const env = makeBackupEnv(dir);
    const victim = path.join(dir, 'victim.txt');
    fs.writeFileSync(victim, 'ملف خارج المرفقات');
    enableSync(env.db, 'U1');
    const remote = new MemoryRemote();
    await remote.write([{ id: 'blobs__../victim', t: 'blobs', k: '../victim', u: '2099-01-01T00:00:00.000Z', dev: 'other', del: false,
      d: { sha256: '../victim', ext: 'txt', size_bytes: 1, created_at: '2020-01-01T00:00:00.000Z' } }]);
    await syncOnce(env.db, remote, dev(env.db));
    expect(env.db.get(`SELECT 1 FROM blobs WHERE sha256 = '../victim'`)).toBeUndefined();
    // ولو وُجد صفٌّ كهذا بطريق آخر: التنظيف لا يتجاوز مجلد المرفقات
    env.db.run(`INSERT INTO blobs (sha256, ext, size_bytes, created_at) VALUES ('../victim', 'txt', 1, '2020-01-01T00:00:00.000Z')`);
    gcBlobs(env.filesEnv, 0, new Date('2030-01-01T00:00:00.000Z'));
    expect(fs.existsSync(victim)).toBe(true);
    env.closeLive();
  } finally {
    rmrf(dir);
  }
});
