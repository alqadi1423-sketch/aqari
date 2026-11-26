/**
 * المدقق Z1 · الجولة الثالثة عشرة · حارس «الإلغاء لا رجعة فيه» (إصلاح Y1 · src/sync/engine.ts:1715-1723) بين ثلاثة أجهزة · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditZ1.cancelThreeDevices.test.ts
 *
 * Z1-1 · عالٍ · src/sync/engine.ts:1718 (الحارس يسأل «أهي ملغاةٌ هنا؟» لا «أقيدها معكوس؟») مع src/domain/bankStatement/collect.ts:229-235
 * (معرّفات الاعتماد حتمية): العضو «أ» (التحصيل ٣ والبنوك ٣) يعتمد إيداع 2 أكتوبر لقسط ماجد، ويسحبه جهاز المالك، ثم يلغي «أ» الدفعة ·
 * والعضو «ب» بلا اتصال منذ قبل الاعتماد يعتمد الاقتراح نفسه بعد الإلغاء فيكتب الدفعة والقيد والحركة بالمعرّفات نفسها، ونسخته من الدفعة
 * (حيّة) أحدث من الإلغاء فتغلبه في السحابة قبل أن يسحب المالك الإلغاء · جهاز المالك لم يرَ الدفعة ملغاةً قط، فلا يعمل الحارس: الدفعة
 * حيّة وقيدها معكوس، والقسط «مسدَّد» 1,000 والبنك صفر، وفحص «كل دفعة محصَّلة لها قيد مرحّل» أحمر · و«أ» يُبقي الإلغاء (الحارس على
 * جهاز العضو لا يرفع شيئاً) و«ب» يُبقي قيده غير معكوس: ثلاث نسخٍ مختلفة لا تلتقي أبداً.
 * لماذا يهم: هو Y1 نفسه بطريقٍ لم يغطّه إصلاحه (الإلغاء من جهاز عضو)، والمستأجر يظهر مسدِّداً لقسطٍ لا مال له بعد قرارٍ صريح بالإلغاء.
 * السلوك الصحيح: بعد المزامنة الأجهزة الثلاثة متفقة ومتسقة: الإلغاء باقٍ (أو تحصيلٌ حيٌّ بقيدٍ غير معكوس)، والفحوص خضراء على كلٍّ منها.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { bankBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

const ORG = 'owner-z1-1';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) بالتحصيل ٣ والبنوك ٣ */
function memberDevice(r: MemoryRemote, uid: string) {
  const M: Access = { owner: false, uid, perms: { banks: 3, collect: 3 }, allProps: true, props: [] };
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

describe('Z1-1 · [عالٍ] عضوٌ يلغي دفعةً اعتمدها من الكشف، وعضوٌ آخر بلا اتصال يعتمد الإيداع نفسه بعده: الحارس لا يعمل لأن المالك لم يرَ الإلغاء (engine.ts:1718)', () => {
  test('المالك والعضوان: بعد المزامنة الدفعة على الثلاثة بحالٍ واحدة، ولا دفعة حيّة بقيدٍ معكوس، والقسط يطابق البنك، والفحوص خضراء', async () => {
    const r = new MemoryRemote();
    const O = memDb();
    enableSync(O, ORG);
    const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
    const bank = addBank(O, 'بنك مصطنع Z1-1', 0);
    const prop = addProperty(O, { name: 'عقار مصطنع Z1-1' });
    const c = confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'Z1-1' }), {
      tenant: 'ماجد المصطنع', idNumber: '1000000951', phone: '0500000951', valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
    const st = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
    if (!st.ok) throw new Error(st.error);
    saveStatement(O, bank, st, { name: 'oct-z1-1.csv', hash: 'z1-1' });
    await ownerSync();
    const A = memberDevice(r, 'member-z1-a');
    const B = memberDevice(r, 'member-z1-b');
    await A.sync(); await A.sync();
    await B.sync(); await B.sync();

    // «أ» يعتمد ويرفع، ويسحب المالك الاعتماد
    const sa = collectionSuggestions(A.db, bank);
    expect(sa.map((s) => [s.level, s.target.kind])).toEqual([['ready', 'installments']]);
    approveCollection(A.db, sa[0].line.id, sa[0].target);
    await A.sync();
    await ownerSync(); await ownerSync();
    const pay = O.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [c])!.id;
    // ثم «أ» يلغي الدفعة (الإيداع ليس للمستأجر) ويرفع الإلغاء
    cancelPayment(A.db, pay, { date: '2026-10-02', reason: 'الإيداع ليس للمستأجر (مصطنع)' });
    await A.sync();
    await wait(5);
    // «ب» بلا اتصال منذ قبل الاعتماد يرى الاقتراح نفسه ويعتمده (المعرّفات نفسها)
    const sb = collectionSuggestions(B.db, bank);
    approveCollection(B.db, sb[0].line.id, sb[0].target);
    expect(B.db.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [c])!.id).toBe(pay);
    await B.sync();
    for (let i = 0; i < 3; i++) { await ownerSync(); await ownerSync(); await A.sync(); await B.sync(); }

    const view = (db: DB) => ({
      cancelled: db.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [pay])!.c != null,
      liveOnReversed: Number(db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
         WHERE p.id = ? AND p.cancelled_at IS NULL AND e.reversed_by IS NOT NULL`, [pay])!.n),
      paidMatchesBank: Number(db.get<{ n: number }>(`SELECT paid_halalas AS n FROM contract_installments WHERE contract_id = ? ORDER BY due_date, sort LIMIT 1`, [c])!.n)
        === bankBalance(db, bank),
      failing: integrityChecks(db).filter((x) => !x.ok).map((x) => x.name),
    });
    const all = { owner: view(O), memberA: view(A.db), memberB: view(B.db) };
    // (الواقع: المالك دفعةٌ حيّة بقيدٍ معكوس والقسط مسدَّد 1,000 والبنك صفر وفحص «كل دفعة محصَّلة لها قيد مرحّل» أحمر · «أ» ملغاة ·
    //  «ب» حيّة وقيده غير معكوس والبنك صفر وفحص «مرآة واحدة لكل أصل» أحمر)
    const sound = (v: ReturnType<typeof view>) => ({ liveOnReversed: v.liveOnReversed, paidMatchesBank: v.paidMatchesBank, failing: v.failing });
    const ok = { liveOnReversed: 0, paidMatchesBank: true, failing: [] };
    expect({
      agree: new Set([all.owner.cancelled, all.memberA.cancelled, all.memberB.cancelled]).size === 1,
      owner: sound(all.owner), memberA: sound(all.memberA), memberB: sound(all.memberB),
    }).toEqual({ agree: true, owner: ok, memberA: ok, memberB: ok });
    O.close(); A.db.close(); B.db.close();
  });
});
