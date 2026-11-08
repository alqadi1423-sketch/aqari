/**
 * المدقق A2 · الجولة الرابعة عشرة · على 52f19cb · شرط «البصمة نفسها» (SAME_KEY_SQL) لا يستعمل فهرس البصمة، فيمسح سطور البنك كلها لكل سطرٍ
 * وارد ولكل بصمةٍ في الكشف الوارد · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditA2.sameKeyPerf.test.ts
 *
 * A2-7 · متوسط · src/domain/bankStatement/dedupe.ts:40-41 (SAME_KEY_SQL: «col = ? OR (CASE … substr(col …) = ? …)» فلا يبحث الفهرس
 * ix_bsl_bank(bank_id, line_key) إلا بالبنك) مع src/sync/engine.ts:972-984 (statementLineFix: بحث «التوأم» لكل سطرٍ حيٍّ وارد) و
 * engine.ts:1064-1066 (statementCascade: عبارتان لكل بصمةٍ في shared_keys لكل صفّ كشفٍ حيٍّ وارد) وengine.ts:1046-1050 (sharingStatement):
 * كان البحث «line_key = ?» بالفهرس (EXPLAIN: «bank_id=? AND line_key=?»)، وصار مسحاً لكل سطور البنك («bank_id=?») · فتطبيق كشف شهرٍ واحد
 * (400 سطر) على جهازٍ في بنكه تاريخ عشرين ألف سطر (خمس سنواتٍ لمكتبٍ متوسط) يأخذ على Node نحو 4.7 ثانية مقابل 0.1 ثانية لبنكٍ بلا تاريخ
 * (نحو 40 ضعفاً)، ويكبر بمربع الحجم: أول مزامنةٍ لجهازٍ جديد تطبّق السطور كلها فيمسح كلٌّ منها ما قبله.
 * لماذا يهم: المزامنة على خيط الواجهة على الجوال (Hermes وexpo-sqlite أبطأ من Node بأضعاف): كل كشفٍ شهري يجمّد كل جهازٍ ثوانيَ تكبر مع
 * عمر البنك، وأول دخولٍ لجهازٍ جديد دقائق.
 * السلوك الصحيح: البحث بالبصمة بالفهرس (البصمة نفسها، أو قاعدتها بلاحقةٍ أو بلا لاحقة بمدى نصّي) فيبقى زمن تطبيق الكشف شبه ثابتٍ مع عمر
 * البنك: الكشف نفسه على البنك الكبير في أقل من أربعة أضعاف زمنه على البنك الفارغ (وربع ثانيةٍ هامشاً للضجيج).
 */
import { pair, sync } from './helpers/rederive';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { fnv64 } from '@/domain/bankStatement/dedupe';
import type { DB } from '@/db/adapter';

const BANK = 'B_a27_bank';
/** كشف مارس بـ400 حوالة واردة بأرصدتها */
function march() {
  const rows: string[][] = [];
  let bal = 0;
  for (let i = 0; i < 400; i++) {
    const a = 150000 + i;
    bal += a;
    rows.push([`2027/03/${String(1 + Math.floor((i * 28) / 400)).padStart(2, '0')}`, 'حوالة واردة مصطنعة ' + i, '', (a / 100).toFixed(2), (bal / 100).toFixed(2)]);
  }
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'], ...rows]);
  if (!r.ok) throw new Error(r.error);
  return r;
}
/** تاريخ البنك على الجهازين كما لو تزامن من زمن: كشفٌ قديم بسطوره، مرفوعٌ من قبل */
function history(db: DB, n: number) {
  db.run(`INSERT INTO banks (id, name, opening_halalas, opening_date, created_at) VALUES (?,?,?,?,?)`, [BANK, 'بنك مصطنع A2-7', 0, '2022-01-01', '2022-01-01T00:00:00.000Z']);
  db.run(`INSERT INTO bank_statements (id, bank_id, period_from, period_to, opening_halalas, closing_halalas, file_name, file_hash, line_count, mapping, verified, shared_keys, created_at)
          VALUES ('st_a27_old', ?, '2022-01-01', '2026-12-31', 0, 0, 'old.csv', 'a27-old', ?, '', 1, '[]', '2027-01-01T00:00:00.000Z')`, [BANK, n]);
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      db.run(`INSERT INTO bank_statement_lines (id, statement_id, bank_id, line_key, date, value_date, descr, ref, amount_halalas, balance_halalas, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ['sl_a27_' + i, 'st_a27_old', BANK, fnv64('a27|' + i) + '@' + (100000 + i), '2026-12-01', null, 'حركة قديمة مصطنعة', null, 1000 + i, 100000 + i, '2027-01-01T00:00:00.000Z']);
    }
  });
  db.run(`DELETE FROM sync_outbox`);
}
/** زمن تطبيق كشف مارس على الجهاز الثاني (ملي ثانية) */
async function applyMarch(old: number): Promise<number> {
  const p = await pair();
  history(p.owner, old);
  history(p.dev, old);
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  saveStatement(p.owner, BANK, march(), { name: 'mar-2027.csv', hash: 'a27-mar' });
  await sync(p.owner, p.r);
  const t0 = Date.now();
  await sync(p.dev, p.r);
  const ms = Date.now() - t0;
  // السطور كلها طُبّقت
  expect(Number(p.dev.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_statement_lines WHERE statement_id != 'st_a27_old' AND deleted_at IS NULL`)!.n)).toBe(400);
  p.close();
  return ms;
}

test('A2-7 · [متوسط] كشف شهرٍ (400 سطر) على بنكٍ تاريخه عشرون ألف سطر يُطبَّق في أقل من أربعة أضعاف زمنه على بنكٍ فارغ', async () => {
  await applyMarch(0); // إحماء
  const empty = await applyMarch(0);
  const big = await applyMarch(20000);
  // (الواقع على Node: نحو 110 ملي ثانية للفارغ و4,700 للكبير)
  expect({ empty, big, within: big < 4 * empty + 250 }).toEqual({ empty, big, within: true });
}, 600000);
