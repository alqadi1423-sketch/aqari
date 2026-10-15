/**
 * المراجعة الخارجية ٧ · النتائج المنخفضة على الجهاز · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment, cancelContract } from '@/domain/contracts/service';
import { postEntry } from '@/domain/accounting/post';
import { integrityChecks } from '@/domain/accounting/integrity';
import { contractSurpluses, settleSurplus } from '@/domain/ledgerReview';
import type { DB } from '@/db/adapter';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce, syncStatus, docId, stageInbox } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import { failureAuditDetail } from '@/domain/redact';
import { profileForAudit } from '@/domain/access/profile';
import { auditWriter, AUDIT_WRITER_SQL, logAudit } from '@/domain/audit';

jest.mock('@/services/cloud', () => ({}));
const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');

const check = (db: DB, prefix: string) => integrityChecks(db).find((c) => c.name.startsWith(prefix))!;

test('٢٤ إلغاء عقدٍ بتأمينٍ بلا تسوية لا يُحمِّر فحص التأمينات (التأمين محتجزٌ حتى التسوية)', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db), { rent: 100000 });
  const cid = confirmContract(db, contractInput(u, { valueHalalas: 1200000, depositHalalas: 200000 }));
  expect(check(db, 'تأمينات المستأجرين').ok).toBe(true);
  cancelContract(db, cid, { date: '2026-03-20', reason: 'إلغاء مصطنع', installmentsFate: 'keep', settle: false, deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });
  const c = check(db, 'تأمينات المستأجرين');
  expect(c.value + ' ' + c.ok).toContain('true');
  db.close();
});

test('٢٥ ردّ الفائض من بنكٍ رصيده لا يكفي يُرفض · ومن بنكٍ يكفيه يمرّ', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db), { rent: 100000 });
  const cid = confirmContract(db, contractInput(u, { valueHalalas: 1200000, depositHalalas: 0 }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  recordRentPayment(db, cid, { installmentId: insts[0], period: 'م', date: '2026-01-05', notes: '', discountHalalas: 0, lines: [{ method: 'cash', amountHalalas: 100000 }] });
  // دفعة ثانية على القسط نفسه كما من جهاز آخر · فائض ١٠٠٠ ريال
  db.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'applying'`);
  recordRentPayment(db, cid, { installmentId: insts[1], period: 'م', date: '2026-01-06', notes: '', discountHalalas: 0, lines: [{ method: 'cash', amountHalalas: 100000 }] });
  db.run(`UPDATE sync_ctl SET v = 0 WHERE k = 'applying'`);
  db.run(`UPDATE contract_payments SET installment_id = ? WHERE date = '2026-01-06'`, [insts[0]]);
  db.run(`UPDATE contract_installments SET paid_halalas = 0, status = 'مستحقة' WHERE id = ?`, [insts[1]]);
  expect(contractSurpluses(db).map((s) => s.amount)).toEqual([100000]);
  const poor = addBank(db, 'بنك مصطنع فقير', 5000);
  expect(() => settleSurplus(db, cid, { action: 'refund', amountHalalas: 100000, date: '2026-02-01', method: 'bank', bankId: poor })).toThrow();
  const rich = addBank(db, 'بنك مصطنع غني', 500000);
  expect(() => settleSurplus(db, cid, { action: 'refund', amountHalalas: 100000, date: '2026-02-01', method: 'bank', bankId: rich })).not.toThrow();
  db.close();
});

test('٢٦ إهلاك الشهر نفسه مرتين يُحمِّر فحص المطابقة', () => {
  const db = memDb();
  expect(check(db, 'إهلاك كل شهر').ok).toBe(true);
  for (const memo of ['جهاز أ', 'جهاز ب']) {
    postEntry(db, { date: '2026-02-28', memo, lines: [{ account: '5600', debit: 100, credit: 0 }, { account: '1490', debit: 0, credit: 100 }], srcType: 'depreciation', srcId: '2026-02' });
  }
  expect(check(db, 'إهلاك كل شهر').ok).toBe(false);
  db.close();
});

test('٢٨ و٣٠ و٣١ في مواضعها: المصغّرات بأسماء مفحوصة · والتذكيرات تُلغى في التفريغ والإزالة والخروج · والعطل محجوب في السجل', () => {
  const thumbs = src('src/services/thumbs.ts');
  expect(thumbs).toMatch(/existingThumbUri[^]*?isSafeBlobName\(sha256, 'jpg'\)/);
  expect(thumbs).toMatch(/thumbUri\(sha256: string, ext[^]*?isSafeBlobName\(sha256, ext\)/);
  expect(src('src/services/deviceReset.ts')).toMatch(/resetDeviceData[^]*?cancelAllNotifications\(/);
  const cloud = src('src/services/cloud.ts');
  const fn = (name: string) => { const i = cloud.indexOf('function ' + name); return cloud.slice(i, cloud.indexOf('\n}\n', i)); };
  expect(fn('wipeLocal')).toContain('cancelAllNotifications(');
  expect(fn('cloudSignOut')).toContain('cancelAllNotifications(');
  expect(fn('wipeForRemoval')).toContain('wipeLocal(');
  const fd = src('src/ui/failureDialog.ts');
  expect(fd).not.toMatch(/\.message : String\([^)]*\)\)\.slice\(0, 300\)/);
  expect((fd.match(/failureAuditDetail\(/g) ?? []).length).toBe(2);
});

test('٣١ تفاصيل العطل في السجل لا تحمل اسماً ولا مبلغاً ولا رقماً', () => {
  const d = failureAuditDetail(new Error('تعذّر إلغاء دفعة المستأجر محمد المصطنع بمبلغ ١٢٠٠ ريال على العقد C-2026-17'));
  for (const bit of ['محمد', 'المصطنع', '١٢٠٠', '2026', '17']) expect(d).not.toContain(bit);
  class RestoreError extends Error { constructor(m: string) { super(m); this.name = 'RestoreError'; } }
  expect(failureAuditDetail(new RestoreError('نسخة مصطنعة لمستأجر مصطنع'))).toMatch(/^RestoreError:/);
});

test('٢٩ (ج) الجوال والهوية في سجل العمليات بحالهما لا بقيمتهما', () => {
  const before = { name: 'عضو مصطنع', phone: '0500000029', nid: '1000000029', title: '' };
  const after = { ...before, phone: '0500000030' };
  const a = profileForAudit(after, null)!;
  const b = profileForAudit(before, after)!;
  expect(JSON.stringify([a, b])).not.toMatch(/05000000(29|30)|1000000029/);
  expect([b['الجوال'], a['الجوال'], a['الهوية']]).toEqual(['قديم', 'مُدخل', 'مُدخلة']);
});

test('١٩ الوارد المنتظر لا يغلب الأحدثَ بـ u يعلنه كاتبه (PROBE2c): يبقى في الصندوق النسخة الأحدث بوقت الخادم', () => {
  const db = memDb();
  enableSync(db, 'OWNER-19');
  const base = { id: docId('units', 'UN19'), t: 'units', k: 'UN19', dev: 'dev-x', d: { id: 'UN19', property_id: 'P-MISSING', unit_no: 'OLD' } };
  stageInbox(db, [{ ...base, u: '2099-01-01T00:00:00.000Z', ts: '2026-01-01T00:00:00.000Z' } as never]);
  stageInbox(db, [{ ...base, u: '2026-02-01T00:00:00.000Z', ts: '2026-02-01T00:00:01.000Z', d: { ...base.d, unit_no: 'NEW' } } as never]);
  const p = JSON.parse(db.get<{ p: string }>(`SELECT payload AS p FROM sync_inbox WHERE doc = ?`, [base.id])!.p);
  expect(p.d.unit_no).toBe('NEW');
  db.close();
});

test('١٩ (الجولة ٣٠) كاتبٌ ساعته متأخرة: الصندوق يحفظ الأحدث بوقت الخادم', () => {
  const db = memDb();
  enableSync(db, 'OWNER-19B');
  const base = { id: docId('units', 'UN19B'), t: 'units', k: 'UN19B', dev: 'dev-x', d: { id: 'UN19B', property_id: 'P-MISSING', unit_no: 'OLD' } };
  stageInbox(db, [{ ...base, u: '2026-02-01T00:00:00.000Z', ts: '2026-02-01T00:00:00.000Z' } as never]);
  stageInbox(db, [{ ...base, u: '2026-01-31T23:00:05.000Z', ts: '2026-02-01T00:00:05.000Z', d: { ...base.d, unit_no: 'NEW' } } as never]);
  expect(JSON.parse(db.get<{ p: string }>(`SELECT payload AS p FROM sync_inbox WHERE doc = ?`, [base.id])!.p).d.unit_no).toBe('NEW');
  db.close();
});

test('٢١ رفض قيدٍ مرحّل لأن نسخته في السحابة نهائية يُسجَّل على جهاز المالك ويظهر عدده · ورفض سطر السجل لا يُسجَّل', async () => {
  const db = memDb();
  enableSync(db, 'OWNER-21');
  const r = new MemoryRemote();
  const e = postEntry(db, { date: '2026-02-01', memo: 'قيد مصطنع', lines: [{ account: '1100', debit: 500, credit: 0 }, { account: '3100', debit: 0, credit: 500 }] })!;
  await syncOnce(db, r, getMeta(db, 'device_id')!);
  const cloudDoc = r.docs.get(docId('journal_entries', e.id))!;
  cloudDoc.d = { ...cloudDoc.d!, memo: 'نسخة السحابة' };
  db.run(`INSERT INTO sync_outbox (tbl, pk, op, changed_at) VALUES ('journal_entries', ?, 'upsert', ?) ON CONFLICT(tbl, pk) DO NOTHING`, [e.id, new Date().toISOString()]);
  // وسطر سجلٍ قائم في السحابة يُعاد رفعه فيُرفض (يقع في مسارات سليمة)
  const aud = db.get<{ id: string }>(`SELECT id FROM audit_log LIMIT 1`);
  if (aud) db.run(`INSERT INTO sync_outbox (tbl, pk, op, changed_at) VALUES ('audit_log', ?, 'upsert', ?) ON CONFLICT(tbl, pk) DO NOTHING`, [aud.id, new Date().toISOString()]);
  await syncOnce(db, r, getMeta(db, 'device_id')!);
  const rej = db.all<{ tbl: string; reason: string }>(`SELECT tbl, reason FROM sync_rejects`);
  expect(rej.map((x) => [x.tbl, x.reason.split(' · ')[0]])).toEqual([['journal_entries', 'نهائي في السحابة']]);
  expect(syncStatus(db).rejected).toBe(1);
  db.close();
});

test('٢٣ الوارد بعهد مسحٍ أقدم من عهد الجهاز يُترك · وبعهده يُطبَّق', async () => {
  const db = memDb();
  enableSync(db, 'OWNER-23');
  db.run(`INSERT INTO sync_state (k, v) VALUES ('wipe_epoch', '2') ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
  const r = new MemoryRemote();
  const doc = (id: string, ep?: number) => ({ id: docId('properties', id), t: 'properties', k: id, u: '2026-10-15T00:00:00.000Z', dev: 'dev-old', del: false,
    d: { id, name: 'عقار مصطنع ' + id, ownership: 'ملك', floors: 1, archived: 0, created_at: '2026-10-15T00:00:00.000Z' }, ...(ep ? { ep } : {}) });
  r.inject(doc('P-STALE') as never);
  r.inject(doc('P-OLD', 1) as never);
  r.inject(doc('P-NOW', 2) as never);
  await syncOnce(db, r, getMeta(db, 'device_id')!);
  const ids = db.all<{ id: string }>(`SELECT id FROM properties ORDER BY id`).map((x) => x.id);
  expect(ids).toEqual(['P-NOW']);
  db.close();
});

test('قرار المالك 2026-10-15 «١٦»: العضو في منشأةٍ بلا عدّاد يتابع المزامنة بلا أرقام جديدة', async () => {
  const db = memDb();
  enableSync(db, 'MEMBER-16');
  const r = new MemoryRemote();
  r.inject({ id: docId('properties', 'P16'), t: 'properties', k: 'P16', u: '2026-10-15T00:00:00.000Z', dev: 'dev-o', del: false,
    d: { id: 'P16', name: 'عقار مصطنع', ownership: 'ملك', floors: 1, archived: 0, created_at: '2026-10-15T00:00:00.000Z' } } as never);
  Object.assign(r, { memberMode: true, reserveBlocks: async () => { throw new Error('Firestore 403: Missing or insufficient permissions.'); } });
  await syncOnce(db, r, getMeta(db, 'device_id')!);
  expect(db.get(`SELECT 1 FROM properties WHERE id = 'P16'`)).toBeTruthy();
  expect(db.get<{ v: string }>(`SELECT v FROM sync_state WHERE k = 'blocks_error'`)?.v).toContain('403');
  db.close();
});

test('قرار المالك 2026-10-15 «٤»: زرّ «اشترط إصداري على الأعضاء» في شاشة الأعضاء وتذكيرٌ عند أول دعوة · بلا رفعٍ تلقائي', () => {
  const ts = src('src/ui/TeamSheet.tsx');
  expect(ts).toContain("t('compat.requireMine')");
  expect(ts).toMatch(/const first = !!team && !team.members.length && !team.invites.length;[^]*?compat.remindBody/);
  const cloud = src('src/services/cloud.ts');
  // لا رفع تلقائي: raiseCompat لا يُستدعى إلا من زرّه
  expect((cloud.match(/raiseCompat\(/g) ?? []).length).toBe(1);
  expect(cloud).toMatch(/export async function raiseCompatNow[^]*?raiseCompat\(/);
});

test('قرار المالك 2026-10-15 «١٠»: كاتب سطر السجل من معرّفه · وسطرٌ باسم عضوٍ آخر يُعرض بكاتبه مع الاسم المكتوب', () => {
  const db = memDb();
  db.run(`INSERT INTO chat_people (uid, name, sup) VALUES ('U-A', 'عضو أ مصطنع', '[]'), ('U-B', 'عضو ب مصطنع', '[]')`);
  db.run(`INSERT INTO sync_state (k, v) VALUES ('org', 'OWN-10') ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
  const add = (id: string, name: string, by: string | null) => {
    db.run(`INSERT INTO audit_log (id, ts, user_name, module, action_type, entity_type, entity_name) VALUES (?, '2026-10-15T00:00:00', ?, 'العقود', 'update', 'سطر', 'مصطنع')`, [id, name]);
    if (by !== null) db.run(`INSERT OR REPLACE INTO row_by (tbl, pk, uid) VALUES ('audit_log', ?, ?)`, [id, by]);
  };
  add('AU1', 'عضو ب مصطنع', 'U-A'); // منتحل
  add('AU2', 'عضو أ مصطنع', 'U-A'); // صادق
  add('AU3', 'المالك', 'OWN-10');
  add('AU4', 'هذا الجهاز', null);
  const rows = db.all<{ id: string; user_name: string; writer_uid: string | null; writer_name: string | null }>(
    `SELECT audit_log.id AS id, user_name, rb.uid AS writer_uid, cp.name AS writer_name FROM audit_log ${AUDIT_WRITER_SQL} WHERE audit_log.id LIKE 'AU%' ORDER BY audit_log.id`);
  expect(rows.map((r) => auditWriter(r, 'OWN-10'))).toEqual([
    { name: 'عضو أ مصطنع', mismatch: true },
    { name: 'عضو أ مصطنع', mismatch: false },
    { name: 'المالك', mismatch: false },
    { name: 'هذا الجهاز', mismatch: false },
  ]);
  void logAudit;
  db.close();
});

test('قرار المالك 2026-10-15 «٣»: منع لقطة الشاشة إعدادٌ مطفأ افتراضاً · يُطبَّق عند الإقلاع وعند تغييره', async () => {
  const { getSetting } = await import('@/repos/settings');
  const db = memDb();
  expect(getSetting(db, 'blockScreenshots')).toBe(false);
  db.close();
  expect(src('app/_layout.tsx')).toContain('applyScreenSecureFrom(appDb())');
  expect(src('app/settings.tsx')).toMatch(/updateSetting\('blockScreenshots', !!v\); applyScreenSecure\(!!v\)/);
  expect(src('android/app/src/main/java/com/aqari/app/MainApplication.kt')).toContain('add(AqariSecurePackage())');
  expect(src('android/app/src/main/java/com/aqari/app/AqariSecure.kt')).toContain('FLAG_SECURE');
});

test('قرار المالك 2026-10-15 «٢»: «نسيت الرمز» يؤكد الحساب بقوقل ثم يطلب رمزاً جديداً قبل الفتح', () => {
  const lg = src('src/ui/LockGate.tsx');
  expect(lg).toMatch(/const forgotPin = async[^]*?confirmSameAccount\)\) setResetting\(true\)/);
  expect(lg).toMatch(/const saveNewPin = async[^]*?enablePinLock\(pin1, cfg.delay\);[^]*?onOpen\(\)/);
  expect(lg).toContain("onPress={forgotPin}");
  expect(lg).toMatch(/disabled=\{!pinShapeOk\(pin1\) \|\| pin1 !== pin2\}/);
});

test('٣٤ عنوان المهمة لا يُملأ من نص الرسالة في مجموعة «من لحظة انضمامه»', () => {
  const c = src('app/chat.tsx');
  expect(c).toContain("prefill={thread.settings.h !== 'join'}");
  expect(c).toMatch(/useState\(task\?\.title \?\? \(prefill \? /);
});
