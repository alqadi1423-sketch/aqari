/**
 * المدقق C2 · الجولة الخامسة عشرة · على f5036b1 · إصلاح B2-7 («إلغاء الدفعة يفكّ مطابقة سطر الكشف بحركتها») محليٌّ في cancelPayment وحده،
 * ولا يشتقّه جهاز المالك من الوارد · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditC2.reversedMatch.test.ts
 *
 * C2-2 · متوسط · src/domain/contracts/cancelPayment.ts:234-239 (السطر يُفتح على جهاز من ألغى وحده) مع src/sync/engine.ts:1030-1060
 * (statementLineFix يقبل «مطابَقاً» بحركةٍ حيّة من بنكه بمبلغه ولا يسأل هل قيدها معكوس) وengine.ts:1857-1866 (إصلاح الدفعة الواصلة حيّةً
 * وقيدها معكوس لا يمسّ سطرها) وsrc/domain/access/opWrites.ts:44-49 مع rulesGen.ts:488-545 (قسم التحصيل لا يملك سطر الكشف، وتعديله للبنوك ٣):
 *  أ) المالك يعتمد حوالة ماجد (1,000) لقسط أكتوبر من الكشف · ثم المحصِّل (التحصيل «كامل»، والبنوك «قراءة») يلغي الدفعة من شاشتها لأن
 *     الحوالة ليست لماجد · على جهازه يُفتح السطر، لكن رفع السطر «خارج صلاحيتك» فيبقى عنده · وجهاز المالك يطبّق العاكس والدفعة الملغاة
 *     وحركة البنك السالبة، والسطر عنده «مطابَق» بحركة التحصيل الملغى: لا يُقترح تحصيلاً، ويعدّه التقرير مطابَقاً ويفسّر الفرق بالحركة
 *     السالبة «في الدفاتر وحدها» · والجهازان مختلفان: المحصِّل يرى الإيداع مفتوحاً مقترحاً، والمالك لا.
 *  ب) مسار Z1-1 الذي أُصلح: عضوٌ (البنوك ٣) يعتمد ثم يلغي (فيُفتح السطر ويُرفع)، وعضوٌ بلا اتصال يعتمد الاقتراح نفسه بعده بالمعرّفات
 *     نفسها · جهاز المالك يُصلح الدفعة «ملغاةً» بعاكسها ويرفعها، لكن سطر العضو الثاني (مطابَقاً بحركة القيد المعكوس) يُطبَّق كما هو:
 *     على الأجهزة الثلاثة الدفعة ملغاة والسطر «مطابَق» بتحصيلٍ ملغى، فلا يعود الإيداع إلى الاقتراح أبداً.
 * لماذا يهم: هو أثر B2-7 نفسه (إيداعٌ حقيقي يختفي من قائمة العمل بمطابقةٍ لتحصيلٍ أُلغي، والتقرير بلا فرقٍ يدلّ عليه) بطريقين يوميين لم
 * يغطّهما إصلاحه: فصل صلاحيتي التحصيل والبنوك صريحٌ في سجل القرارات ٥٩، والإلغاء والاعتماد على أجهزةٍ مختلفة هو ما بُني له الإصلاح.
 * السلوك الصحيح: على جهاز المالك (وما يرفعه) لا يبقى سطر كشفٍ مطابَقاً بحركة قيدٍ معكوس: بعد المزامنة السطر مفتوح، ويُقترح للتحصيل
 * ثانيةً، ويظهر «في الكشف وحده» · والأجهزة متفقة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditZ1.cancelThreeDevices.test.ts */
function memberDevice(r: MemoryRemote, org: string, uid: string, perms: Access['perms']) {
  const M: Access = { owner: false, uid, perms, allProps: true, props: [] };
  const db = memDb();
  enableSync(db, uid);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org, profile: { name: 'عضو مصطنع' } })]);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [org]);
  const sync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(db, r, getMeta(db, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  return { db, sync };
}

/** المالك وعقد ماجد وكشف أكتوبر بحوالته (1,000 يوم 2 أكتوبر) */
function setup(org: string, tag: string) {
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, org);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع ' + tag, 0);
  const prop = addProperty(O, { name: 'عقار مصطنع ' + tag });
  const contract = confirmContract(O, contractInput(addUnit(O, prop, { unit_no: tag + '-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000002201', phone: '0500002201', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const st = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!st.ok) throw new Error(st.error);
  saveStatement(O, bank, st, { name: 'oct-' + tag + '.csv', hash: tag });
  return { r, O, ownerSync, bank, contract };
}

/** حال السطر على جهاز: حالته، وهل حركته لقيدٍ معكوس، وهل يُقترح للتحصيل */
const lineView = (db: DB, bank: string) => {
  const l = db.get<{ id: string; status: string; reversed: number }>(
    `SELECT l.id, l.status, (SELECT COUNT(*) FROM bank_tx t JOIN journal_entries e ON e.no = t.journal_no
       WHERE t.id = l.bank_tx_id AND e.reversed_by IS NOT NULL) AS reversed FROM bank_statement_lines l WHERE l.bank_id = ? AND l.deleted_at IS NULL`, [bank])!;
  return {
    status: l.status,
    matchedToReversed: Number(l.reversed) > 0,
    collectAgain: collectionSuggestions(db, bank).filter((s) => s.line.id === l.id).length,
  };
};
const reopened = { status: 'open', matchedToReversed: false, collectAgain: 1 };

describe('C2-2 · [متوسط] سطر الكشف يبقى «مطابَقاً» بتحصيلٍ أُلغي على جهاز المالك (cancelPayment.ts:234 محليٌّ · engine.ts:1050)', () => {
  test('أ) المحصِّل (التحصيل كامل، البنوك قراءة) يلغي دفعةً اعتمدها المالك من الكشف: السطر على جهاز المالك مفتوح ويُقترح ثانيةً', async () => {
    const ORG = 'owner-c2-2a';
    const { r, O, ownerSync, bank, contract } = setup(ORG, 'C22A');
    const s = collectionSuggestions(O, bank)[0];
    approveCollection(O, s.line.id, s.target);
    await ownerSync();
    const collector = memberDevice(r, ORG, 'member-c2-2a', { collect: 3, banks: 1 });
    await collector.sync(); await collector.sync();
    const pay = collector.db.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [contract])!.id;

    // الإلغاء من شاشة الدفعة: الحوالة ليست لماجد
    cancelPayment(collector.db, pay, { date: '2026-10-03', reason: 'الحوالة لمستأجرٍ آخر (مصطنع)' });
    await collector.sync();
    await ownerSync(); await ownerSync();
    await collector.sync();

    expect(O.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [pay])!.c).toBe('2026-10-03');
    const rec = reconciliation(O, bank, '2026-10');
    // (الواقع: المالك { status: 'matched', matchedToReversed: true, collectAgain: 0 } والتقرير بلا شيءٍ «في الكشف وحده» · والمحصِّل مفتوحٌ مقترح)
    expect({ owner: lineView(O, bank), collector: lineView(collector.db, bank), onlyInStatement: rec.onlyInStatement.map((x) => x.amount) })
      .toEqual({ owner: reopened, collector: reopened, onlyInStatement: [100000] });
    O.close(); collector.db.close();
  });

  test('ب) مسار Z1-1: عضوٌ يعتمد ثم يلغي، وعضوٌ بلا اتصال يعتمد الاقتراح نفسه بعده: الدفعة ملغاة والسطر مفتوحٌ يُقترح ثانيةً على الأجهزة الثلاثة', async () => {
    const ORG = 'owner-c2-2b';
    const { r, O, ownerSync, bank, contract } = setup(ORG, 'C22B');
    await ownerSync();
    const A = memberDevice(r, ORG, 'member-c2-2b-a', { banks: 3, collect: 3 });
    const B = memberDevice(r, ORG, 'member-c2-2b-b', { banks: 3, collect: 3 });
    await A.sync(); await A.sync();
    await B.sync(); await B.sync();

    const sa = collectionSuggestions(A.db, bank);
    approveCollection(A.db, sa[0].line.id, sa[0].target);
    await A.sync();
    await ownerSync(); await ownerSync();
    const pay = O.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [contract])!.id;
    cancelPayment(A.db, pay, { date: '2026-10-02', reason: 'الحوالة لمستأجرٍ آخر (مصطنع)' });
    await A.sync();
    await wait(5);
    const sb = collectionSuggestions(B.db, bank);
    approveCollection(B.db, sb[0].line.id, sb[0].target);
    await B.sync();
    for (let i = 0; i < 3; i++) { await ownerSync(); await ownerSync(); await A.sync(); await B.sync(); }

    // الدفعة ملغاةٌ على الثلاثة (إصلاح Z1-1 يعمل)
    const cancelled = (db: DB) => db.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [pay])!.c != null;
    expect([cancelled(O), cancelled(A.db), cancelled(B.db)]).toEqual([true, true, true]);
    // (الواقع: على الثلاثة { status: 'matched', matchedToReversed: true, collectAgain: 0 })
    expect({ owner: lineView(O, bank), memberA: lineView(A.db, bank), memberB: lineView(B.db, bank) })
      .toEqual({ owner: reopened, memberA: reopened, memberB: reopened });
    O.close(); A.db.close(); B.db.close();
  });
});
