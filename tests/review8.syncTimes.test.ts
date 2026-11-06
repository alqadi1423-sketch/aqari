/**
 * المراجعة الشاملة (الالتزام ac76adc) · البنود ١٣ و١٤ و١٥ و١٦ في محرّك المزامنة · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce, docId, applyInbox, stageInbox } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';
import { saveAccount } from '@/domain/accounting/chart';
import { postManualEntry, reverseEntryById } from '@/domain/accounting/post';

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

/* ═══ تتمة المراجعة الأخيرة: ما انتظر غير مفاتيح جدوله (حساب سطور القيد، أصل العاكس، نسخة الابن) يعود حين يصل ═══ */

const WAIT_REJECT = 'سجل أب غير موجود بعد محاولات متكررة';
const posted = (db: DB, id: string) => db.get<{ s: string; r: string | null }>(`SELECT status AS s, reversed_by AS r FROM journal_entries WHERE id = ?`, [id]);
const waitingIn = (db: DB) => db.all<{ pk: string }>(`SELECT pk FROM sync_inbox`).map((x) => x.pk);
/** يطيل انتظار ما في الصندوق فوق المهلة ثم يطبّق: يُرفض لطول انتظاره */
const outwait = (db: DB) => {
  db.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  return applyInbox(db, 'this-device');
};
const legacyReject = (db: DB, doc: RemoteDoc) => db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`,
  [doc.id, doc.t, doc.k, WAIT_REJECT, JSON.stringify(doc), '2026-02-03T00:00:00.000Z']);

/** جهاز المالك يرحّل قيداً يدوياً بحسابين جديدين (ومعه عاكسه إن طُلب) ويرفع · ويُعاد ما في السحابة بمعرّفه */
async function ledger(opts: { newAccounts: boolean; reverse: boolean }) {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  const [dr, cr] = opts.newAccounts ? ['5999', '3999'] : ['1100', '3100'];
  if (opts.newAccounts) {
    saveAccount(a, { code: '5999', name: 'مصروف مصطنع', type: 'مصروف', openingHalalas: 0 });
    saveAccount(a, { code: '3999', name: 'حقوق مصطنعة', type: 'حقوق ملكية', openingHalalas: 0 });
  }
  const e = postManualEntry(a, { date: '2026-02-01', memo: 'قيد مصطنع', lines: [{ account: dr, debit: 1000, credit: 0 }, { account: cr, debit: 0, credit: 1000 }] })!;
  const rev = opts.reverse ? reverseEntryById(a, e.id)! : null;
  await sync(a, r);
  a.close();
  const doc = (t: string, k: string) => r.docs.get(docId(t, k))!;
  return { e: e.id, rev: rev?.id ?? '', doc };
}

test('١٤ (المراجعة الأخيرة) قيدٌ رُفض لطول انتظار حسابٍ في سطوره وحدها يعود حين يصل الحساب ويُطبَّق', async () => {
  const { e, doc } = await ledger({ newAccounts: true, reverse: false });
  const c = memDb();
  enableSync(c, UID);
  stageInbox(c, [doc('journal_entries', e)]);
  applyInbox(c, 'this-device');
  expect(waitingIn(c)).toEqual([e]);
  outwait(c);
  expect(rejects(c, e)).toBe(1);
  // وصل الحسابان: القيد يعود ويُرحَّل
  stageInbox(c, [doc('accounts', '5999'), doc('accounts', '3999')]);
  applyInbox(c, 'this-device');
  expect(posted(c, e)?.s).toBe('مرحّل');
  expect(rejects(c, e)).toBe(0);
  expect(waitingIn(c)).toEqual([]);
  c.close();
});

test('١٤ (المراجعة الأخيرة) ومن إصدارٍ سابق: القيد وعاكسه المرفوضان لانتظار حسابهما يعودان معاً حين يصل · والقيد لا ينتظر عاكسه', async () => {
  const { e, rev, doc } = await ledger({ newAccounts: true, reverse: true });
  const c = memDb();
  enableSync(c, UID);
  // القيد يحمل معرّف عاكسه، والعاكس ينتظر أصله · وكلاهما مرفوضٌ بالانتظار
  expect((doc('journal_entries', e).d as Record<string, unknown>).reversed_by).toBe(rev);
  legacyReject(c, doc('journal_entries', e));
  legacyReject(c, doc('journal_entries', rev));
  stageInbox(c, [doc('accounts', '5999'), doc('accounts', '3999')]);
  applyInbox(c, 'this-device');
  expect(posted(c, e)).toEqual({ s: 'مرحّل', r: rev });
  expect(posted(c, rev)?.s).toBe('مرحّل');
  expect(rejects(c, e) + rejects(c, rev)).toBe(0);
  expect(waitingIn(c)).toEqual([]);
  c.close();
});

test('١٤ (المراجعة الأخيرة) والعاكس المرفوض لطول انتظار أصله (لا مفتاح أجنبياً ينتظره) يعود حين يصل الأصل', async () => {
  const { e, rev, doc } = await ledger({ newAccounts: false, reverse: true });
  const c = memDb();
  enableSync(c, UID);
  stageInbox(c, [doc('journal_entries', rev)]);
  applyInbox(c, 'this-device');
  expect(waitingIn(c)).toEqual([rev]);
  outwait(c);
  expect(rejects(c, rev)).toBe(1);
  stageInbox(c, [doc('journal_entries', e)]);
  applyInbox(c, 'this-device');
  expect(posted(c, rev)?.s).toBe('مرحّل');
  expect(posted(c, e)).toEqual({ s: 'مرحّل', r: rev });
  expect(rejects(c, rev)).toBe(0);
  c.close();
});

test('١٤ (المراجعة الأخيرة) وما يُعاد على التجربة ولم يصل ما ينتظره يرجع إلى المرفوض بصمت: لا يُعدّ ولا يُسجَّل ثانيةً ولا يبقى في الصندوق', async () => {
  const { rev, doc } = await ledger({ newAccounts: false, reverse: true });
  const c = memDb();
  enableSync(c, UID);
  legacyReject(c, doc('journal_entries', rev));
  const audits = () => Number(c.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log`)!.n);
  const before = audits();
  for (let i = 0; i < 3; i++) {
    // صفٌّ آخر يصل في كل دورة فيتقدّم التطبيق
    stageInbox(c, [propDoc('P-PROBE' + i)]);
    const out = applyInbox(c, 'this-device');
    expect(out.rejected).toBe(0);
  }
  expect(rejects(c, rev)).toBe(1);
  expect(waitingIn(c)).toEqual([]);
  expect(audits()).toBe(before);
  expect(posted(c, rev)).toBeUndefined();
  c.close();
});

test('١٤ (المراجعة الأخيرة) وحذفٌ رُفض لطول انتظار نسخة ابنه يعود حين تعود نسخة الابن وتُطبَّق', () => {
  const db = memDb();
  enableSync(db, UID);
  stageInbox(db, [propDoc('P-OLD4')]);
  stageInbox(db, [unitDoc('UW4', 'P-OLD4')]);
  applyInbox(db, 'this-device');
  // المالك نقل الوحدة إلى عقارٍ جديد لم يصل بعد ثم حذف القديم
  const moved = { ...unitDoc('UW4', 'P-NEW4'), u: '2026-02-05T00:00:00.000Z', ts: '2026-02-05T00:00:00.000Z' };
  const tomb: RemoteDoc = { id: docId('properties', 'P-OLD4'), t: 'properties', k: 'P-OLD4', u: '2026-02-06T00:00:00.000Z',
    ts: '2026-02-06T00:00:00.000Z', dev: 'other', del: true, d: null, dby: UID };
  stageInbox(db, [moved, tomb]);
  applyInbox(db, 'this-device');
  expect(waitingIn(db).sort()).toEqual(['P-OLD4', 'UW4']);
  outwait(db);
  expect(rejects(db, 'UW4') + rejects(db, 'P-OLD4')).toBe(2);
  // وصل العقار الجديد: تُطبَّق الوحدة عليه ثم يُحذف القديم
  stageInbox(db, [propDoc('P-NEW4')]);
  applyInbox(db, 'this-device');
  expect(db.get(`SELECT property_id AS p FROM units WHERE id = 'UW4'`)).toEqual({ p: 'P-NEW4' });
  expect(db.get(`SELECT 1 FROM properties WHERE id = 'P-OLD4'`)).toBeFalsy();
  expect(rejects(db, 'UW4') + rejects(db, 'P-OLD4')).toBe(0);
  expect(waitingIn(db)).toEqual([]);
  db.close();
});

const tdoc = (phone: string, u: string, ts?: string): RemoteDoc => ({ id: docId('tenants', 'T16'), t: 'tenants', k: 'T16', u, ...(ts ? { ts } : {}),
  dev: 'other', del: false, d: { id: 'T16', name: 'مستأجر مصطنع', vat: '', phone, credit_halalas: 0, archived: 0, created_at: '2026-01-01T00:00:00.000Z', deleted_at: null } });

test('١٦ الوارد الأقدم بدقة كسورٍ أقصر لا يحلّ محل الأحدث في الصندوق ("…00.12Z" أقدم من "…00.123Z")', () => {
  const db = memDb();
  enableSync(db, UID);
  stageInbox(db, [tdoc('0500000162', '2026-03-01T10:00:00.123Z', '2026-03-01T10:00:00.123Z')]);
  stageInbox(db, [tdoc('0500000161', '2026-03-01T10:00:00.12Z', '2026-03-01T10:00:00.12Z')]);
  const staged = JSON.parse(db.get<{ p: string }>(`SELECT payload AS p FROM sync_inbox WHERE pk = 'T16'`)!.p) as RemoteDoc;
  expect((staged.d as Record<string, unknown>).phone).toBe('0500000162');
  db.close();
});

test('١٦ التعارض يُحسم باللحظة لا بالنص: تعديل الجهاز في …00.995 أحدث من الوارد في …00.99', () => {
  const db = memDb();
  enableSync(db, UID);
  tenant(db, 'T16', '0500000160');
  db.run(`DELETE FROM sync_outbox`);
  // بعد الانضمام (في الانضمام يغلب ما في الحساب)
  db.run(`DELETE FROM sync_state WHERE k = 'joining'`);
  db.run(`UPDATE tenants SET phone = '0500000169' WHERE id = 'T16'`);
  db.run(`UPDATE sync_outbox SET changed_at = '2026-03-01T10:00:00.995Z' WHERE tbl = 'tenants' AND pk = 'T16'`);
  stageInbox(db, [tdoc('0500000168', '2026-03-01T10:00:00.99Z', '2026-03-01T10:00:00.99Z')]);
  applyInbox(db, 'this-device');
  expect(phoneOf(db, 'T16')).toBe('0500000169');
  db.close();
});

test('١٦ وقت الخادم بصفرٍ أو ثلاثة أو ستة أو تسعة أجزاء: المقارنة باللحظة', async () => {
  const { isoCmp, isoNorm, isoMs } = await import('@/sync/isoTime');
  expect(isoCmp('2026-03-01T10:00:00Z', '2026-03-01T10:00:00.500Z')).toBe(-1);
  expect(isoCmp('2026-03-01T10:00:00.99Z', '2026-03-01T10:00:00.995Z')).toBe(-1);
  expect(isoCmp('2026-03-01T10:00:00.123456789Z', '2026-03-01T10:00:00.123Z')).toBe(0);
  expect(isoNorm('2026-03-01T10:00:00.12Z')).toBe('2026-03-01T10:00:00.120Z');
  expect(isoNorm('2026-03-01T13:00:00+03:00')).toBe('2026-03-01T10:00:00.000Z');
  expect(Number.isNaN(isoMs('ليس وقتاً'))).toBe(true);
});
