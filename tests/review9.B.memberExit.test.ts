/**
 * B-4 · عالٍ · ما يبقى على جوال العضو بعد خروجه من المنشأة (المراجعة الشاملة 2026-11-13 · قرارا المالك س٩ وس١٠ في 2026-11-13 تطبيقاً
 * لقرار 2026-11-07 (٢ أ) «لا نسخة للعضو المُزال إلا بما لم يُرفع من عمله») · الأجزاء الخالصة: ما لم يُرفع وملفه، وحذف نسخ الجهاز منذ
 * الانضمام، والتفريغ بلا نسخة أمان، وحارس الاستعادة، ووقت الانضمام · ومسار الدورة كاملاً في tests/review9.B.revokedMember.test.ts ·
 * بيانات مصطنعة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir, rmrf, memDb } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addProperty } from './helpers/fixtures';
import { collectUnsyncedWork, saveUnsyncedWork, dropMemberBackups, unsyncedDir, unsyncedPath, readExitNotice, writeExitNotice, clearExitNotice,
  MEMBER_SINCE_KEY, EXIT_DROP_KEY, noteDropPending, retryDropMemberBackups } from '@/domain/memberExit';
import { deviceBackups } from '@/domain/backup/deviceBackups';
import { makeSafetyBackup, safetyBackupsDir } from '@/domain/backup/create';
import { assertMembershipRestorable, prepareRestore } from '@/domain/backup/restore';
import { wipeAllData } from '@/domain/wipe';
import { leaveSafely } from '@/domain/leaveOrg';
import { acceptInvite, type MemberDoc } from '@/services/org';
import { getSyncState, setSyncState } from '@/sync/engine';
import { RestoreError } from '@/domain/backup/types';
import { t } from '@/i18n';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
const env0 = (prefix: string) => {
  const root = tempDir(prefix).replace(/\\/g, '/');
  dirs.push(root);
  return makeBackupEnv(root);
};
const devOf = (db: DB) => db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'device_id'`)!.value;
const member = (db: DB, org: string, uid: string) =>
  setSyncState(db, 'membership', JSON.stringify({ org, uid, perms: { collect: 1 }, allProps: true, props: [], profile: { name: 'عضو مصطنع', phone: '', nid: '', title: '' } }));
const AT = '2026-11-13T08:00:00.000Z';
const reject = (db: DB, id: string, reason: string, payload: unknown) =>
  db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`, ['properties__' + id, 'properties', id, reason, JSON.stringify(payload), AT]);

test('ما لم يُرفع: طابور الرفع بمحتواه، وما رفضته السحابة مما كتبه هذا الجهاز · لا ما رُفض تطبيقه من الوارد', () => {
  const db = memDb();
  const dev = devOf(db);
  addProperty(db, { id: 'P1', name: 'عقار مصطنع' });
  addProperty(db, { id: 'P3', name: 'عقار مصطنع مرفوض دائماً' });
  db.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'capture'`);
  db.run(`UPDATE properties SET name = 'عقار مصطنع معدَّل' WHERE id = 'P1'`);
  reject(db, 'P2', 'خارج صلاحيتك · بقي على هذا الجهاز ولم يُرفع', { id: 'properties__P2', t: 'properties', k: 'P2', d: { id: 'P2' }, u: AT, dev, del: false });
  // المرفوض رفضاً دائماً محفوظٌ بلا محتواه · يُبنى من الصف
  reject(db, 'P3', 'رفضته السحابة رفضاً دائماً · INVALID_ARGUMENT', { id: 'properties__P3', t: 'properties', k: 'P3', u: AT, del: false });
  reject(db, 'PX', 'سجل أب غير موجود بعد محاولات متكررة', { id: 'properties__PX', t: 'properties', k: 'PX', d: { id: 'PX' }, u: AT, dev: 'OTHER', del: false });
  const w = collectUnsyncedWork(db, dev);
  expect(w.docs.map((d) => [d.id, d.d?.name])).toEqual([['properties__P1', 'عقار مصطنع معدَّل']]);
  expect(w.rejected.map((r) => r.doc.id)).toEqual(['properties__P2', 'properties__P3']);
  expect(w.rejected[1].doc.d?.name).toBe('عقار مصطنع مرفوض دائماً');
  db.close();
});

test('الملف الصغير: لا ملف بلا شيء · وبه في مجلدٍ فرعي لا يعدّه زرّ «استعادة» نسخةً، واسمه وحده يُقرأ', () => {
  const env = env0('aqari-r9b4-file-');
  const db = env.db;
  const info = { reason: 'removed' as const, org: 'ORG-X', orgName: 'منشأة مصطنعة', uid: 'U-X', email: 'm@example.test', name: 'عضو مصطنع', deviceId: devOf(db) };
  expect(saveUnsyncedWork(env, db, info)).toBeNull();
  expect(fs.existsSync(unsyncedDir(env))).toBe(false);
  db.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'capture'`);
  addProperty(db, { id: 'P9', name: 'عقار مصطنع جديد' });
  const saved = saveUnsyncedWork(env, db, info)!;
  expect(saved.count).toBe(1);
  const work = JSON.parse(fs.readFileSync(unsyncedPath(env, saved.name), 'utf8'));
  expect(work).toMatchObject({ format: 'aqari-unsynced-work', version: 1, reason: 'removed', org: 'ORG-X', member: { uid: 'U-X' } });
  expect(work.docs.map((d: { id: string }) => d.id)).toEqual(['properties__P9']);
  expect(deviceBackups(env)).toEqual([]);
  for (const bad of ['../data.db', 'unsynced-work-x.json', 'pre-wipe-2026-11-07T08-05-09-120Z.aqbk']) expect(() => unsyncedPath(env, bad)).toThrow();
  // الإشعار ثم «تم»: يُمحى ويُحذف الملف
  writeExitNotice(db, { why: 'left', count: 1, file: saved.name, at: AT });
  expect(readExitNotice(db)).toEqual({ why: 'left', count: 1, file: saved.name, at: AT });
  clearExitNotice(env, db);
  expect(readExitNotice(db)).toBeNull();
  expect(fs.existsSync(unsyncedPath(env, saved.name))).toBe(false);
});

test('نسخٌ لا تُقرأ عضويتها: ما بعد الانضمام يُحذف وما قبله يبقى · وبلا وقت انضمام تُحذف كلها · ومجلد ما لم يُرفع لا يُمسّ', async () => {
  const env = env0('aqari-r9b4-drop-');
  // مجلد النسخ بجوار المؤقت (create.ts: tmp/../backups) · والحذف يبلغه ولو لم يُنشأ المؤقت بعد
  const dir = path.join(env.root, 'backups');
  fs.mkdirSync(path.join(dir, 'unsynced'), { recursive: true });
  const names = ['pre-upgrade-2020-01-01T00-00-00-000Z-v50.aqbk', 'pre-wipe-2026-11-01T00-00-00-000Z.aqbk', 'pre-restore-2026-11-02T00-00-00-000Z-empty.aqbk',
    'pre-upgrade-2026-11-03T00-00-00-000Z-v60.aqbk'];
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');
  fs.writeFileSync(path.join(dir, 'unsynced', 'unsynced-work-2026-11-13T08-00-00-000Z.json'), '{}');
  expect((await dropMemberBackups(env, 'ORG-X', '2026-10-01T00:00:00.000Z')).gone.sort()).toEqual(names.slice(1).sort());
  expect(fs.readdirSync(dir).sort()).toEqual([names[0], 'unsynced']);
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');
  expect((await dropMemberBackups(env, 'ORG-X', null)).gone).toHaveLength(4);
  expect(fs.readdirSync(path.join(dir, 'unsynced'))).toEqual(['unsynced-work-2026-11-13T08-00-00-000Z.json']);
});

/* ─── المراجعة الشاملة 2026-11-13 · R11-B4-2: النسخة تُعرف بما فيها لا بساعة الجهاز ─── */
test('R11-B4-2 · نسخةٌ فيها عضوية المنشأة تُحذف ولو سبق اسمُها وقت الانضمام · وبلا عضوية تبقى ولو جاءت بعده · وعضوية منشأةٍ أخرى ليست لهذا الخروج', async () => {
  const env = env0('aqari-r11b42-content-');
  addProperty(env.db, { id: 'P1', name: 'عقار مصطنع' });
  const dir = safetyBackupsDir(env);
  // نسخة صاحب الجهاز قبل انضمامه (بلا عضوية) · تُنقل إلى اسمٍ بعد «وقت الانضمام» فلا يحميها الوقت
  const own = await makeSafetyBackup(env, 'pre-restore');
  const ownLate = path.join(dir, 'pre-upgrade-2099-06-01T00-00-00-000Z-v60.aqbk');
  fs.renameSync(own, ownLate);
  // نسخةٌ لمنشأةٍ أخرى، ثم نسختان وهو عضو في ORG-A (ساعةٌ متقدمة عند الانضمام: الاسمان قبل وقت الانضمام) · وأسماء «ما قبل الترقية»
  // لا تحذفها نسخة الأمان التالية (create.ts)
  member(env.db, 'ORG-B', 'U-1');
  const b1 = path.join(dir, 'pre-upgrade-2026-02-01T00-00-00-000Z-v59.aqbk');
  fs.renameSync(await makeSafetyBackup(env, 'pre-wipe'), b1);
  member(env.db, 'ORG-A', 'U-1');
  const a2 = path.join(dir, 'pre-upgrade-2026-01-01T00-00-00-000Z-v59.aqbk');
  fs.renameSync(await makeSafetyBackup(env, 'pre-wipe'), a2);
  const a3 = await makeSafetyBackup(env, 'pre-wipe');
  expect(deviceBackups(env)).toHaveLength(4);
  setSyncState(env.db, 'membership', null);
  const r = await dropMemberBackups(env, 'ORG-A', '2099-01-01T00:00:00.000Z');
  expect(r.failed).toEqual([]);
  expect(r.gone.sort()).toEqual([path.basename(a2), path.basename(a3)].sort());
  expect(fs.existsSync(ownLate)).toBe(true);
  expect(fs.existsSync(b1)).toBe(true);
  // ولا يبقى في المؤقت شيءٌ من فتح القواعد
  expect((fs.existsSync(env.tmpDir) ? fs.readdirSync(env.tmpDir) : []).filter((n) => n.startsWith('exit-probe-'))).toEqual([]);
});

test('R11-B4-2 · ما تعذّر حذفه يُسجَّل ويُعاد حذفه حتى يتمّ', async () => {
  const env = env0('aqari-r11b42-retry-');
  addProperty(env.db, { id: 'P1', name: 'عقار مصطنع' });
  member(env.db, 'ORG-A', 'U-1');
  const copy = await makeSafetyBackup(env, 'pre-wipe');
  setSyncState(env.db, 'membership', null);
  noteDropPending(env.db, 'ORG-A', '2099-01-01T00:00:00.000Z');
  expect(getSyncState(env.db, EXIT_DROP_KEY)).not.toBeNull();
  expect(await retryDropMemberBackups(env, env.db)).toEqual([path.basename(copy)]);
  expect(fs.existsSync(copy)).toBe(false);
  expect(getSyncState(env.db, EXIT_DROP_KEY)).toBeNull();
  expect(await retryDropMemberBackups(env, env.db)).toEqual([]);
});

/* ─── المراجعة الشاملة 2026-11-13 · R11-B4-1: مرفقات العضو التي لم تُرفع تدخل ملفّ ما لم يُرفع ─── */
test('R11-B4-1 · مرفقٌ لم يُرفع ملفه يُحفظ بصفوفه وبايتاته (base64) ويدخل العدد · وما رُفع أو حُذف إلى السلة لا يُحفظ', async () => {
  const env = env0('aqari-r11b41-files-');
  const db = env.db;
  addProperty(db, { id: 'P1', name: 'عقار مصطنع' });
  const info = { reason: 'removed' as const, org: 'ORG-X', orgName: 'منشأة مصطنعة', uid: 'U-X', email: 'm@example.test', name: 'عضو مصطنع', deviceId: devOf(db) };
  db.run(`DELETE FROM sync_outbox`);
  const { putAttachment, softDeleteAttachment } = await import('@/files/store');
  // أحجامٌ تمرّ بكل حالات الحشو في base64 (٠ و١ و٢)
  const mk = (n: number, k: number) => new Uint8Array(n).map((_, i) => (i * k + 3) % 256);
  const pending = [mk(3000, 7), mk(3001, 11), mk(3002, 13)];
  const atts = [];
  for (const [i, b] of pending.entries()) {
    atts.push(await putAttachment(env.filesEnv, b, { entityType: 'property', entityId: 'P1', kind: 'إيصال', originalName: `إيصال مصطنع ${i}.pdf`, mime: 'application/pdf' }));
  }
  const uploaded = await putAttachment(env.filesEnv, mk(500, 17), { entityType: 'property', entityId: 'P1', kind: 'عقد', originalName: 'عقد مرفوع.pdf', mime: 'application/pdf' });
  db.run(`UPDATE file_cache SET uploaded = 1 WHERE sha256 = ?`, [uploaded.sha256]);
  const trashed = await putAttachment(env.filesEnv, mk(400, 19), { entityType: 'property', entityId: 'P1', kind: 'صورة', originalName: 'محذوف.pdf', mime: 'application/pdf' });
  softDeleteAttachment(db, trashed.id);
  const saved = saveUnsyncedWork(env, db, info)!;
  expect(saved.count).toBe(3);
  const work = JSON.parse(fs.readFileSync(unsyncedPath(env, saved.name), 'utf8'));
  expect(work.docs).toEqual([]);
  expect(work.files.map((f: { sha256: string }) => f.sha256).sort()).toEqual(atts.map((a) => a.sha256).sort());
  for (const [i, a] of atts.entries()) {
    const f = work.files.find((x: { sha256: string }) => x.sha256 === a.sha256);
    expect(Buffer.from(f.base64, 'base64').equals(Buffer.from(pending[i]))).toBe(true);
    expect(f.size_bytes).toBe(pending[i].byteLength);
    expect(f.attachments.map((r: { id: string; original_name: string }) => [r.id, r.original_name])).toEqual([[a.id, `إيصال مصطنع ${i}.pdf`]]);
  }
  // وبلا مرفقات: الملف كما كان مع «files» فارغة
  db.run(`UPDATE file_cache SET uploaded = 1`);
  db.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'capture'`);
  addProperty(db, { id: 'P9', name: 'عقار مصطنع جديد' });
  const plain = JSON.parse(fs.readFileSync(unsyncedPath(env, saveUnsyncedWork(env, db, info)!.name), 'utf8'));
  expect(plain.files).toEqual([]);
  expect(plain.docs.map((d: { id: string }) => d.id)).toContain('properties__P9');
});

test('التفريغ بلا نسخة أمان (madeSafety = null): لا نسخة تُصنع، والسجل يقول ذلك · ووقت الانضمام يبقى بعد تفريغٍ عادي', async () => {
  const env = env0('aqari-r9b4-wipe-');
  addProperty(env.db, { id: 'P1', name: 'عقار مصطنع' });
  setSyncState(env.db, MEMBER_SINCE_KEY, '2026-01-01T00:00:00.000Z');
  expect(await wipeAllData(env, undefined, null, 'سبب مصطنع')).toBe('');
  expect(fs.existsSync(safetyBackupsDir(env)) ? fs.readdirSync(safetyBackupsDir(env)) : []).toEqual([]);
  const db = env.live();
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n).toBe(0);
  const line = db.get<{ entity_name: string }>(`SELECT entity_name FROM audit_log WHERE entity_type = 'تفريغ الجهاز'`)!.entity_name;
  expect(line).toContain('سبب مصطنع');
  expect(line).toContain('بلا نسخة أمان');
  expect(getSyncState(db, MEMBER_SINCE_KEY)).toBe('2026-01-01T00:00:00.000Z');
  // والتفريغ العادي كما كان: بنسخة أمان
  addProperty(db, { id: 'P2', name: 'عقار مصطنع ثانٍ' });
  expect(await wipeAllData(env)).toMatch(/pre-wipe-.*\.aqbk$/);
});

test('حارس الاستعادة: نسخةٌ بعضويةٍ لا تُستعاد إلا على جهازٍ عضوٍ في منشأتها بالعضوية نفسها · ونسخة المالك كما كانت', () => {
  const staged = memDb();
  const live = memDb();
  expect(() => assertMembershipRestorable(staged, live)).not.toThrow();
  member(staged, 'ORG-A', 'U-1');
  expect(() => assertMembershipRestorable(staged, live)).toThrow(RestoreError);
  member(live, 'ORG-A', 'U-1');
  expect(() => assertMembershipRestorable(staged, live)).not.toThrow();
  member(live, 'ORG-B', 'U-1');
  expect(() => assertMembershipRestorable(staged, live)).toThrow(t('restore.foreignMembership'));
  member(live, 'ORG-A', 'U-2');
  expect(() => assertMembershipRestorable(staged, live)).toThrow(RestoreError);
  setSyncState(staged, 'membership', '{غير مقروء');
  member(live, 'ORG-A', 'U-1');
  expect(() => assertMembershipRestorable(staged, live)).toThrow(RestoreError);
  staged.close(); live.close();
});

test('حارس الاستعادة في المسار نفسه: نسخة أمانٍ صُنعت والجهاز عضو لا تُستعاد بعد أن خرج', async () => {
  const env = env0('aqari-r9b4-restore-');
  addProperty(env.db, { id: 'P1', name: 'عقار مصطنع' });
  member(env.db, 'ORG-A', 'U-1');
  const copy = await makeSafetyBackup(env, 'pre-wipe');
  const out = path.join(env.root, 'copy.aqbk');
  fs.copyFileSync(copy, out);
  // وهو عضو: تُجهَّز
  const plan = await prepareRestore(env, out);
  const { abortRestore } = await import('@/domain/backup/restore');
  abortRestore(env, plan.stagingDir);
  // بعد خروجه (لا عضوية): تُرفض
  setSyncState(env.db, 'membership', null);
  await expect(prepareRestore(env, out)).rejects.toThrow(t('restore.foreignMembership'));
});

test('وقت الانضمام يُحفظ مع قبول الدعوة', async () => {
  const db = memDb();
  const doc = { email: 'm@example.test', perm: { collect: 1 }, all: true, props: [], tokens: ['collect|*'], orgName: 'منشأة مصطنعة', name: '', phone: '', nid: '', title: '' };
  const remote = { getDoc: async () => ({ ...doc }), commitDocs: async () => {} };
  const before = Date.now();
  await acceptInvite(db, remote as never, 'ORG-A', 'U-1', doc as MemberDoc);
  const since = getSyncState(db, MEMBER_SINCE_KEY);
  expect(since).not.toBeNull();
  expect(Date.parse(since!)).toBeGreaterThanOrEqual(before - 1000);
  db.close();
});

test('المغادرة: ملفُّ ما لم يُرفع أولاً (أو لا شيء) وفشله يوقفها · ولا نسخة أمانٍ كاملة في الخدمة', async () => {
  const calls: string[] = [];
  expect(await leaveSafely({
    backup: async () => { calls.push('saved'); return null; },
    leaveCloud: async () => { calls.push('leave'); },
    wipe: async (s, why) => { calls.push('wipe:' + s + ':' + why); },
  }, 'سبب مصطنع')).toBeNull();
  expect(calls).toEqual(['saved', 'leave', 'wipe:null:سبب مصطنع']);
  const cloud = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'cloud.ts'), 'utf8');
  const body = (decl: string) => { const i = cloud.indexOf(decl); return cloud.slice(i, cloud.indexOf('\n}\n', i)); };
  expect(body('export async function leaveOrgNow')).not.toContain('makeSafetyBackup');
  expect(body('async function wipeForRemoval')).toContain('wipeLocal(db, undefined, null,');
  // ولا «أبقِ بياناتي» ولا تفريغٌ ينتظر بعد الإزالة
  expect(body('export async function resolveDecision')).not.toMatch(/wipeForRemoval\(/);
  const sheet = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'DecisionSheet.tsx'), 'utf8');
  const removed = sheet.slice(sheet.indexOf("if (decision.kind === 'removed')"), sheet.indexOf('  return (\n    <Sheet visible onClose={() => setLater(true)} title="مُسحت'));
  expect(removed).not.toMatch(/run\('keep'\)|run\('wipe'\)/);
  expect(removed).toContain("run('done')");
});
