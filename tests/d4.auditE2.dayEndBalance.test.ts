/**
 * المدقق E2 · الجولة السادسة عشرة · على 50556c3 · كشفٌ يُطبع فيه الرصيد آخر اليوم وحده (أو قراءتان: بلا رصيدٍ ثم بأرصدة): حوالتان بالمبلغ
 * نفسه في اليوم نفسه بصمتاهما «#1» و«@الرصيد»، فقاعدة التوأم الجديدة تعدّهما حوالةً واحدة وتحذف إحداهما بالمزامنة على كل جهاز، وحارس
 * «الإيداع الواحد» يرفض تحصيل الثانية · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditE2.dayEndBalance.test.ts
 *
 * E2-1 · حرج · src/domain/bankStatement/dedupe.ts:59-78 (keepInOrder: «K» عدد ذوات الرصيد الحيّة وحدها، و«#n» بلا رصيد حركةٌ أخرى إن
 * جاوز n العدد K وإلا نافس ذوات الرصيد على K مقعداً) مع src/sync/engine.ts:1022-1032 (statementLineFix: مرور التوأم يحذف ما لم يُبقِه
 * keepInOrder ويرفعه جهاز المالك تصحيحاً) وengine.ts:689-696 (liveDepositCollection: «#n» مع ذي رصيدٍ إيداعٌ واحد ما لم تجاوز n العدد K):
 *  أ) كشفٌ CSV بعمودي مدين ودائن ورصيدٍ يُطبع آخر اليوم وحده (القارئ يقبله سليماً متحقَّقاً بلا تنبيه: «لكل سطرٍ طُبع رصيده»): يوم 1
 *     أكتوبر حوالتا ماجد وسالم بالإيجار نفسه (2,500)، وسطر ماجد بلا رصيد فبصمته «#1»، وسطر سالم برصيد اليوم فبصمته «@600000» · موظف
 *     البنوك (البنوك ٢) يحفظه بثلاثة سطور ويرفعه، فيرى جهاز المالك في القاعدة ذات رصيدٍ واحدة (K=1) و«#1» لا يجاوزها فيُبقي سطراً واحداً
 *     ويحذف الآخر ويرفع حذفه: على الجهازين حوالةٌ واحدة من اثنتين، وتقرير أكتوبر بفرقٍ «غير مفسَّر» 2,500 لا يُعرف سببه.
 *  ب) المالك والمحصِّل (البنوك ٣ والتحصيل ٣) يقرآن الملف نفسه، والمحصِّل يعتمد الحوالتين لقسطي ماجد وسالم: جهاز المالك يحذف أحد
 *     السطرين توأماً ويرفض أحد التحصيلين «تحصيلاً ثانياً» للإيداع نفسه، فيبقى قسطٌ دُفع غير مسدَّد ويقلّ البنك 2,500.
 *  ج) والقراءة نفسها بملفين: تصديرٌ بلا رصيدٍ أُخذ صباح 1 أكتوبر (حوالة ماجد وحدها «#1») ثم كشف الشهر بأرصدةٍ لكل سطر · الحفظ يعدّ
 *     حوالة ماجد محفوظةً ويحفظ حوالة سالم «@600000» جديدةً (freshLines) · والمزامنة تعدّ «#1» و«@600000» حوالةً واحدة فتحذف إحداهما:
 *     قاعدة التوأم ليست «عدّ الحفظ نفسه» كما يقول DESIGN §١٣.٢٢ (C٢-١)، فـ«#n» يُحكم عليه بذوات الرصيد الحيّة لا بما في الكشف.
 * لماذا يهم: الرصيد آخر اليوم وحده شكلٌ شائع في التصدير، والقارئ صُمّم له («وما قبل أول رصيدٍ مطبوع يشهد له الافتتاحي»)، وأول الشهر
 * حوالاتٌ كثيرة بالإيجار نفسه: إيداعٌ حقيقي يختفي من الكشف على كل الأجهزة بمزامنةٍ عادية لكشفٍ سليم، وتحصيلٌ صحيح يُرفض فيُطالَب
 * المستأجر بما دفع · ولا علاج من الشاشة: الملف نفسه يُرفض «قُرئ من قبل»، وحذف الكشف وإعادة قراءته على جهاز المالك تُبقي السطور الثلاثة
 * عنده وحده ويحذف جهاز الموظف أحدها ثانيةً بالقاعدة نفسها فيختلف الجهازان (جُرّب: ثلاثة عند المالك واثنان عند الموظف) · وليس من
 * «جهازي المالك بلا حَكَم» (§٥ · ٢): يكفيه موظفٌ واحد يرفع كشفاً.
 * السلوك الصحيح: سطران من كشفٍ واحد (أو ما عدّه الحفظ سطرين) لا يُعدّان توأماً بالمزامنة، فالحوالتان حيّتان على الجهازين وختامي الكشف
 * 5,995 بلا فرقٍ غير مفسَّر (أ وج)، والتحصيلان مقبولان والبنك 6,000 والسطران مطابَقان (ب) · مع بقاء A٢-٥ وC٢-١(ج) كما هما (حوالة الصفحة
 * المصوَّرة وسطر MT940 لها حوالةٌ واحدة).
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementFile, type StatementResult } from '@/domain/bankStatement/read';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditC2.mt940Twins.test.ts */
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

const ok = (r: StatementResult) => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار
const csv = (rows: string[]) => ok(readStatementFile({ name: 'oct.csv', bytes: new TextEncoder().encode(['Date,Description,Debit,Credit,Balance', ...rows].join('\n')) }));
/** كشف أكتوبر: الرصيد يُطبع آخر كل يوم وحده (سطر ماجد بلا رصيد، وسطر سالم برصيد اليوم) */
const dayEnd = () => csv([
  '30/09/2026,Opening Balance,,,1000.00',
  '01/10/2026,TRANSFER MAJED,,2500.00,',
  '01/10/2026,TRANSFER SALEM,,2500.00,6000.00',
  '02/10/2026,SMS CHARGES,5.00,,5995.00',
]);
const live = (db: DB, bank: string) => db.all<{ d: string }>(
  `SELECT descr AS d FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY date, descr`, [bank]).map((x) => x.d);
const want = ['TRANSFER MAJED', 'TRANSFER SALEM', 'SMS CHARGES'];

describe('E2-1 · [حرج] «#1» و«@الرصيد» في قاعدةٍ واحدة تُعدّان حوالةً واحدة بالمزامنة (dedupe.ts:59-78 · engine.ts:1022-1032 · 689-696)', () => {
  test('أ) كشف CSV برصيد آخر اليوم وحده يقرؤه موظف البنوك: بعد المزامنة الحوالتان حيّتان على الجهازين وختامي الكشف 5,995 بلا فرقٍ غير مفسَّر', async () => {
    const ORG = 'owner-e2-1a';
    const r = new MemoryRemote();
    const O = memDb();
    enableSync(O, ORG);
    const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
    const bank = addBank(O, 'بنك مصطنع E2-1أ', 100000);
    await ownerSync();
    const clerk = memberDevice(r, ORG, 'member-e2-1a', { banks: 2 });
    await clerk.sync(); await clerk.sync();

    // القراءة سليمة متحقَّقة بلا تنبيه، وسطر ماجد بلا رصيد
    const st = dayEnd();
    expect({ lines: st.lines.map((l) => [l.descr, l.amount, l.balance]), warnings: st.warnings, chain: st.checks.chain }).toEqual({
      lines: [['TRANSFER MAJED', 250000, null], ['TRANSFER SALEM', 250000, 600000], ['SMS CHARGES', -500, 599500]], warnings: [], chain: true });
    expect(saveStatement(clerk.db, bank, st, { name: 'oct-e2-1a.csv', hash: 'e2-1a-oct' })).toMatchObject({ added: 3, skipped: 0 });
    expect(live(clerk.db, bank)).toEqual(want);

    for (let i = 0; i < 2; i++) { await clerk.sync(); await ownerSync(); await ownerSync(); }
    await clerk.sync(); await clerk.sync();

    const rec = reconciliation(O, bank, '2026-10');
    // (الواقع: على الجهازين ['TRANSFER SALEM', 'SMS CHARGES'] وحدهما، والفرق غير المفسَّر 250,000 هللة)
    expect({ owner: live(O, bank), clerk: live(clerk.db, bank), statementClosing: rec.statementClosing, unexplained: rec.unexplained })
      .toEqual({ owner: want, clerk: want, statementClosing: 599500, unexplained: 0 });
    O.close(); clerk.db.close();
  });

  test('ب) المالك والمحصِّل يقرآن الملف نفسه والمحصِّل يعتمد الحوالتين لقسطي ماجد وسالم: جهاز المالك يقبل التحصيلين، والبنك 6,000 والسطران مطابَقان', async () => {
    const ORG = 'owner-e2-1b';
    const r = new MemoryRemote();
    const O = memDb();
    enableSync(O, ORG);
    const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
    const bank = addBank(O, 'بنك مصطنع E2-1ب', 100000);
    const prop = addProperty(O, { name: 'عقار مصطنع E2-1ب' });
    for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
      confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'E21B-' + n }), {
        tenant, idNumber: '100000310' + n, phone: '050000310' + n, valueHalalas: 3000000, cycle: 'شهرية',
        start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
      }));
    }
    await ownerSync();
    const collector = memberDevice(r, ORG, 'member-e2-1b', { banks: 3, collect: 3 });
    await collector.sync(); await collector.sync();

    // الملف نفسه على الجهازين (المعرّفات حتمية فيلتقيان كشفاً واحداً · Y3)
    saveStatement(O, bank, dayEnd(), { name: 'oct-e2-1b.csv', hash: 'e2-1b-oct' });
    saveStatement(collector.db, bank, dayEnd(), { name: 'oct-e2-1b.csv', hash: 'e2-1b-oct' });
    // المحصِّل يعتمد اقتراحي التحصيل بعد مراجعتهما (البيان بالإنجليزية لا يسمّي المستأجر فهما «تحتاج مراجعة»)
    const sugg = collectionSuggestions(collector.db, bank);
    expect(sugg.length).toBe(2);
    for (const s of sugg) approveCollection(collector.db, s.line.id, s.target);
    expect(bankBalance(collector.db, bank)).toBe(600000);
    for (let i = 0; i < 2; i++) { await collector.sync(); await ownerSync(); await ownerSync(); }

    const view = {
      payments: O.all<{ t: string }>(`SELECT c.tenant_name AS t FROM contract_payments p JOIN contracts c ON c.id = p.contract_id
        WHERE p.cancelled_at IS NULL ORDER BY c.tenant_name`).map((x) => x.t),
      bank: bankBalance(O, bank),
      matched: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL AND status = 'matched'`, [bank])!.n),
    };
    // (الواقع: دفعةٌ واحدة من الاثنتين، والبنك 350,000، وفي المرفوض القيد الآخر «تحصيلٌ ثانٍ»)
    expect(view).toEqual({ payments: ['سالم المصطنع', 'ماجد المصطنع'], bank: 600000, matched: 2 });
    O.close(); collector.db.close();
  });

  test('ج) تصديرٌ بلا رصيدٍ صباح 1 أكتوبر (حوالة ماجد) ثم كشف الشهر بأرصدته: الحفظ يعدّهما حوالتين، وبعد المزامنة الحوالتان حيّتان على الجهازين', async () => {
    const ORG = 'owner-e2-1c';
    const r = new MemoryRemote();
    const O = memDb();
    enableSync(O, ORG);
    const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
    const bank = addBank(O, 'بنك مصطنع E2-1ج', 100000);
    await ownerSync();
    const clerk = memberDevice(r, ORG, 'member-e2-1c', { banks: 2 });
    await clerk.sync(); await clerk.sync();

    // صباح 1 أكتوبر: تصدير الحركات بلا عمود رصيد (حوالة ماجد وحدها حتى الآن)
    const morning = ok(readStatementFile({ name: 'today.csv', bytes: new TextEncoder().encode([
      'Date,Description,Debit,Credit', '01/10/2026,TRANSFER MAJED,,2500.00'].join('\n')) }, { opening: 100000, closing: 350000 }));
    expect(morning.lines.map((l) => [l.descr, l.balance])).toEqual([['TRANSFER MAJED', null]]);
    saveStatement(clerk.db, bank, morning, { name: 'today-e2-1c.csv', hash: 'e2-1c-today' });
    // ثم كشف الشهر بأرصدةٍ لكل سطر: ماجد محفوظ، وسالم والرسوم جديدان
    const month = csv([
      '30/09/2026,Opening Balance,,,1000.00',
      '01/10/2026,TRANSFER MAJED,,2500.00,3500.00',
      '01/10/2026,TRANSFER SALEM,,2500.00,6000.00',
      '02/10/2026,SMS CHARGES,5.00,,5995.00',
    ]);
    expect(saveStatement(clerk.db, bank, month, { name: 'oct-e2-1c.csv', hash: 'e2-1c-oct' })).toMatchObject({ added: 2, skipped: 1 });
    expect(live(clerk.db, bank)).toEqual(want);

    for (let i = 0; i < 2; i++) { await clerk.sync(); await ownerSync(); await ownerSync(); }
    await clerk.sync(); await clerk.sync();

    // (الواقع: على الجهازين حوالةٌ واحدة من الاثنتين ورسم الرسائل)
    expect({ owner: live(O, bank), clerk: live(clerk.db, bank), unexplained: reconciliation(O, bank, '2026-10').unexplained })
      .toEqual({ owner: want, clerk: want, unexplained: 0 });
    O.close(); clerk.db.close();
  });
});
