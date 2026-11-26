/**
 * التوجيه الرابع · ٣ · ٢ (دراسة التوسع · المرحلة ٠ · معيار القبول «40 ألف قسط ممسوس بلا خطأ»): قوائم `IN (…)` التي يكبر طولها
 * بالبيانات تُنفَّذ قطعاً (src/db/inList.ts) · كانت أول مزامنة لجهاز جديد تسقط بـ `too many SQL variables` حين يمسّ الوارد أكثر من
 * 32,766 قسطاً (نحو 2,700 عقد سنوي)، ومثلها حذف السلة الجماعي فوق الحد · ونتيجة القطع نتيجة العبارة الواحدة · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput, addBank } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { recomputeInstallments } from '@/domain/contracts/paid';
import { purgeManyFromTrash } from '@/domain/trash';
import { chunks, allIn, runIn, IN_CHUNK } from '@/db/inList';
import { MemoryRemote } from './helpers/memoryRemote';
import { syncOnce, enableSync } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const N = 40000;

/** عقدٌ واحد مصطنع بأربعين ألف قسط (يكفي لعبور الحد · والعدد لا معنى له في العقد) */
function bigContract(db: DB): { contract: string; ids: string[] } {
  const p = addProperty(db, { name: 'عقار حدّ المتغيرات مصطنع' });
  const u = addUnit(db, p, { unit_no: 'IN-1' });
  const c = confirmContract(db, contractInput(u));
  db.run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO contract_installments (id, contract_id, due_date, amount_halalas, paid_halalas, status, sort)
     SELECT 'BIG-' || printf('%06d', i), ?, '2027-01-01', 1000, 0, 'مستحقة', 100 + i FROM n`, [N, c]);
  // نصفها مسدَّدٌ في عمودها بلا دفعة: إعادة الحساب تصفّره وتعيد حالتها، فيُقارَن ناتجها بالحساب الكامل
  db.run(`UPDATE contract_installments SET paid_halalas = 1000, status = 'مدفوعة' WHERE id LIKE 'BIG-%' AND CAST(substr(id, 5) AS INTEGER) % 2 = 0`);
  const ids = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE id LIKE 'BIG-%' ORDER BY id`).map((r) => r.id);
  return { contract: c, ids };
}

describe('التقطيع (src/db/inList.ts)', () => {
  test('القطع بطول IN_CHUNK فأقل، وتجمع القائمة كلها بترتيبها', () => {
    const xs = Array.from({ length: 1234 }, (_, i) => i);
    const cs = chunks(xs);
    expect(cs.every((c) => c.length <= IN_CHUNK)).toBe(true);
    expect(cs.flat()).toEqual(xs);
    expect(chunks([])).toEqual([]);
  });

  test('allIn وrunIn بأربعين ألف معرّف ومعاملاتٍ قبل القائمة وبعدها: كالعبارة الواحدة، والتكرار يُحسب مرة', () => {
    const db = memDb();
    db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, g TEXT, v INTEGER)`);
    db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO t SELECT 'k' || i, CASE WHEN i % 2 THEN 'a' ELSE 'b' END, i FROM n`, [N]);
    const ids = Array.from({ length: N }, (_, i) => 'k' + (i + 1));
    const got = allIn<{ id: string }>(db, `SELECT id FROM t WHERE g = ? AND id IN (:list) AND v > ?`, [...ids, 'k1', 'k2'], ['a'], [10]);
    expect(got.map((r) => r.id).sort()).toEqual(ids.filter((_, i) => (i + 1) % 2 === 1 && i + 1 > 10).sort());
    runIn(db, `UPDATE t SET v = ? WHERE id IN (:list)`, ids, [0]);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM t WHERE v = 0`)!.n).toBe(N);
    expect(() => allIn(db, `SELECT 1 FROM t WHERE id IN (:list) OR id IN (:list)`, ['x'])).toThrow();
  });
});

describe('أربعون ألف قسط ممسوس بلا خطأ', () => {
  test('recomputeInstallments بقائمة أربعين ألفاً: لا خطأ، والناتج كإعادة الحساب للكل', () => {
    const a = memDb();
    const b = memDb();
    const A = bigContract(a);
    bigContract(b);
    const byList = recomputeInstallments(a, A.ids);
    const byAll = recomputeInstallments(b);
    expect(byList.length).toBe(N / 2);
    const rows = (db: DB) => db.all(`SELECT id, paid_halalas, status FROM contract_installments WHERE id LIKE 'BIG-%' ORDER BY id`);
    expect(rows(a)).toEqual(rows(b));
    expect(byList.map((c) => c.installmentId).sort()).toEqual(byAll.filter((c) => c.installmentId.startsWith('BIG-')).map((c) => c.installmentId).sort());
  });

  test('أول مزامنة لجهازٍ جديد يمسّ واردها أربعين ألف قسط: تكتمل بلا خطأ وتطابق المصدر', async () => {
    const r = new MemoryRemote();
    const owner = memDb();
    enableSync(owner, 'owner-inlist');
    bigContract(owner);
    // المصدر متسق: المسدَّد مشتقٌّ من الدفعات (لا دفعات هنا)، فيُعاد حسابه قبل الرفع كما يفعل التطبيق
    recomputeInstallments(owner);
    await syncOnce(owner, r, getMeta(owner, 'device_id')!);
    expect([...r.docs.values()].filter((d) => d.t === 'contract_installments').length).toBeGreaterThanOrEqual(N);
    const fresh = memDb();
    enableSync(fresh, 'owner-inlist');
    for (let i = 0; i < 3; i++) await syncOnce(fresh, r, getMeta(fresh, 'device_id')!);
    const sum = (db: DB) => db.get<{ n: number; s: number; p: number }>(
      `SELECT COUNT(*) AS n, SUM(amount_halalas) AS s, SUM(paid_halalas) AS p FROM contract_installments WHERE id LIKE 'BIG-%'`)!;
    expect(sum(fresh).n).toBe(N);
    expect(sum(fresh)).toEqual(sum(owner));
    expect(fresh.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox`)!.n).toBe(0);
  }, 600000);

  test('حذف السلة الجماعي لأربعين ألف عنصر: لا خطأ، ويُحذف ما في السلة وحده', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك السلة المصطنع');
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, source, created_at, deleted_at)
       SELECT 'TX-' || i, ?, '2026-01-01', 'حركة مصطنعة', 100, 0, 'يدوي', '2026-01-01T00:00:00.000Z',
              CASE WHEN i % 10 = 0 THEN NULL ELSE '2026-02-01T00:00:00.000Z' END FROM n`, [N, bank]);
    const items = Array.from({ length: N }, (_, i) => ({ table: 'bank_tx', id: 'TX-' + (i + 1) }));
    expect(() => purgeManyFromTrash(db, items)).not.toThrow();
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_tx WHERE id LIKE 'TX-%'`)!.n).toBe(N / 10);
  });
});
