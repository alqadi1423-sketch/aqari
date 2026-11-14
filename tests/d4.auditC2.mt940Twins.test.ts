/**
 * المدقق C2 · الجولة الخامسة عشرة · على f5036b1 · كشفٌ بلا رصيدٍ لكل حركة (MT940) فيه حوالتان أو أكثر بالمبلغ نفسه في اليوم نفسه: كل جهازٍ
 * يستقبله يحذف حوالاته «توائم» إلا واحدة، وجهاز المالك يرفع الحذف إلى الأجهزة كلها، وحارس «الإيداع الواحد» يعدّها إيداعاً واحداً ·
 * بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditC2.mt940Twins.test.ts
 *
 * C2-1 · حرج · src/domain/bankStatement/dedupe.ts:40-48 (sameLineKey وSAME_KEY_SQL: «القاعدة نفسها وأحدهما بلا رصيد» تصدق على بصمتين
 * كلتاهما بلا رصيد «#1» و«#2»، فالحوالتان المختلفتان بموضعهما في الملف «السطر نفسه») مع src/sync/engine.ts:1017-1029 (statementLineFix:
 * «وسطران حيّان بالبصمة نفسها … ويُحذف الآخر على كل جهاز») وengine.ts:1085-1090 (enqueueStmtFix: جهاز المالك يرفع الحذف تصحيحاً) و
 * engine.ts:683-695 مع 1916-1923 (liveDepositCollection: «تحصيلٌ حيٌّ للإيداع نفسه» بالشرط نفسه):
 *  أ) موظف البنوك (البنوك ٢) يقرأ كشف أكتوبر MT940: ثلاث حوالاتٍ بالإيجار نفسه (2,500) يوم 1 أكتوبر — ماجد وسالم وفهد — ورسم رسائل ·
 *     يحفظه سليماً بأربعة سطور (البصمات «#1» و«#2» و«#3» للحوالات) ويرفعه · جهاز المالك يجد لكل حوالةٍ «توأماً» حيّاً في الأخريين
 *     فيُبقي واحدةً (بالمعرّف) ويحذف اثنتين ويرفع حذفهما «تصحيحاً»، فيصل الحذف إلى جهاز الموظف نفسه: على الجهازين حوالةٌ واحدة من
 *     ثلاث، وختامي الكشف في تقرير أكتوبر 2,495 والمطبوع 7,495، ولا فرق «غير مفسَّر» ولا تنبيه · ولا علاج: الملف نفسه يُرفض «قُرئ من
 *     قبل»، وحذف الكشف وإعادة قراءته يحفظ الحوالات الثلاث على جهاز الموظف ثم تُحذف اثنتان منها ثانيةً عند أول مزامنة (جُرّب).
 *  ب) المالك والمحصِّل (البنوك ٣ والتحصيل ٣) يقرآن الملف نفسه (بالمعرّفات نفسها · Y3)، والمحصِّل يعتمد حوالتي ماجد وسالم لقسطيهما
 *     بعد مراجعة الاقتراحين · جهاز المالك يقبل أول التحصيلين ويرفض الآخر «تحصيلاً ثانياً» لأن سطره «السطر نفسه» لسطر الأول، وتسقط
 *     حركته · ويحذف أحد السطرين توأماً: في دفاتر المالك البنك 2,500 والمحصِّل 5,000، وقسطٌ دُفع غير مسدَّد.
 *  ج) ومع صورة صفحةٍ بأرصدتها (A2-5): الموظف يصوّر الصفحة الأولى (ماجد وسالم برصيديهما) ثم يقرأ MT940 للشهر فتُحفظ حوالة فهد وحدها جديدةً
 *     («#3» أكبر من سطري القاعدة · freshLines) · على جهاز المالك «#3» توأمٌ لسطري الصورة (أحدهما بلا رصيد) فيُحذف ويُرفع حذفه: حوالة فهد
 *     تختفي من الجهازين · (والإصلاح بمقارنة «#» بـ«#» وحدها لا يكفي لهذه الحالة: جُرّب.)
 * لماذا يهم: MT940 صيغة كشوف المنشآت (DESIGN §١٣.٢٢)، وكذلك كل CSV أو Excel بلا عمود رصيد، وأول الشهر حوالاتٌ كثيرة بالإيجار نفسه ورسومٌ
 * متكررة بالمبلغ نفسه: إيداعاتٌ حقيقية تختفي من الكشف على كل الأجهزة بلا أثر، وتحصيلٌ صحيح يُرفض فيُطالَب المستأجر بما دفع، ورصيد
 * الكشف في التقرير غير رصيد البنك · بلا خصمٍ ولا تزامن: مزامنةٌ عادية لكشفٍ سليم.
 * السلوك الصحيح: «السطر نفسه» في المزامنة وحارس الإيداع بمعيار الحفظ نفسه (freshLines): البصمتان بلا رصيدٍ برقمي تكرارٍ مختلفين سطران،
 * و«#n» لا يكون سطراً بلا رصيدٍ لسطرٍ برصيده إلا ما لم تتجاوز n عدد سطور قاعدته · فبعد المزامنة السطور حيّة على الأجهزة وختامي الكشف
 * 7,495 (أ) و7,500 (ج)، والتحصيلان مقبولان والبنك 5,000 والسطران مطابَقان (ب).
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementFile } from '@/domain/bankStatement/read';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditZ1.cancelThreeDevices.test.ts */
function memberDevice(r: MemoryRemote, org: string, uid: string, perms: Access['perms']) {
  const M: Access = { owner: false, uid, perms, allProps: true, props: [] };
  const db = memDb();
  enableSync(db, uid);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org, profile: { name: 'موظف مصطنع' } })]);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [org]);
  const sync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(db, r, getMeta(db, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  return { db, sync };
}

/** كشف أكتوبر MT940 (بلا رصيدٍ لكل حركة): حوالاتٌ بالإيجار نفسه يوم 1 أكتوبر، ورسم رسائل إن طُلب */
const mt940 = (names: string[], fee: boolean) => {
  const total = names.length * 2500 - (fee ? 5 : 0);
  const r = readStatementFile({ name: 'oct.sta', bytes: new TextEncoder().encode([':20:SYNC21', ':60F:C260930SAR0,00',
    ...names.flatMap((n) => [`:61:2610011001C2500,00NTRF//${n}`, `:86:TRANSFER ${n}`]),
    ...(fee ? [':61:2610021002D5,00NCHG//SMS', ':86:SMS CHARGES'] : []),
    `:62F:C26100${fee ? 2 : 1}SAR${total},00`].join('\n')) });
  if (!r.ok) throw new Error(r.error);
  return r;
};
const live = (db: DB, bank: string) => db.all<{ d: string }>(
  `SELECT descr AS d FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY date, descr`, [bank]).map((x) => x.d);

describe('C2-1 · [حرج] بصمتان بلا رصيد «#1» و«#2» تُعدّان السطر نفسه (dedupe.ts:40-48)', () => {
  test('أ) كشف MT940 بثلاث حوالاتٍ بالمبلغ نفسه في يومٍ واحد يقرؤه موظف البنوك: بعد المزامنة السطور الأربعة حيّة على الجهازين وختامي الكشف 7,495', async () => {
    const ORG = 'owner-c2-1a';
    const r = new MemoryRemote();
    const O = memDb();
    enableSync(O, ORG);
    const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
    const bank = addBank(O, 'بنك مصطنع C2-1أ', 0);
    await ownerSync();
    const clerk = memberDevice(r, ORG, 'member-c2-1a', { banks: 2 });
    await clerk.sync(); await clerk.sync();

    // الموظف يقرأ الكشف ويحفظه سليماً: أربعة سطور، والحوالات الثلاث بلا رصيد
    const st = mt940(['MAJED', 'SALEM', 'FAHAD'], true);
    expect(st.lines.map((l) => [l.date, l.amount, l.balance])).toEqual([
      ['2026-10-01', 250000, null], ['2026-10-01', 250000, null], ['2026-10-01', 250000, null], ['2026-10-02', -500, null]]);
    saveStatement(clerk.db, bank, st, { name: 'oct-c2-1a.sta', hash: 'c2-1a-oct' });
    const want = ['TRANSFER FAHAD', 'TRANSFER MAJED', 'TRANSFER SALEM', 'SMS CHARGES'];
    expect(live(clerk.db, bank)).toEqual(want);

    // مزامنةٌ عادية: الموظف يرفع، والمالك يسحب ويرفع، والموظف يسحب
    for (let i = 0; i < 2; i++) { await clerk.sync(); await ownerSync(); await ownerSync(); }
    await clerk.sync(); await clerk.sync();

    const rec = reconciliation(O, bank, '2026-10');
    // (الواقع: على الجهازين حوالةٌ واحدة من الثلاث (أيّها بمعرّفات السطور، أي بمعرّف البنك) ورسم الرسائل، وختامي الكشف في التقرير 249,500
    //  هللة، والفرق غير المفسَّر صفر)
    expect({ owner: live(O, bank), clerk: live(clerk.db, bank), statementClosing: rec.statementClosing, unexplained: rec.unexplained })
      .toEqual({ owner: want, clerk: want, statementClosing: 749500, unexplained: 0 });
    O.close(); clerk.db.close();
  });

  test('ب) المالك والمحصِّل يقرآن الملف نفسه والمحصِّل يعتمد حوالتي ماجد وسالم: جهاز المالك يقبل التحصيلين، والبنك 5,000 والسطران مطابَقان', async () => {
    const ORG = 'owner-c2-1b';
    const r = new MemoryRemote();
    const O = memDb();
    enableSync(O, ORG);
    const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
    const bank = addBank(O, 'بنك مصطنع C2-1ب', 0);
    const prop = addProperty(O, { name: 'عقار مصطنع C2-1ب' });
    for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
      confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'C21B-' + n }), {
        tenant, idNumber: '100000210' + n, phone: '050000210' + n, valueHalalas: 3000000, cycle: 'شهرية',
        start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
      }));
    }
    await ownerSync();
    const collector = memberDevice(r, ORG, 'member-c2-1b', { banks: 3, collect: 3 });
    await collector.sync(); await collector.sync();

    // الملف نفسه على الجهازين (المعرّفات حتمية فيلتقيان كشفاً واحداً · Y3)، بحوالتين بلا رصيد
    const st = mt940(['MAJED', 'SALEM'], false);
    saveStatement(O, bank, st, { name: 'oct-c2-1b.sta', hash: 'c2-1b-oct' });
    saveStatement(collector.db, bank, st, { name: 'oct-c2-1b.sta', hash: 'c2-1b-oct' });
    // المحصِّل يعتمد اقتراحي التحصيل بعد مراجعتهما (البيان بالإنجليزية لا يسمّي المستأجر، فهما «تحتاج مراجعة» بالمبلغ والتاريخ)
    const sugg = collectionSuggestions(collector.db, bank);
    expect(sugg.length).toBe(2);
    for (const s of sugg) approveCollection(collector.db, s.line.id, s.target);
    expect(bankBalance(collector.db, bank)).toBe(500000);
    for (let i = 0; i < 2; i++) { await collector.sync(); await ownerSync(); await ownerSync(); }

    const view = {
      payments: O.all<{ t: string }>(`SELECT c.tenant_name AS t FROM contract_payments p JOIN contracts c ON c.id = p.contract_id
        WHERE p.cancelled_at IS NULL ORDER BY c.tenant_name`).map((x) => x.t),
      bank: bankBalance(O, bank),
      matched: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL AND status = 'matched'`, [bank])!.n),
    };
    // (الواقع: دفعةٌ واحدة من الاثنتين، والبنك 250000، ولا سطر مطابَق، وفي المرفوض القيد الآخر وحركته «تحصيلٌ ثانٍ»)
    expect(view).toEqual({ payments: ['سالم المصطنع', 'ماجد المصطنع'], bank: 500000, matched: 2 });
    O.close(); collector.db.close();
  });
  test('ج) صورة الصفحة الأولى (ماجد وسالم برصيديهما) ثم MT940 للشهر تُضيف حوالة فهد: بعد المزامنة الحوالات الثلاث حيّة على الجهازين وختامي الكشف 7,500', async () => {
    const ORG = 'owner-c2-1c';
    const r = new MemoryRemote();
    const O = memDb();
    enableSync(O, ORG);
    const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
    const bank = addBank(O, 'بنك مصطنع C2-1ج', 0);
    await ownerSync();
    const clerk = memberDevice(r, ORG, 'member-c2-1c', { banks: 2 });
    await clerk.sync(); await clerk.sync();

    // صورة الصفحة الأولى بأرصدتها كما في tests/d4.auditA2.overlapKeys.test.ts (سطرٌ بعرضه من طول نصه)
    const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
    const ph = readStatementPhoto([
      ln('Date Description Debit Credit Balance', 40, 60),
      ln('Opening Balance', 40, 80), ln('0.00', 880, 80),
      ln('01/10/2026', 40, 100), ln('TRANSFER MAJED', 200, 100), ln('2,500.00', 720, 100), ln('2,500.00', 880, 100),
      ln('01/10/2026', 40, 140), ln('TRANSFER SALEM', 200, 140), ln('2,500.00', 720, 140), ln('5,000.00', 880, 140),
      ln('Balance Carried Forward', 40, 180), ln('5,000.00', 880, 180),
      ln('Page 1 of 2', 40, 260),
    ]);
    if (!ph.ok) throw new Error(ph.error);
    saveStatement(clerk.db, bank, ph, { name: 'oct-c2-1c-p1.jpg', hash: 'c2-1c-p1' });
    // ثم كشف الشهر MT940: ماجد وسالم محفوظان، وفهد جديد (سليمٌ عند الحفظ)
    expect(saveStatement(clerk.db, bank, mt940(['MAJED', 'SALEM', 'FAHAD'], false), { name: 'oct-c2-1c.sta', hash: 'c2-1c-oct' }))
      .toMatchObject({ added: 1, skipped: 2 });
    const want = ['TRANSFER FAHAD', 'TRANSFER MAJED', 'TRANSFER SALEM'];
    expect(live(clerk.db, bank)).toEqual(want);

    for (let i = 0; i < 2; i++) { await clerk.sync(); await ownerSync(); await ownerSync(); }
    await clerk.sync(); await clerk.sync();

    // (الواقع: على الجهازين ['TRANSFER MAJED', 'TRANSFER SALEM'] وختامي الكشف في التقرير 500,000 هللة)
    expect({ owner: live(O, bank), clerk: live(clerk.db, bank), statementClosing: reconciliation(O, bank, '2026-10').statementClosing })
      .toEqual({ owner: want, clerk: want, statementClosing: 750000 });
    O.close(); clerk.db.close();
  });
});
