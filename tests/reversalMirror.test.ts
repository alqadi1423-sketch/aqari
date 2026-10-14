/**
 * المراجعة الخارجية ٧ · النتيجة ١ (ب) على جهاز المالك (قرار المالك «رابعاً ١ (أ)» 2026-10-10: «والعكس لا يُربط إلا بمرآة
 * حقيقية»): القيد الوارد بـ reversed_by لا يُربط إلا بعاكسٍ مرحّل يقابل سطوره سطراً بسطر بمبالغها مقلوبةً، ومصدره «_rev» أصله ·
 * وعاكسٌ مزوّر بهللة يُرفض الربط به ويُسجَّل في sync_rejects، فلا يُلغى القيد الحقيقي بأثرٍ وهمي · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { postEntry, reverseEntryById } from '@/domain/accounting/post';
import { mirrorIssue } from '@/domain/accounting/mirror';
import { enableSync, syncOnce, docId } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

const UID = 'user-1';
const AT = '2099-01-01T00:00:00.000Z';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const reversedBy = (db: DB, id: string) => db.get<{ r: string | null }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [id])!.r;
const reasonOf = (db: DB, pk: string) => db.get<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE pk = ? ORDER BY id DESC`, [pk])?.reason ?? '';

function original(db: DB) {
  return postEntry(db, { date: '2026-01-01', memo: 'أصل مصطنع', lines: [
    { account: '1100', debit: 100000, credit: 0 }, { account: '4200', debit: 0, credit: 100000 }] })!;
}
/** عاكسٌ مرحّل مزوّر بمصدر أصله الصحيح وسطورٍ يختارها المهاجم */
const fake = (k: string, srcId: string, lines: [string, number, number][]): RemoteDoc => ({
  id: docId('journal_entries', k), t: 'journal_entries', k, u: AT, dev: 'other', del: false,
  d: { id: k, no: 'JE-' + k, date: '2026-01-02', memo: 'عكس مزوّر', status: 'مرحّل', auto: 0, src_type: 'manual_rev', src_id: srcId,
    created_at: 'x', deleted_at: null, reversed_by: null },
  lines: lines.map(([acc, dr, cr], i) => ({ id: k + i, entry_id: k, account_code: acc, descr: '', debit_halalas: dr, credit_halalas: cr })),
});
const linkDoc = (r: MemoryRemote, id: string, revId: string): RemoteDoc => {
  const o = r.docs.get(docId('journal_entries', id))!;
  return { ...o, dev: 'other', u: AT, d: { ...o.d!, reversed_by: revId } };
};

test('١ (ب) عاكسٌ مزوّر بهللة (مصدره صحيح) لا يُربط به القيد على جهاز المالك · ويُسجَّل الرفض', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  const e = original(a);
  await sync(a, r);
  r.inject(fake('FK1', e.id, [['1100', 0, 1], ['4200', 1, 0]]));
  r.inject(linkDoc(r, e.id, 'FK1'));
  await sync(a, r);
  expect(reversedBy(a, e.id)).toBeNull();
  // والعاكس المزوّر نفسه مرفوضٌ لا يدخل الدفتر (الجولة الحادية عشرة: كل عاكسٍ وارد يُفحص أياً كان كاتبه)
  expect(reasonOf(a, 'FK1')).toMatch(/مرآة/);
  expect(a.get(`SELECT 1 FROM journal_entries WHERE id = 'FK1'`)).toBeFalsy();
  a.close();
});

test('١ (ب) والربط المعلّق (وصل الأصل قبل عاكسه المزوّر) لا يُربط حين يصل العاكس', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  const e = original(a);
  await sync(a, r);
  r.inject(linkDoc(r, e.id, 'FK2'));
  await sync(a, r);
  r.inject(fake('FK2', e.id, [['1100', 0, 1], ['4200', 1, 0]]));
  await sync(a, r);
  expect(reversedBy(a, e.id)).toBeNull();
  expect(reasonOf(a, 'FK2')).toMatch(/مرآة/);
  a.close();
});

test('والعكس الحقيقي من جهازٍ آخر يُربط', async () => {
  const r = new MemoryRemote();
  const a = memDb(); const b = memDb();
  enableSync(a, UID); enableSync(b, UID);
  const e = original(a);
  await sync(a, r); await sync(b, r);
  const rev = reverseEntryById(b, e.id)!;
  await sync(b, r); await sync(a, r);
  expect(reversedBy(a, e.id)).toBe(rev.id);
  a.close(); b.close();
});

describe('mirrorIssue', () => {
  test('المرآة بسطورها مقلوبةً · وعكس السنة السابقة على الأرباح المحتجزة · وما سواهما مرفوض بسببه', () => {
    const db = memDb();
    const e = original(db);
    const ins = (k: string, src: string, lines: [string, number, number][], status = 'مرحّل') => {
      db.run(`INSERT INTO journal_entries (id, no, date, memo, status, auto, src_type, src_id, created_at) VALUES (?,?,?,?,'قيد الإنشاء',0,?,?,'x')`,
        [k, 'JE-' + k, '2026-02-01', 'م', src, e.id]);
      for (const [i, [acc, dr, cr]] of lines.entries()) {
        db.run(`INSERT INTO journal_lines (id, entry_id, account_code, descr, debit_halalas, credit_halalas) VALUES (?,?,?,?,?,?)`, [k + i, k, acc, '', dr, cr]);
      }
      if (status === 'مرحّل') db.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = ?`, [k]);
    };
    ins('M1', 'manual_rev', [['4200', 100000, 0], ['1100', 0, 100000]]);
    expect(mirrorIssue(db, e.id, 'M1')).toBe('');
    // إيرادٌ من سنةٍ سابقة يُعكس على الأرباح المحتجزة 3200 (assets/convert.ts: reverseToRetainedIfPrior)
    ins('M2', 'manual_rev', [['3200', 100000, 0], ['1100', 0, 100000]]);
    expect(mirrorIssue(db, e.id, 'M2')).toBe('');
    ins('X1', 'manual_rev', [['4200', 1, 0], ['1100', 0, 1]]);
    expect(mirrorIssue(db, e.id, 'X1')).toMatch(/مرآة/);
    ins('X2', 'manual_rev', [['4200', 50000, 0], ['4200', 50000, 0], ['1100', 0, 100000]]);
    expect(mirrorIssue(db, e.id, 'X2')).toMatch(/مرآة/);
    ins('X3', 'rent_rev', [['4200', 100000, 0], ['1100', 0, 100000]]);
    expect(mirrorIssue(db, e.id, 'X3')).toMatch(/مصدر/);
    // حسابٌ غير دخلٍ لا يُبدَّل بالأرباح المحتجزة
    ins('X4', 'manual_rev', [['4200', 100000, 0], ['3200', 0, 100000]]);
    expect(mirrorIssue(db, e.id, 'X4')).toMatch(/مرآة/);
    ins('X5', 'manual_rev', [['4200', 100000, 0], ['1100', 0, 100000]], 'draft');
    expect(mirrorIssue(db, e.id, 'X5')).toMatch(/مرحّل/);
    expect(mirrorIssue(db, e.id, 'NONE')).toMatch(/غير موجود/);
    db.close();
  });
});

/* ═══ المتحقق المستقل، الجولة العاشرة ═══ */

/** عاكسٌ مرحّل من عضو (بكاتبه) */
const memberRev = (k: string, srcId: string, lines: [string, number, number][]): RemoteDoc => ({ ...fake(k, srcId, lines), by: 'member-1' });

test('١ عاكسٌ مرحّل بلا أصلٍ يعكسه (مصدرٌ مخترع وأي مبلغ) لا يدخل دفتر المالك · ينتظر أصله في الوارد ولا يُرحَّل', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  await sync(a, r);
  r.inject(memberRev('MR1', 'ANY', [['1100', 50000000, 0], ['4200', 0, 50000000]]));
  // وبكاتب المالك نفسه أو بلا كاتب (عضوٌ بـ«كامل» عدّل مسودة غيره فبقي كاتبها · الجولة الحادية عشرة)
  r.inject({ ...memberRev('MR1B', 'ANY', [['1100', 70000000, 0], ['4200', 0, 70000000]]), by: UID });
  r.inject({ ...fake('MR1C', 'ANY', [['1100', 70000000, 0], ['4200', 0, 70000000]]), d: { ...fake('MR1C', 'ANY', []).d!, src_type: 'foo_rev' } });
  await sync(a, r);
  for (const k of ['MR1', 'MR1B', 'MR1C']) expect(a.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [k])).toBeFalsy();
  expect(Number(a.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox WHERE pk IN ('MR1','MR1B','MR1C')`)!.n)).toBe(3);
  a.close();
});

test('١ مرآةٌ حقيقية مكررة لا تضاعف أثر العكس: الأولى تدخل والباقي يُرفض', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  const e = original(a);
  await sync(a, r);
  for (const k of ['MD1', 'MD2', 'MD3']) r.inject(memberRev(k, e.id, [['1100', 0, 100000], ['4200', 100000, 0]]));
  await sync(a, r);
  expect(Number(a.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE src_type = 'manual_rev' AND status = 'مرحّل'`)!.n)).toBe(1);
  expect(reasonOf(a, 'MD2') + reasonOf(a, 'MD3')).toMatch(/أكثر من أصولها/);
  a.close();
});

test('والعاكس الذي وصل قبل أصله (إلغاء عضوٍ قبل مزامنة المالك) ينتظره ثم يُرحَّل ويُربط', async () => {
  const r = new MemoryRemote();
  const a = memDb(); const m = memDb();
  enableSync(a, UID); enableSync(m, UID);
  await sync(a, r);
  const e = original(m);
  const rev = reverseEntryById(m, e.id)!;
  const remDoc = (await import('@/sync/engine')).buildDoc;
  r.inject({ ...remDoc(m, 'journal_entries', rev.id, 'upsert', '2099-01-01T00:00:03.000Z', 'dev-m'), by: 'member-1' });
  r.inject({ ...remDoc(m, 'journal_entries', e.id, 'upsert', '2099-01-01T00:00:05.000Z', 'dev-m'), by: 'member-1' });
  await sync(a, r);
  expect(a.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = ?`, [rev.id])?.s).toBe('مرحّل');
  expect(reversedBy(a, e.id)).toBe(rev.id);
  a.close(); m.close();
});

test('١ وعاكسٌ من عضو لأصلٍ قائم بسطورٍ غير مرآته لا يدخل · ومرآته الحقيقية تدخل', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  const e = original(a);
  await sync(a, r);
  r.inject(memberRev('MR2', e.id, [['1100', 0, 1], ['4200', 1, 0]]));
  await sync(a, r);
  expect(a.get(`SELECT 1 FROM journal_entries WHERE id = 'MR2'`)).toBeFalsy();
  r.inject(memberRev('MR3', e.id, [['1100', 0, 100000], ['4200', 100000, 0]]));
  await sync(a, r);
  expect(a.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = 'MR3'`)?.s).toBe('مرحّل');
  a.close();
});

test('والربط المعلّق المرفوض يُسجَّل مرةً لا في كل دورة', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  const e = original(a);
  await sync(a, r);
  r.inject(linkDoc(r, e.id, 'FK3'));
  await sync(a, r);
  r.inject(fake('FK3', e.id, [['1100', 0, 1], ['4200', 1, 0]]));
  for (let i = 0; i < 3; i++) await sync(a, r);
  expect(Number(a.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE pk IN (?, 'FK3')`, [e.id])!.n)).toBe(1);
  a.close();
});

/* ═══ المتحقق المستقل، الجولة السادسة عشرة: واحدٌ لواحد ═══ */

const srcEntry = (db: DB, amount: number) => postEntry(db, { date: '2026-01-01', memo: 'فاتورة مصطنعة', srcType: 'invoice', srcId: 'INV-X',
  lines: [{ account: '1200', debit: amount, credit: 0 }, { account: '4200', debit: 0, credit: amount }] })!;

test('١ مرآةٌ ثانية لأصلٍ معكوس لا تُقبل ولو بقي للمصدر أصلٌ حي (فاتورةٌ عُدّلت)', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  const o1 = srcEntry(a, 100000);
  reverseEntryById(a, o1.id);
  srcEntry(a, 120000);
  await sync(a, r);
  const b = memDb();
  enableSync(b, UID);
  await sync(b, r);
  const before = Number(b.get<{ n: number }>(`SELECT SUM(credit_halalas - debit_halalas) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
    WHERE l.account_code = '4200' AND e.status = 'مرحّل'`)!.n);
  r.inject({ ...memberRev('R2', 'INV-X', [['1200', 0, 100000], ['4200', 100000, 0]]), d: { ...memberRev('R2', 'INV-X', []).d!, src_type: 'invoice_rev' } });
  await sync(b, r);
  expect(b.get(`SELECT 1 FROM journal_entries WHERE id = 'R2'`)).toBeFalsy();
  expect(Number(b.get<{ n: number }>(`SELECT SUM(credit_halalas - debit_halalas) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
    WHERE l.account_code = '4200' AND e.status = 'مرحّل'`)!.n)).toBe(before);
  a.close(); b.close();
});

test('وأصلان بالمبلغ نفسه أحدهما معكوس: عكس الحي يُقبل', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  const o1 = srcEntry(a, 100000);
  reverseEntryById(a, o1.id);
  srcEntry(a, 100000);
  await sync(a, r);
  const b = memDb();
  enableSync(b, UID);
  await sync(b, r);
  r.inject({ ...memberRev('R3', 'INV-X', [['1200', 0, 100000], ['4200', 100000, 0]]), d: { ...memberRev('R3', 'INV-X', []).d!, src_type: 'invoice_rev' } });
  await sync(b, r);
  expect(b.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = 'R3'`)?.s).toBe('مرحّل');
  a.close(); b.close();
});
