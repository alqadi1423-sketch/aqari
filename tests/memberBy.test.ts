/**
 * المراجعة الخارجية ٧ · النتيجة ١ · قرار المالك «رابعاً ١ (أ)» 2026-10-10: «by إلزامي على كل كتابة عضو» و«القيد اليدوي من
 * العضو مسودة حتى يرحّله المالك» · جانب الجهاز (والقواعد في tests/review7.emulator.test.ts) · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty } from './helpers/fixtures';
import { annotate } from '@/sync/acl';
import { enableSync, syncOnce, stageInbox, docId } from '@/sync/engine';
import { saveManualDraft, postDraftEntry, postManualEntry } from '@/domain/accounting/post';
import { getMeta } from '@/repos/settings';
import { migrate } from '@/db/migrations';
import { MIGRATION_42 } from '@/db/schema';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

const M: Access = { owner: false, uid: 'M1', perms: { props: 3, ledger: 2 }, allProps: true, props: [] };
const OWNER: Access = { owner: true, uid: 'OWN', perms: {}, allProps: true, props: [] };
const doc = (t: string, k: string, d: Record<string, unknown>): RemoteDoc =>
  ({ id: docId(t, k), t, k, u: '2026-01-01T00:00:00.000Z', dev: 'd', del: false, d } as RemoteDoc);
const bal = (db: DB, acc: string) => Number(db.get<{ n: number }>(
  `SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas), 0) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
   WHERE e.status = 'مرحّل' AND l.account_code = ?`, [acc])!.n);

describe('«by» على كل كتابة عضو', () => {
  test('صفٌّ أنشأه العضو ولم يُرفع: كاتبه هو · ووارد بكاتبٍ: كاتبه · ووارد بلا كاتب: لا كاتب (القواعد: لا يتغير)', () => {
    const db = memDb();
    const p = addProperty(db, { name: 'عقار مصطنع' });
    const row = db.get<Record<string, unknown>>(`SELECT * FROM properties WHERE id = ?`, [p])!;
    expect(annotate(db, doc('properties', p, row), M).doc.by).toBe('M1');
    stageInbox(db, [{ ...doc('units', 'U1', { id: 'U1' }), by: 'M2' }, doc('units', 'U2', { id: 'U2' })]);
    expect(annotate(db, doc('units', 'U1', { id: 'U1', property_id: p }), M).doc.by).toBe('M2');
    expect(annotate(db, doc('units', 'U2', { id: 'U2', property_id: p }), M).doc.by).toBeUndefined();
    // والمالك كما كان: مسودته وحدها بكاتبها
    expect(annotate(db, doc('properties', p, row), OWNER).doc.by).toBeUndefined();
    db.close();
  });

  test('الهجرة ٤٢: كل صفٍّ قائم «بلا كاتب» (رُفع بلا by) · وما في الطابور لم يُرفع فيُرسَل بكاتبه', () => {
    const db = memDb();
    const old = addProperty(db, { name: 'عقار قديم مصطنع' });
    enableSync(db, 'M1');
    // القديم رُفع (خرج من الطابور) · والجديد في الطابور لم يُرفع
    db.run(`DELETE FROM sync_outbox WHERE tbl = 'properties' AND pk = ?`, [old]);
    const fresh = addProperty(db, { name: 'عقار جديد مصطنع' });
    db.run(`DELETE FROM row_by`);
    db.exec(MIGRATION_42);
    const rb = (pk: string) => db.get<{ uid: string }>(`SELECT uid FROM row_by WHERE tbl = 'properties' AND pk = ?`, [pk])?.uid;
    expect(rb(old)).toBe('');
    expect(rb(fresh)).toBeUndefined();
    expect(annotate(db, doc('properties', old, { id: old }), M).doc.by).toBeUndefined();
    expect(annotate(db, doc('properties', fresh, { id: fresh }), M).doc.by).toBe('M1');
    migrate(db); // على قاعدةٍ بالإصدار الأخير لا يُعاد شيء
    db.close();
  });
});

describe('قيد العضو اليدوي مسودةٌ حتى يرحّله المالك', () => {
  const lines = [{ account: '1100', debit: 50000, credit: 0 }, { account: '4200', debit: 0, credit: 50000 }];

  test('المسودة لا تمسّ الأرصدة · والمالك يرحّلها فتدخلها · ومسودةٌ بمصدر أو مرحّلةٌ لا «تُرحَّل» ثانية', () => {
    const db = memDb();
    const e = saveManualDraft(db, { date: '2026-01-05', memo: 'قيد عضو مصطنع', lines })!;
    expect(db.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = ?`, [e.id])!.s).toBe('قيد الإنشاء');
    expect(bal(db, '1100')).toBe(0);
    postDraftEntry(db, e.id);
    expect(bal(db, '1100')).toBe(50000);
    expect(() => postDraftEntry(db, e.id)).toThrow();
    const posted = postManualEntry(db, { date: '2026-01-06', memo: 'م', lines })!;
    expect(() => postDraftEntry(db, posted.id)).toThrow();
    db.close();
  });

  test('المسودة غير المتوازنة لا تُحفظ (كالمرحّل)', () => {
    const db = memDb();
    expect(() => saveManualDraft(db, { date: '2026-01-05', memo: 'م', lines: [{ account: '1100', debit: 1, credit: 0 }] })).toThrow();
    db.close();
  });

  test('مسودة العضو تعبر المزامنة مسودةً · ويرحّلها المالك فتصل العضو مرحّلة', async () => {
    const r = new MemoryRemote();
    const m = memDb(); const o = memDb();
    enableSync(m, 'U'); enableSync(o, 'U');
    const e = saveManualDraft(m, { date: '2026-01-05', memo: 'قيد عضو مصطنع', lines })!;
    const sync = (db: DB) => syncOnce(db, r, getMeta(db, 'device_id')!);
    await sync(m); await sync(o);
    expect(o.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = ?`, [e.id])!.s).toBe('قيد الإنشاء');
    expect(bal(o, '1100')).toBe(0);
    postDraftEntry(o, e.id);
    await sync(o); await sync(m);
    expect(m.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = ?`, [e.id])!.s).toBe('مرحّل');
    expect(bal(m, '1100')).toBe(50000);
    m.close(); o.close();
  });
});
