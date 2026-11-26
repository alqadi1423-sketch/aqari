/**
 * المدقق Y · الجولة الثانية عشرة · إحياء سطر الكشف في statementCascade يمحو اعتماداً متزامناً له · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditY.cascadeMatch.test.ts
 *
 * Y7 · منخفض · src/sync/engine.ts:966–980 (statementCascade: إحياء السطر «مفتوحاً» ورفعه بوقت الآن) مع src/sync/engine.ts:1501 (enqueue):
 * كشف A (1–20 أكتوبر) عند الجهازين · العضو يحفظ B (15–31) فيتخطّى سطر 16 أكتوبر (في A)، ثم يعتمد إيداع 16 أكتوبر تحصيلاً لقسط ماجد
 * (دفعةٌ وقيدٌ وحركة بنك، والسطر مطابَقٌ بها) · والمالك بلا اتصال يحذف A (لا يعرف B) · عند المزامنة يصل B جهازَ المالك قبل سطره
 * (الجداول بترتيبها)، فيحيي السطر الميت «مفتوحاً بلا حركة» ويرفعه بوقت الآن · فيغلب تعديلُه المعلَّق نسخةَ العضو «المطابَقة» الأقدم منه،
 * ويعود السطر مفتوحاً على الجهازين، وحركة التحصيل «في الدفاتر وحدها» · وكان الصحيح بالقاعدة نفسها (statementLineCheck): السطر في B
 * مطابَقٌ بحركته.
 * لماذا يهم: اعتمادٌ صريح يضيع بلا أثرٍ ولا تعارضٍ ظاهر، والتقرير يعرض فرقين مفتوحين لإيداعٍ طوبق.
 * السلوك الصحيح: الإحياء لا يمحو حالة السطر الأحدث منه (يُطبَّق الوارد عليه أو يُحيا بحالته)، فيبقى السطر في B مطابَقاً بحركة التحصيل.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, deleteStatement, reconciliation } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const HEAD = ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'];
const stmt = (from: string, to: string, opening: string, rows: string[][]) => {
  const r = readStatementGrid([[`الفترة من ${from} إلى ${to}`], ['الرصيد الافتتاحي', opening], HEAD, ...rows]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); // i18n-exempt: رسالة اختبار
  return r;
};

describe('Y7 · العضو يعتمد تحصيل سطرٍ تخطّاه كشفه، والمالك يحذف كشف السطر بلا اتصال', () => {
  test('بعد المزامنة سطر 16 أكتوبر حيٌّ في B ومطابَقٌ بحركة التحصيل على الجهازين، ولا شيء في الدفاتر وحدها', async () => {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع Y7', 0);
    const prop = addProperty(p.owner, { name: 'عقار مصطنع Y7' });
    confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: 'Y7-1' }), {
      tenant: 'ماجد المصطنع', idNumber: '1000000977', phone: '0500000977', valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-10-16', end: '2027-10-15', depositHalalas: 0,
    }));
    const A = saveStatement(p.owner, bank, stmt('01/10/2026', '20/10/2026', '0.00', [
      ['2026/10/02', 'رسوم مصطنعة', '10.00', '', '-10.00'],
      ['2026/10/16', 'حوالة واردة ماجد', '', '1,000.00', '990.00'],
    ]), { name: 'a.pdf', hash: 'y7-a' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    const B = saveStatement(p.dev, bank, stmt('15/10/2026', '31/10/2026', '-10.00', [
      ['2026/10/16', 'حوالة واردة ماجد', '', '1,000.00', '990.00'],
      ['2026/10/25', 'رسوم مصطنعة', '5.00', '', '985.00'],
    ]), { name: 'b.pdf', hash: 'y7-b' });
    expect([B.added, B.skipped]).toEqual([1, 1]);
    const s = collectionSuggestions(p.dev, bank);
    expect(s.map((x) => [x.line.date, x.level])).toEqual([['2026-10-16', 'ready']]);
    const { txId } = approveCollection(p.dev, s[0].line.id, s[0].target);
    deleteStatement(p.owner, A.statementId);

    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    const devId = getMeta(p.dev, 'device_id');
    for (const d of [...p.r.docs.values()]) if (d.dev === devId) p.r.inject({ ...d, by: MEMBER });
    await ownerPulls(p.owner, p.r);
    await sync(p.dev, p.r);
    await ownerPulls(p.owner, p.r);
    await sync(p.dev, p.r);

    const line16 = (db: DB) => db.get<{ st: string; status: string; tx: string | null; del: string | null }>(
      `SELECT statement_id AS st, status, bank_tx_id AS tx, deleted_at AS del FROM bank_statement_lines WHERE bank_id = ? AND date = '2026-10-16'`, [bank])!;
    const view = (db: DB) => ({ ...line16(db), onlyInBooks: reconciliation(db, bank, '2026-10').onlyInBooks.length });
    // (الواقع: السطر حيٌّ في B «مفتوح» بلا حركة على الجهازين، وحركة التحصيل في الدفاتر وحدها)
    const want = { st: B.statementId, status: 'matched', tx: txId, del: null, onlyInBooks: 0 };
    expect({ owner: view(p.owner), dev: view(p.dev) }).toEqual({ owner: want, dev: want });
    p.close();
  });
});
