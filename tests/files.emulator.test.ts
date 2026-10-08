/**
 * مزامنة الملفات بالنموذج المختلط على محاكيي Firestore وStorage معاً (قرار المالك ٢٠٢٦-١٠-٠٧):
 * الملف يُرفع في الخلفية ويُطابَق ببصمته، وصفّه يُزامَن وحده، والجهاز الآخر يسحب البيانات بلا ملفات ثم يُنزّل
 * الملف عند فتحه · وقواعد التخزين تحصر القراءة في رموز العضو، والرفع في «إدخال»، والحذف في المالك.
 *   firebase emulators:exec --only firestore,storage --project demo-aqari "npx jest -i tests/files.emulator.test.ts"
 * البيانات والملفات مصطنعة كلها.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { FirestoreRemote } from '@/cloud/firestore';
import type { DB } from '@/db/adapter';
import { memberTokens, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';
import { readAccess, readMembership, saveMembership, type Membership } from '@/services/access';
import { sendInvite, findInvites, acceptInvite } from '@/services/org';
import { putAttachment } from '@/files/store';
import { pumpUploads, ensureLocal, fileState, FileUnavailableError, type FilesRemote } from '@/files/cloudFiles';
import { objectName, statObject, uploadObject, deleteObject, addTokens, type StorageTarget } from '@/cloud/storage';
import { nodeStorageIO } from './helpers/nodeStorageIO';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';

const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const ST_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const BUCKET = 'demo-aqari.appspot.com';
const OWNER = 'OWNER-FILES';
const OWNER_EMAIL = 'owner-files@example.test';
const d = FS_HOST && ST_HOST ? describe : describe.skip;

function token(uid: string, email: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const base = (uid: string, email: string) => ({ projectId: PROJECT, uid, idToken: async () => token(uid, email), baseUrl: 'http://' + FS_HOST });
const tables = SYNC_TABLES.map((t) => t.name);
function deviceRemote(db: DB, uid: string, email: string): FirestoreRemote {
  const m = readMembership(db);
  if (m) {
    return new FirestoreRemote({ ...base(uid, email), org: m.org,
      memberTokens: () => memberTokens(readAccess(db)), fullReadTables: () => fullReadTables(readAccess(db), tables), access: () => readAccess(db) });
  }
  return new FirestoreRemote({ ...base(uid, email), org: uid, access: () => readAccess(db) });
}
const target = (uid: string, email: string): StorageTarget => ({ base: 'http://' + ST_HOST, bucket: BUCKET, org: OWNER, idToken: async () => token(uid, email) });
const filesRemote = (db: DB, uid: string, email: string): FilesRemote => ({ io: nodeStorageIO, target: target(uid, email), access: readAccess(db) });
async function bind(db: DB, m: Membership, uid: string) {
  const { setSyncState, setCapture } = await import('@/sync/engine');
  saveMembership(db, m);
  setSyncState(db, 'org', m.org);
  setSyncState(db, 'uid', uid);
  setSyncState(db, 'cursor', null);
  db.run(`DELETE FROM sync_outbox`);
  setCapture(db, true);
}

const dirs: string[] = [];
afterAll(() => { for (const x of dirs) rmrf(x); });
const newEnv = (): TestBackupEnv => { const dir = tempDir('aq-files-'); dirs.push(dir); fs.mkdirSync(dir, { recursive: true }); return makeBackupEnv(dir); };
const bytesOf = (seed: number, n = 70_000) => new Uint8Array(n).map((_, k) => (k * 31 + seed * 7) % 251);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const fe = (e: TestBackupEnv) => ({ db: e.db, fs: e.fs, hasher: e.hasher!, attachmentsDir: e.attachmentsDir });

d('مزامنة الملفات على المحاكي', () => {
  let owner: TestBackupEnv;
  let C1 = ''; let C2 = '';
  const M = { uid: 'MEM-FILES', email: 'mem-files@example.test' };
  const W = { uid: 'MEM-WRITER', email: 'mem-writer@example.test' };
  let member: TestBackupEnv;
  let writer: TestBackupEnv;
  const f1 = bytesOf(1); const f2 = bytesOf(2);

  beforeAll(async () => {
    await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const { enableSync, syncOnce, setFilesSync } = await import('@/sync/engine');
    owner = newEnv();
    addProperty(owner.db, { id: 'FP1', name: 'عقار الملفات الأول' });
    addProperty(owner.db, { id: 'FP2', name: 'عقار الملفات الثاني' });
    C1 = confirmContract(owner.db, contractInput(addUnit(owner.db, 'FP1', { unit_no: 'F-1' }), { tenant: 'مستأجر ملفات أول', idNumber: '1000007001', phone: '0500007001' }));
    C2 = confirmContract(owner.db, contractInput(addUnit(owner.db, 'FP2', { unit_no: 'F-2' }), { tenant: 'مستأجر ملفات ثانٍ', idNumber: '1000007002', phone: '0500007002' }));
    enableSync(owner.db, OWNER);
    owner.db.run(`INSERT INTO sync_state (k, v) VALUES ('org', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [OWNER]);
    setFilesSync(owner.db, true); // التخزين مفعّل (في التطبيق: filesCloudOn)
    // ملفٌ لكل عقد
    await putAttachment(fe(owner), f1, { entityType: 'contract', entityId: C1, kind: 'عقد', originalName: 'عقد-أول.pdf', mime: 'application/pdf' });
    await putAttachment(fe(owner), f2, { entityType: 'contract', entityId: C2, kind: 'عقد', originalName: 'عقد-ثان.pdf', mime: 'application/pdf' });
    expect((await syncOnce(owner.db, deviceRemote(owner.db, OWNER, OWNER_EMAIL), 'dev-owner-f')).pending).toBe(0);

    const orgR = new FirestoreRemote({ ...base(OWNER, OWNER_EMAIL), org: OWNER });
    await sendInvite(orgR, OWNER, { email: M.email, perms: { contracts: 1, props: 1 }, allProps: false, props: ['FP1'] }, 'منشأة الملفات', OWNER_EMAIL);
    await sendInvite(orgR, OWNER, { email: W.email, perms: { contracts: 2, props: 1 }, allProps: false, props: ['FP1'] }, 'منشأة الملفات', OWNER_EMAIL);
    member = newEnv(); writer = newEnv();
    for (const [env, x] of [[member, M], [writer, W]] as const) {
      const plain = new FirestoreRemote(base(x.uid, x.email));
      const inv = await findInvites(plain, x.email);
      await bind(env.db, await acceptInvite(env.db, plain, OWNER, x.uid, inv[0].doc), x.uid);
      setFilesSync(env.db, true);
    }
  });

  test('الرفع في الخلفية: يُطابَق بالبصمة ويحمل رموز رؤية مرفقه · ولا يُرفع ثانيةً', async () => {
    expect(fileState(fe(owner), sha(f1), 'pdf')).toBe('uploading');
    const r = await pumpUploads(fe(owner), filesRemote(owner.db, OWNER, OWNER_EMAIL));
    expect(r).toEqual({ uploaded: 2, failed: 0, lost: 0 });
    expect(fileState(fe(owner), sha(f1), 'pdf')).toBe('local');
    const st = await statObject(nodeStorageIO, target(OWNER, OWNER_EMAIL), objectName(OWNER, sha(f1), 'pdf'));
    expect(st!.md5).toBe(createHash('md5').update(f1).digest('base64'));
    expect(st!.g).toContain('contracts|FP1');
    expect(st!.g).not.toContain('contracts|FP2');
    expect(await pumpUploads(fe(owner), filesRemote(owner.db, OWNER, OWNER_EMAIL))).toEqual({ uploaded: 0, failed: 0, lost: 0 });
  });

  test('عضوٌ يسحب البيانات بلا ملفات · ويُنزّل ملف عقاره عند فتحه ويطابق بصمته · ولا يُنزّل ملف عقارٍ ليس له', async () => {
    const { syncOnce } = await import('@/sync/engine');
    await syncOnce(member.db, deviceRemote(member.db, M.uid, M.email), 'dev-' + M.uid);
    const att = member.db.get<{ sha256: string }>(`SELECT sha256 FROM attachments WHERE entity_id = ?`, [C1]);
    expect(att!.sha256).toBe(sha(f1));
    expect(member.db.get(`SELECT 1 FROM attachments WHERE entity_id = ?`, [C2])).toBeUndefined();
    // أول سحب: البيانات وحدها
    expect(fs.existsSync(path.join(member.attachmentsDir, sha(f1) + '.pdf'))).toBe(false);
    expect(fileState(fe(member), sha(f1), 'pdf')).toBe('remote');
    // بلا اتصال: سببٌ يُعرض
    await expect(ensureLocal(fe(member), filesRemote(member.db, M.uid, M.email), sha(f1), 'pdf', { online: false })).rejects.toBeInstanceOf(FileUnavailableError);
    const p = await ensureLocal(fe(member), filesRemote(member.db, M.uid, M.email), sha(f1), 'pdf');
    expect(sha(new Uint8Array(fs.readFileSync(p)))).toBe(sha(f1));
    expect(fileState(fe(member), sha(f1), 'pdf')).toBe('local');
    // ملف العقار الآخر ترفضه قواعد التخزين ولو عُرف اسمه
    const other = path.join(member.attachmentsDir, 'x.part');
    const res = await nodeStorageIO.downloadFile(`http://${ST_HOST}/v0/b/${BUCKET}/o/${encodeURIComponent(objectName(OWNER, sha(f2), 'pdf'))}?alt=media`, other, { Authorization: 'Firebase ' + token(M.uid, M.email) });
    expect(res.status).toBe(403);
  });

  test('عضو بإدخال يرفع ملفاً لعقده · وعضو بعرضٍ وحده لا يرفع · والرفع بـ md5 مزوّر مرفوض', async () => {
    const { syncOnce } = await import('@/sync/engine');
    await syncOnce(writer.db, deviceRemote(writer.db, W.uid, W.email), 'dev-' + W.uid);
    const f3 = bytesOf(3);
    await putAttachment(fe(writer), f3, { entityType: 'contract', entityId: C1, kind: 'صورة', originalName: 'صورة.jpg', mime: 'image/jpeg' });
    expect(await pumpUploads(fe(writer), filesRemote(writer.db, W.uid, W.email))).toEqual({ uploaded: 1, failed: 0, lost: 0 });

    const f4 = bytesOf(4);
    await putAttachment(fe(member), f4, { entityType: 'contract', entityId: C1, kind: 'صورة', originalName: 'صورة.jpg', mime: 'image/jpeg' });
    const r = await pumpUploads(fe(member), filesRemote(member.db, M.uid, M.email));
    expect(r.failed).toBe(1);
    expect(fileState(fe(member), sha(f4), 'jpg')).toBe('uploading'); // يبقى على الجهاز
    expect(member.db.get<{ e: string }>(`SELECT last_error AS e FROM file_cache WHERE sha256 = ?`, [sha(f4)])!.e).toContain('رُفض');

    const f5 = bytesOf(5);
    const p5 = path.join(owner.root, 'f5.bin');
    fs.writeFileSync(p5, f5);
    await expect(uploadObject(nodeStorageIO, target(OWNER, OWNER_EMAIL), objectName(OWNER, sha(f5), 'bin'), p5,
      { g: ['contracts|FP1'], op: null, sha256: sha(f5), md5: createHash('md5').update(bytesOf(6)).digest('base64'), contentType: 'application/octet-stream' }))
      .rejects.toThrow('رُفض الوصول');
  });

  test('البصمة نفسها تُربط بعقارٍ آخر: تُضمّ رموزه ولا يُرفع الملف ثانيةً · والحذف للمالك وحده', async () => {
    const { putAttachment: put } = await import('@/files/store');
    await put(fe(owner), f1, { entityType: 'contract', entityId: C2, kind: 'عقد', originalName: 'نسخة.pdf', mime: 'application/pdf' });
    owner.db.run(`UPDATE file_cache SET uploaded = 0 WHERE sha256 = ?`, [sha(f1)]);
    expect(await pumpUploads(fe(owner), filesRemote(owner.db, OWNER, OWNER_EMAIL))).toEqual({ uploaded: 1, failed: 0, lost: 0 });
    const st = await statObject(nodeStorageIO, target(OWNER, OWNER_EMAIL), objectName(OWNER, sha(f1), 'pdf'));
    expect(st!.g).toEqual(expect.arrayContaining(['contracts|FP1', 'contracts|FP2']));

    await expect(deleteObject(nodeStorageIO, target(W.uid, W.email), objectName(OWNER, sha(f1), 'pdf'))).rejects.toThrow('رُفض');
    await deleteObject(nodeStorageIO, target(OWNER, OWNER_EMAIL), objectName(OWNER, sha(f2), 'pdf'));
    expect(await statObject(nodeStorageIO, target(OWNER, OWNER_EMAIL), objectName(OWNER, sha(f2), 'pdf'))).toBeNull();
  });

  test('#19 رموز رؤية الملف يزيدها من يقرؤه وحده: عضوٌ لا يقرأ ملفاً لا يضمّ رمزه إليه فيقرؤه', async () => {
    const f7 = bytesOf(7);
    await putAttachment(fe(owner), f7, { entityType: 'contract', entityId: C2, kind: 'هوية', originalName: 'هوية.jpg', mime: 'image/jpeg' });
    expect((await pumpUploads(fe(owner), filesRemote(owner.db, OWNER, OWNER_EMAIL))).uploaded).toBeGreaterThan(0);
    const name7 = objectName(OWNER, sha(f7), 'jpg');
    const there = (await statObject(nodeStorageIO, target(OWNER, OWNER_EMAIL), name7))!;
    expect(there.g.some((x) => x.endsWith('|FP1'))).toBe(false);
    // عضو العقار الأول يعرف البصمة (جدول البصمات يقرؤه كل قسم) فيضمّ رمزه إليها
    await expect(addTokens(nodeStorageIO, target(M.uid, M.email), name7, there, ['contracts|FP1'])).rejects.toThrow('رُفض');
    await expect(statObject(nodeStorageIO, target(M.uid, M.email), name7)).rejects.toThrow('رُفض');
    expect((await statObject(nodeStorageIO, target(OWNER, OWNER_EMAIL), name7))!.g).toEqual(there.g);
    // ومن يقرأ الملف يضمّ إليه (بصمةٌ رُبطت بجهةٍ أخرى عنده)
    const name1 = objectName(OWNER, sha(f1), 'pdf');
    const f1there = (await statObject(nodeStorageIO, target(W.uid, W.email), name1))!;
    await addTokens(nodeStorageIO, target(W.uid, W.email), name1, f1there, ['handover|FP1']);
    expect((await statObject(nodeStorageIO, target(OWNER, OWNER_EMAIL), name1))!.g).toContain('handover|FP1');
  });

  test('#19 (التحقق المستقل): العضو لا يكتب فوق ملفٍ قائم برفعٍ جديد · ولا يوسّع رؤيته لكل العقارات · والمالك يصلح ملفاً سُبق إليه', async () => {
    const name7 = objectName(OWNER, sha(bytesOf(7)), 'jpg');
    const was = (await statObject(nodeStorageIO, target(OWNER, OWNER_EMAIL), name7))!;
    const p7 = path.join(writer.root, 'f7.jpg');
    fs.writeFileSync(p7, bytesOf(7));
    const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('base64');
    // لا يقرؤه (عقار آخر) فيعيد رفع محتواه برمزه ليقرأه
    await expect(uploadObject(nodeStorageIO, target(W.uid, W.email), name7, p7,
      { g: [...was.g, 'contracts|FP1'], op: 'contracts', sha256: sha(bytesOf(7)), md5: md5(bytesOf(7)), contentType: 'image/jpeg' }))
      .rejects.toThrow('رُفض');
    // ولا يكتب فوقه محتوىً آخر برموزه
    const junk = bytesOf(99);
    const pj = path.join(writer.root, 'junk.bin');
    fs.writeFileSync(pj, junk);
    await expect(uploadObject(nodeStorageIO, target(W.uid, W.email), name7, pj,
      { g: ['contracts|FP1'], op: 'contracts', sha256: sha(bytesOf(7)), md5: md5(junk), contentType: 'image/jpeg' }))
      .rejects.toThrow('رُفض');
    const after = (await statObject(nodeStorageIO, target(OWNER, OWNER_EMAIL), name7))!;
    expect([after.md5, after.g]).toEqual([was.md5, was.g]);
    // من يقرأ الملف لا يضمّ إليه رمز «كل العقارات» فيقرؤه أعضاء عقارٍ آخر
    const name1 = objectName(OWNER, sha(f1), 'pdf');
    const f1there = (await statObject(nodeStorageIO, target(W.uid, W.email), name1))!;
    await expect(addTokens(nodeStorageIO, target(W.uid, W.email), name1, f1there, ['contracts|*'])).rejects.toThrow('رُفض');
    // عضوٌ سبق المالك إلى بصمةٍ بمحتوىً آخر: يرفع المالك الملف الصحيح فوقه
    const f8 = bytesOf(8);
    const name8 = objectName(OWNER, sha(f8), 'bin');
    await uploadObject(nodeStorageIO, target(W.uid, W.email), name8, pj,
      { g: ['contracts|FP1'], op: 'contracts', sha256: sha(f8), md5: md5(junk), contentType: 'application/octet-stream' });
    const p8 = path.join(owner.root, 'f8.bin');
    fs.writeFileSync(p8, f8);
    await uploadObject(nodeStorageIO, target(OWNER, OWNER_EMAIL), name8, p8,
      { g: ['contracts|@', 'contracts|FP1'], op: null, sha256: sha(f8), md5: md5(f8), contentType: 'application/octet-stream' });
    expect((await statObject(nodeStorageIO, target(OWNER, OWNER_EMAIL), name8))!.md5).toBe(md5(f8));
  });
});
