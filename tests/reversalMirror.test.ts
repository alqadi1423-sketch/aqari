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
  expect(reasonOf(a, e.id)).toMatch(/مرآة/);
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
  expect(reasonOf(a, e.id)).toMatch(/مرآة/);
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
