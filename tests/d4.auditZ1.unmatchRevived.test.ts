/**
 * المدقق Z1 · الجولة الثالثة عشرة · إبقاء «المطابقة الحيّة هنا» عند إحياء السطر في الكشف المتداخل (إصلاح Y7 · src/sync/engine.ts:952-959) ·
 * بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditZ1.unmatchRevived.test.ts
 *
 * Z1-3 · متوسط · src/sync/engine.ts:956 (here.status !== 'open' && row.status === 'open' ⇒ تُبقى حالة هذا الجهاز وتُرفع «تعديلاً منه»)
 * مع src/sync/engine.ts:1031 (فرع الكشف المحذوف في statementCascade ينقل السطر بحالته): الشرط لا يميّز مطابقةً صنعها هذا الجهاز ولم تُرفع
 * (Y7) من نسخةٍ قديمة وصلته من السحابة · والمالك يطابق إيداع 16 أكتوبر بحركة إيداعٍ نقدي ويرفع، فتصل العضوَ مطابقةً · ثم العضو بلا اتصال
 * يحفظ كشفاً متداخلاً (15–31) فيتخطّى السطر · والمالك يجد المطابقة خطأً فيلغيها ثم يحذف الكشف (والتطبيق يشترط إلغاء المطابقة قبل
 * الحذف: deleteMatched) · عند المزامنة يحيي جهاز العضو السطر في كشفه «مطابَقاً» بنسخته القديمة ويرفعه، فيعود السطر مطابَقاً بالحركة
 * نفسها على الجهازين، وإلغاء المالك الصريح يضيع بلا أثر · وقبل db011e7 كان السطر يعود مفتوحاً.
 * لماذا يهم: كل حذفٍ لكشفٍ فيه مطابقات يمرّ بإلغائها، فأي جهازٍ عنده كشفٌ متداخل يعيدها كلها، ومنها ما ألغاه المالك لأنه خطأ
 * (والحركة تبقى ممسوكةً فلا تُطابق بسطرها الصحيح) · وعضو البنوك ٢ يحاول رفعها فتُرفض «خارج صلاحيتك» ويبقى جهازه مخالفاً.
 * السلوك الصحيح: تُبقى المطابقة المحلية في الإحياء إن كانت تعديلاً لهذا الجهاز لم يُرفع (أو أحدث من الوارد) وحدها، فيبقى السطر مفتوحاً في
 * الكشف المتداخل على الجهازين، وحركة الإيداع «في الدفاتر وحدها».
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { ownerCashIn, depositCashToBank } from '@/domain/cashOps';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, deleteStatement, approveMatch, unmatchLine, matchSuggestions, reconciliation } from '@/domain/bankStatement/store';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

const ORG = 'owner-z1-3';
const HEAD = ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'];
const stmt = (from: string, to: string, opening: string, rows: string[][]) => {
  const r = readStatementGrid([[`الفترة من ${from} إلى ${to}`], ['الرصيد الافتتاحي', opening], HEAD, ...rows]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); // i18n-exempt: رسالة اختبار
  return r;
};
/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) بالبنوك ٣ */
function memberDevice(r: MemoryRemote, uid: string) {
  const M: Access = { owner: false, uid, perms: { banks: 3 }, allProps: true, props: [] };
  const db = memDb();
  enableSync(db, uid);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'عضو مصطنع' } })]);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [ORG]);
  const sync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(db, r, getMeta(db, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  return { db, sync };
}

describe('Z1-3 · [متوسط] مطابقةٌ ألغاها المالك ثم حذف كشفها تعود حيّةً من نسخةٍ قديمة على جهاز عضوٍ عنده كشفٌ متداخل (engine.ts:956)', () => {
  test('بعد المزامنة سطر 16 أكتوبر مفتوحٌ في الكشف المتداخل على الجهازين، وحركة الإيداع في الدفاتر وحدها', async () => {
    const r = new MemoryRemote();
    const O = memDb();
    enableSync(O, ORG);
    const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
    const bank = addBank(O, 'بنك مصطنع Z1-3', 0);
    ownerCashIn(O, { amountHalalas: 500000, date: '2026-10-01' });
    depositCashToBank(O, { bankId: bank, amountHalalas: 100000, date: '2026-10-16', notes: 'إيداع نقدي مصطنع' });
    const A = saveStatement(O, bank, stmt('01/10/2026', '20/10/2026', '0.00', [
      ['2026/10/02', 'رسوم مصطنعة', '10.00', '', '-10.00'],
      ['2026/10/16', 'إيداع نقدي', '', '1,000.00', '990.00'],
    ]), { name: 'a.pdf', hash: 'z1-3-a' });
    const s = matchSuggestions(O, bank);
    expect(s.map((x) => [x.line.date, x.level])).toEqual([['2026-10-16', 'ready']]);
    approveMatch(O, s[0].line.id, s[0].tx.id);
    const line = s[0].line.id;
    await ownerSync();
    const B = memberDevice(r, 'member-z1-3');
    await B.sync(); await B.sync();
    expect(B.db.get<{ s: string }>(`SELECT status AS s FROM bank_statement_lines WHERE id = ?`, [line])!.s).toBe('matched');

    // العضو بلا اتصال يحفظ كشفاً متداخلاً يتخطّى سطر 16 أكتوبر
    const Bst = saveStatement(B.db, bank, stmt('15/10/2026', '31/10/2026', '-10.00', [
      ['2026/10/16', 'إيداع نقدي', '', '1,000.00', '990.00'],
      ['2026/10/25', 'رسوم مصطنعة', '5.00', '', '985.00'],
    ]), { name: 'b.pdf', hash: 'z1-3-b' });
    expect([Bst.added, Bst.skipped]).toEqual([1, 1]);
    await new Promise((res) => setTimeout(res, 5));
    // والمالك يلغي المطابقة (خطأ) ثم يحذف الكشف، كما يشترط التطبيق
    unmatchLine(O, line);
    deleteStatement(O, A.statementId);
    for (let i = 0; i < 3; i++) { await ownerSync(); await ownerSync(); await B.sync(); }

    const view = (db: DB) => ({
      ...db.get<{ st: string; status: string; tx: string | null; del: string | null }>(
        `SELECT statement_id AS st, status, bank_tx_id AS tx, deleted_at AS del FROM bank_statement_lines WHERE id = ?`, [line])!,
      onlyInBooks: reconciliation(db, bank, '2026-10').onlyInBooks.length,
    });
    // (الواقع: السطر «مطابَق» بالحركة نفسها على الجهازين، ولا شيء في الدفاتر وحدها: إلغاء المالك ضاع)
    const want = { st: Bst.statementId, status: 'open', tx: null, del: null, onlyInBooks: 1 };
    expect({ owner: view(O), member: view(B.db) }).toEqual({ owner: want, member: want });
    O.close(); B.db.close();
  });
});
