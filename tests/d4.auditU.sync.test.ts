/**
 * المدقق الخارجي U · الجولة العاشرة · كشف البنك في المزامنة: جهاز المالك يطبّق سطور الكشف الواردة بلا أي حارس (لا مثيل لـmemberBankTxCheck)
 * فشروط approveMatch (حركةٌ حيّة من البنك نفسه بالمبلغ نفسه، غير مطابَقةٍ بسطرٍ آخر) لا تُفحص على الوارد · بياناتٌ مصطنعة.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditU.sync.test.ts
 */
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { depositCashToBank, ownerCashIn } from '@/domain/cashOps';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, approveMatch, reconciliation } from '@/domain/bankStatement/store';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';

const grid = (rows: string[][]) => {
  const r = readStatementGrid([['الفترة من 01/10/2026 إلى 31/10/2026'], ['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'], ...rows]);
  if (!r.ok) throw new Error(r.error);
  return r;
};
const linesOf = (db: DB, bank: string) => db.all<{ id: string; descr: string }>(`SELECT id, descr FROM bank_statement_lines WHERE bank_id = ? ORDER BY date, rowid`, [bank]);
const matchedTo = (db: DB, tx: string) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_statement_lines WHERE bank_tx_id = ? AND status = 'matched' AND deleted_at IS NULL`, [tx])!.n);

async function setup() {
  const p = await pair();
  const A = addBank(p.owner, 'بنك أ مصطنع U', 0);
  const B = addBank(p.owner, 'بنك ب مصطنع U', 0);
  ownerCashIn(p.owner, { amountHalalas: 5000000, date: '2026-09-01' });
  depositCashToBank(p.owner, { bankId: A, amountHalalas: 50000, date: '2026-10-05', notes: 'إيداع مصطنع' });
  depositCashToBank(p.owner, { bankId: B, amountHalalas: 70000, date: '2026-10-06', notes: 'إيداع في ب مصطنع' });
  // في كشف أ إيداعان بـ500 في اليوم نفسه، والدفاتر فيها واحدٌ فقط (الثاني لم يُسجَّل بعد)
  saveStatement(p.owner, A, grid([
    ['2026/10/05', 'إيداع مصطنع', '', '500.00', '500.00'],
    ['2026/10/05', 'إيداع مصطنع', '', '500.00', '1,000.00'],
    ['2026/10/07', 'حوالة مصطنعة', '', '300.00', '1,300.00'],
  ]), { name: 'a-oct.csv', hash: 'u-sync-a' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  const txA = p.owner.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ?`, [A])!.id;
  const txB = p.owner.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ?`, [B])!.id;
  return { ...p, A, B, txA, txB };
}

describe('U٢٣ · المطابقة في المزامنة بلا حارس على جهاز المالك', () => {
  test('جهازان يعتمدان الحركة نفسها لسطرين مختلفين بلا اتصال: بعد المزامنة الحركة مطابَقةٌ بسطرين', async () => {
    const s = await setup();
    const [l1, l2] = linesOf(s.owner, s.A);
    approveMatch(s.owner, l1.id, s.txA);
    approveMatch(s.dev, l2.id, s.txA);
    await sync(s.dev, s.r);
    await ownerPulls(s.owner, s.r);
    await sync(s.dev, s.r);
    // الصحيح: الحركة لسطرٍ واحد (approveMatch: txTaken) · فالثاني يُرفض عند الاستقبال أو يعود مفتوحاً
    expect([matchedTo(s.owner, s.txA), matchedTo(s.dev, s.txA)]).toEqual([1, 1]);
    // وأثره: سطر الإيداع الثاني (500) لا يظهر في «في الكشف لا في الدفاتر» فيصير الفرق «غير مفسَّر» بلا سطر
    const rep = reconciliation(s.owner, s.A, '2026-10');
    expect(rep.onlyInStatement.map((l) => l.amount)).toContain(50000);
    s.close();
  });

  test('سطرٌ وارد من عضو «مطابَق» بحركةٍ في بنكٍ آخر وبمبلغٍ آخر يُطبَّق كما هو، فتختفي حركة البنك الآخر من تقريره', async () => {
    const s = await setup();
    const l3 = linesOf(s.dev, s.A)[2];
    // ما لا يجيزه approveMatch (بنكٌ آخر ومبلغٌ آخر) يكتبه جهاز العضو مباشرةً، والقواعد تجيز لمن له البنوك ٣ تعديل الصف كله
    s.dev.run(`UPDATE bank_statement_lines SET status = 'matched', bank_tx_id = ?, matched_at = '2026-11-07T00:00:00.000Z' WHERE id = ?`, [s.txB, l3.id]);
    await sync(s.dev, s.r);
    const d = [...s.r.docs.values()].find((x) => x.t === 'bank_statement_lines' && x.k === l3.id)!;
    const { ts: _ts, ...doc } = d as RemoteDoc & { ts: string };
    s.r.inject({ ...doc, by: MEMBER, op: 'banks' } as RemoteDoc);
    await ownerPulls(s.owner, s.r);
    // الصحيح: جهاز المالك يرفض سطراً مطابَقاً بحركةٍ من غير بنكه أو بغير مبلغه (شروط approveMatch نفسها)
    expect(s.owner.get<{ status: string }>(`SELECT status FROM bank_statement_lines WHERE id = ?`, [l3.id])!.status).toBe('open');
    expect(reconciliation(s.owner, s.B, '2026-10').onlyInBooks.map((t) => t.id)).toEqual([s.txB]);
    s.close();
  });
});
