/**
 * المدقق B2 · الجولة الرابعة عشرة · على 52f19cb · «سطر الكشف على القيد» (stmt_line_id · الهجرة ٥٩) يكتبه العضو كما يشاء · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditB2.forgedLine.test.ts
 *
 * B2-1 · عالٍ · src/sync/engine.ts:1820-1826 (حارس «الإيداع الواحد يسند تحصيلاً واحداً») مع src/sync/engine.ts:1528-1529 (applyJournal ينسخ
 * stmt_line_id من المستند كما هو) وsrc/domain/accounting/deriveSources.ts (لا يفحصه): الحارس يعدّ أي قيدٍ حيٍّ مرحّل يحمل معرّف السطر
 * «تحصيلاً» له ولا يسأل هل هو تحصيلٌ من ذلك السطر أصلاً (حركة بنكٍ في بنك السطر بمبلغه وتاريخه) · فعضوٌ يكتب على قيدٍ عادي له (دفعةٌ
 * نقدية لمستأجرٍ آخر) معرّفَ سطر إيداعٍ مفتوح، فيقبله جهاز المالك لأن قيده صحيح، ثم يعتمد عضوٌ آخر الإيداع لصاحبه اعتماداً صحيحاً: يُرفض
 * «تحصيلاً ثانياً» وتسقط معه دفعته وحركته، والسطر مفتوح، والبنك في الدفاتر صفر والكشف 1,000، وقسط ماجد غير مسدَّد وهو دفعه.
 * لماذا يهم: حقلٌ لا يتحقق منه أحد يكفي لإسقاط أي تحصيلٍ من الكشف يسجّله الأعضاء (وتكرار ذلك لكل إيداع)، والمستأجر يُطالَب بما دفع.
 * السلوك الصحيح: قيدٌ لا يكون تحصيلاً من السطر لا يحجز السطر: تحصيل العضو الصحيح يُقبل، والبنك 1,000 والسطر مطابَقٌ بحركته.
 *
 * B2-2 · عالٍ · src/sync/engine.ts:996-1003 (statementLineFix: «يُطابَق بحركة ذلك التحصيل» يثق بـ stmt_line_id، ولا يقارن التاريخ، ويعود قبل فحص
 * من يمسك الحركة) مع engine.ts:1005-1012 (التنازع على الحركة بالأصغر معرّفاً): العضو المزوِّر يعتمد إيداع سالم (5 أكتوبر) لقسطه اعتماداً
 * صحيحاً، ثم يكتب على قيده معرّف سطر إيداع ماجد (2 أكتوبر) · فحين يُرفض تحصيل ماجد الصحيح (B2-1) يُعاد ربط سطر ماجد بحركة سالم (بنكها
 * ومبلغها كسطره) وهي ممسوكةٌ بسطر سالم، ثم يُطرد سطر سالم إن كان معرّف سطر ماجد أصغر (نصف الحالات بمعرّف البنك، والاختبار
 * يثبّته): إيداع ماجد «مطابَق» بتحصيل سالم، وإيداع سالم مفتوحٌ «في الكشف وحده» يدعو إلى تحصيله ثانيةً، والتقرير بلا فرقٍ غير مفسَّر.
 * لماذا يهم: المطابقة تكذب بصمت: الإيداعان منسوبان خطأً، والمستخدم يُدفع إلى تحصيل سالم مرتين بينما يبقى ماجد مديناً.
 * السلوك الصحيح: سطر سالم يبقى مطابَقاً بحركة تحصيله، وسطر ماجد لا يُربط بحركةٍ لإيداعٍ آخر يمسكها سطرٌ غيره.
 */
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { sync, ownerPulls, MEMBER, UID } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync } from '@/sync/engine';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { fnv64, statementLineKeys } from '@/domain/bankStatement/dedupe';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const HEAD = ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'];
function grid(rows: string[][]) {
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], HEAD, ...rows]);
  if (!r.ok) throw new Error(r.error);
  return r;
}
/** جهاز المالك وجهازا عضوين (المزوِّر m1 والأمين m2) على الحساب نفسه · ما يكتبه العضوان يُعلَّم بكاتبه العضو */
function trio() {
  const r = new MemoryRemote();
  const owner = memDb(); const m1 = memDb(); const m2 = memDb();
  for (const d of [owner, m1, m2]) enableSync(d, UID);
  return { r, owner, m1, m2, close: () => { owner.close(); m1.close(); m2.close(); } };
}
type Trio = ReturnType<typeof trio>;
async function settle(p: Trio) {
  const ids = [getMeta(p.m1, 'device_id'), getMeta(p.m2, 'device_id')];
  for (let i = 0; i < 3; i++) {
    await sync(p.owner, p.r);
    await sync(p.m1, p.r);
    await sync(p.m2, p.r);
    for (const d of [...p.r.docs.values()]) if (ids.includes(d.dev) && d.by !== MEMBER) p.r.inject({ ...d, by: MEMBER });
    await ownerPulls(p.owner, p.r);
  }
}
/** المزوِّر يعيد كتابة مستند قيدٍ له في السحابة بمعرّف سطرٍ آخر */
function forgeLine(p: Trio, pick: (d: { d?: Record<string, unknown> | null }) => boolean, lineId: string) {
  const doc = [...p.r.docs.values()].find((d) => d.t === 'journal_entries' && d.dev === getMeta(p.m1, 'device_id') && pick(d))!;
  p.r.inject({ ...doc, by: MEMBER, d: { ...doc.d, stmt_line_id: lineId } });
  return doc.k;
}
/**
 * بنكٌ بمعرّفٍ ثابت (لا عشوائي) يجعل معرّف سطر الإيداع الأول أصغر من معرّف الثاني إن طُلب (معرّف السطر 'sl' + fnv64(البنك|البصمة) ·
 * store.ts): فترتيب المعرّفين ثابتٌ في كل تشغيل
 */
function fixedBank(db: DB, tag: string, g?: ReturnType<typeof grid>): string {
  for (let n = 0; ; n++) {
    const id = 'B_' + tag + '_' + n;
    if (g) {
      const ids = statementLineKeys(id, g.lines).map((k) => 'sl' + fnv64(id + '|' + k));
      if (!(ids[0] < ids[1])) continue;
    }
    db.run(`INSERT INTO banks (id, name, opening_halalas, opening_date, created_at) VALUES (?,?,?,?,?)`,
      [id, 'بنك مصطنع ' + tag, 0, '2026-01-01', new Date().toISOString()]);
    return id;
  }
}
function setup(tag: string, g?: ReturnType<typeof grid>) {
  const p = trio();
  const bank = fixedBank(p.owner, tag, g);
  const prop = addProperty(p.owner, { name: 'عقار مصطنع ' + tag });
  const majed = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: tag + '-M' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000003101', phone: '0500003101', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const salem = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: tag + '-S' }), {
    tenant: 'سالم المصطنع', idNumber: '1000003102', phone: '0500003102', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-05', end: '2027-10-04', depositHalalas: 0,
  }));
  return { p, bank, majed, salem };
}
const lineOf = (db: DB, date: string) => db.get<{ id: string }>(`SELECT id FROM bank_statement_lines WHERE date = ? AND deleted_at IS NULL`, [date])!.id;

describe('B2-1 · [عالٍ] معرّف سطرٍ مزوَّر على قيدٍ لا صلة له بالإيداع يُسقط تحصيل العضو الصحيح منه (engine.ts:1820 · stmt_line_id بلا تحقق)', () => {
  test('المزوِّر يكتب معرّف سطر إيداع ماجد على دفعته النقدية لسالم، ثم يعتمد عضوٌ أمين الإيداع لقسط ماجد: على جهاز المالك التحصيل مقبول والبنك 1,000', async () => {
    const { p, bank, salem } = setup('B21');
    saveStatement(p.owner, bank, grid([['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]), { name: 'b21.csv', hash: 'b21' });
    await settle(p);
    const L = lineOf(p.owner, '2026-10-02');
    // المزوِّر: دفعةٌ نقدية صحيحة لسالم في المكتب، وعلى قيدها معرّف سطر إيداع ماجد
    const sInst = p.m1.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [salem])!.id;
    recordRentPayment(p.m1, salem, { installmentId: sInst, period: 'أكتوبر', date: '2026-10-05', lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
    await sync(p.m1, p.r);
    const forged = forgeLine(p, (d) => d.d?.src_type === 'rent', L);
    await settle(p);
    // القيد المزوَّر مقبولٌ على جهاز المالك بمعرّف السطر (قيده صحيح)
    expect(p.owner.get<{ s: string }>(`SELECT stmt_line_id AS s FROM journal_entries WHERE id = ?`, [forged])!.s).toBe(L);

    // العضو الأمين يعتمد الإيداع لقسط ماجد «جاهزاً»
    const s = collectionSuggestions(p.m2, bank);
    expect(s.map((x) => [x.line.id, x.level])).toEqual([[L, 'ready']]);
    const { txId } = approveCollection(p.m2, L, s[0].target);
    await settle(p);

    const view = {
      bank: bankBalance(p.owner, bank),
      line: p.owner.get<{ status: string; tx: string | null }>(`SELECT status, bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [L]),
      honestTx: !!p.owner.get(`SELECT 1 FROM bank_tx WHERE id = ? AND deleted_at IS NULL`, [txId]),
    };
    // (الواقع: قيد ماجد مرفوض «تحصيلٌ ثانٍ…» وحركته مرفوضة، والبنك صفر، والسطر مفتوح)
    expect(view).toEqual({ bank: 100000, line: { status: 'matched', tx: txId }, honestTx: true });
    p.close();
  });
});

describe('B2-2 · [عالٍ] إعادة الربط «بحركة التحصيل الباقي» تربط إيداع ماجد بحركة تحصيل سالم وتطرد سطر سالم (engine.ts:997 · بلا تاريخ ولا فحص الممسك)', () => {
  test('المزوِّر يعتمد إيداع سالم صحيحاً ويكتب على قيده معرّف سطر ماجد: سطر سالم يبقى مطابَقاً بحركته، وسطر ماجد لا يأخذها', async () => {
    const g = grid([
      ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00'],
      ['2026/10/05', 'حوالة واردة سالم', '', '1,000.00', '2,000.00'],
    ]);
    // معرّف سطر ماجد أصغر من معرّف سطر سالم (بنكٌ بمعرّفٍ ثابت)
    const { p, bank } = setup('B22', g);
    saveStatement(p.owner, bank, g, { name: 'b22.csv', hash: 'b22' });
    await settle(p);
    const L = lineOf(p.owner, '2026-10-02');
    const L2 = lineOf(p.owner, '2026-10-05');
    expect(L < L2).toBe(true);
    // المزوِّر يعتمد إيداع سالم لقسط سالم (اعتمادٌ صحيح)، ثم يكتب على قيده معرّف سطر ماجد
    const s1 = collectionSuggestions(p.m1, bank).find((x) => x.line.id === L2)!;
    const { txId: salemTx } = approveCollection(p.m1, L2, s1.target);
    await sync(p.m1, p.r);
    forgeLine(p, (d) => d.d?.stmt_line_id === L2, L);
    await settle(p);
    expect(p.owner.get<{ tx: string }>(`SELECT bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [L2])!.tx).toBe(salemTx);

    // العضو الأمين يعتمد إيداع ماجد لقسط ماجد
    const s2 = collectionSuggestions(p.m2, bank).find((x) => x.line.id === L)!;
    approveCollection(p.m2, L, s2.target);
    await settle(p);

    const line = (id: string) => p.owner.get<{ status: string; tx: string | null }>(`SELECT status, bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [id])!;
    const view = { salemLine: line(L2), majedOnSalemTx: line(L).tx === salemTx };
    // (الواقع: سطر ماجد «مطابَق» بحركة سالم، وسطر سالم مفتوح «في الكشف وحده»)
    expect(view).toEqual({ salemLine: { status: 'matched', tx: salemTx }, majedOnSalemTx: false });
    p.close();
  });
});
