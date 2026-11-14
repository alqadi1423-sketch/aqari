/**
 * المدقق Z1 · الجولة الثالثة عشرة · علامات «تصحيح سطر الكشف» على جهاز المالك (إصلاح Y7 · src/sync/engine.ts:983-999 و1756) ·
 * بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditZ1.staleFix.test.ts
 *
 * Z1-6 · منخفض · src/sync/engine.ts:1746 و1913 (الطابور يُمحى حين يتفق الطرفان أو يغلب الوارد) مع src/sync/engine.ts:2527 (العلامة لا تُرفع
 * إلا عند رفع الصف): عضوٌ (البنوك ٣) يحذف كشفاً، فيصحّح جهاز المالك سطوره تبعاً لكشفها (statementCascade) ويعلّمها «تصحيحاً»، ثم يصل
 * حذف السطور نفسها بالمحتوى نفسه فيُمحى الطابور «الطرفان متفقان» وتبقى العلامة · وتبقى إلى الأبد، ولو أُعيد الكشف نفسه (المعرّفات
 * حتمية) · فاعتمادٌ حقيقيٌّ لاحق من المالك على السطر يُعامَل «تصحيحاً» يغلبه أي واردٍ ولو أقدم منه: العضو بلا اتصال يستبعد الإيداع،
 * ثم المالك بعده يطابقه بحركته، فتغلب نسخة العضو الأقدم ويضيع اعتماد المالك على الجهازين · والعلامات تتراكم في sync_state بلا حد.
 * لماذا يهم: «الأحدث يغلب» ينقلب على جهاز المالك وحده لسطورٍ مسّها تصحيحٌ قديم مضى، بلا أثرٍ ولا تعارضٍ ظاهر.
 * السلوك الصحيح: العلامة تزول حين يزول التصحيح من الطابور بأي طريق، فيغلب اعتماد المالك الأحدث ويبقى السطر مطابَقاً على الجهازين.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { ownerCashIn, depositCashToBank } from '@/domain/cashOps';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, deleteStatement, approveMatch, excludeLine, matchSuggestions } from '@/domain/bankStatement/store';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

const ORG = 'owner-z1-6';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

describe('Z1-6 · [منخفض] علامة «التصحيح» تبقى بعد زوال التصحيح، فيغلب واردٌ أقدم اعتمادَ المالك الأحدث (engine.ts:1746 · 1756)', () => {
  test('عضوٌ حذف الكشف وأعاده، ثم استبعد الإيداع بلا اتصال، والمالك طابقه بعده: لا علامة باقية، والسطر مطابَقٌ على الجهازين', async () => {
    const r = new MemoryRemote();
    const O = memDb();
    enableSync(O, ORG);
    const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
    const bank = addBank(O, 'بنك مصطنع Z1-6', 0);
    ownerCashIn(O, { amountHalalas: 500000, date: '2026-10-01' });
    depositCashToBank(O, { bankId: bank, amountHalalas: 100000, date: '2026-10-16', notes: 'إيداع نقدي مصطنع' });
    const oct = () => {
      const x = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
        ['2026/10/02', 'رسوم مصطنعة', '10.00', '', '-10.00'], ['2026/10/16', 'إيداع نقدي', '', '1,000.00', '990.00']]);
      if (!x.ok) throw new Error(x.error);
      return x;
    };
    const S = saveStatement(O, bank, oct(), { name: 'oct-z1-6.csv', hash: 'z1-6' });
    await ownerSync();
    const M = memberDevice(r, 'member-z1-6');
    await M.sync(); await M.sync();
    // العضو يحذف الكشف (قرأه بربطٍ خطأ مثلاً) ثم يعيد قراءته
    deleteStatement(M.db, S.statementId);
    await M.sync();
    await ownerSync(); await ownerSync();
    saveStatement(M.db, bank, oct(), { name: 'oct-z1-6.csv', hash: 'z1-6' });
    await M.sync();
    await ownerSync(); await ownerSync();
    await M.sync();
    const line = O.get<{ id: string }>(`SELECT id FROM bank_statement_lines WHERE date = '2026-10-16' AND deleted_at IS NULL`)!.id;
    const marks = () => JSON.parse(O.get<{ v: string }>(`SELECT v FROM sync_state WHERE k = 'stmt_line_fixes'`)?.v ?? '[]') as string[];
    const staleBefore = marks().length;

    // العضو بلا اتصال يستبعد الإيداع، والمالك بعده يطابقه بحركته
    excludeLine(M.db, line, 'ليس لنا (مصطنع)');
    await wait(10);
    const s = matchSuggestions(O, bank);
    expect(s.map((x) => x.line.id)).toEqual([line]);
    approveMatch(O, line, s[0].tx.id);
    await M.sync();
    for (let i = 0; i < 2; i++) { await ownerSync(); await ownerSync(); await M.sync(); }

    const view = (db: DB) => db.get<{ status: string; tx: string | null }>(`SELECT status, bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [line])!;
    // (الواقع: علامتان باقيتان على جهاز المالك قبل الاعتماد، واستبعاد العضو الأقدم يغلب مطابقة المالك على الجهازين)
    expect({ staleBefore, owner: view(O), member: view(M.db) })
      .toEqual({ staleBefore: 0, owner: { status: 'matched', tx: s[0].tx.id }, member: { status: 'matched', tx: s[0].tx.id } });
    O.close(); M.db.close();
  });
});
