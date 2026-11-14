/**
 * المدقق G2 · الجولة السابعة عشرة · على 3f2c136 · جهاز المالك يعيد وقائع سطر العضو (E2-5) ويرفع نسخته «تصحيحاً» بوقت الآن، فتغلب على جهاز
 * العضو تعديلاً حقيقياً له أحدث من نسخته (إلغاء مطابقةٍ خاطئة) فيضيع بلا أثر · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditG2.restoredFactsStamp.test.ts
 *
 * G2-7 · متوسط · src/sync/engine.ts:1437-1441 (collectionRowCheck: نسخة العضو بوقائع أخرى تُطبَّق بوقائع السطر هنا، restoredFacts) مع
 * engine.ts:1007-1010 (statementLineCheck: الإعادة «تغيير» فيُرفع) وengine.ts:2197 («else if (relink) enqueueStmtFix(db, doc.k)»: التصحيح
 * بوقت الآن لا بوقت النسخة الواردة، خلاف statementCascade engine.ts:1157 «بوقت الكشف الوارد لا بوقت الآن … (Y7)») وengine.ts:2026-2038
 * (على جهاز العضو لا علامة تصحيح، فالوارد الأحدث وقتاً يغلب تعديله المعلَّق):
 * المالك سجّل تحويل ماجد (1,000 يوم 2 أكتوبر) وقرأ كشف PDF بيانه «حوالة واردة» · المحصِّل (البنوك ٣) قرأ قبل أن يسحب تصدير Excel للشهر
 * نفسه ببيانٍ أطول (E2-5: البصمة والمعرّف واحدان)، وطابق السطر بالحركة ورفع · ثم رأى أن المطابقة خطأ فألغاها («إلغاء المطابقة» · D2-3)
 * قبل أن يسحب · جهاز المالك يطبّق نسخة المطابقة بوقائعه ويرفعها تصحيحاً بوقت تطبيقها (بعد الإلغاء) · المحصِّل يسحب: التصحيح أحدث من
 * إلغائه المعلَّق فيغلبه ويُحذف من طابوره: السطر مطابَقٌ على الجهازين، والإلغاء لم يصل أحداً · ولو كان البيان واحداً لوصل الإلغاء وصار
 * السطر مفتوحاً على الجهازين (جُرّب): الفرق كله من التصحيح.
 * لماذا يهم: «وقائع السطر بأول ما قُرئ به» (سجل القرارات ٦٥(٣)) شُرطت ألا تمحو عمل العضو («ولا تُرفض فتضيع مطابقتها» · E2-5)، و
 * «تصحيح جهاز المالك للسطر يغلبه أي تعديلٍ حقيقي» (Y7) · وهنا يمحو عمله اللاحق: مطابقةٌ خاطئة تبقى في تقرير المطابقة بحركة غير حركتها،
 * والإيداع لا يعود للاقتراح، ومن ألغاها يرى إلغاءه ينقلب بلا تنبيه.
 * السلوك الصحيح: تصحيح الوقائع لا يغلب تعديلاً حقيقياً من العضو أحدث من النسخة التي صُحّحت (يُرفع بوقتها كما في statementCascade، أو
 * يُدمج): بعد المزامنة السطر مفتوحٌ على الجهازين ببيان المالك.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { periodLabel } from '@/domain/dates';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, approveMatch, unmatchLine } from '@/domain/bankStatement/store';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditE2.secondExport.test.ts */
function memberDevice(r: MemoryRemote, org: string, uid: string, perms: Access['perms']) {
  const M: Access = { owner: false, uid, perms, allProps: true, props: [] };
  const db = memDb();
  enableSync(db, uid);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org, profile: { name: 'محصّل مصطنع' } })]);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [org]);
  const sync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(db, r, getMeta(db, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  return { db, sync };
}
const tick = () => new Promise((res) => setTimeout(res, 20));

test('G2-7 · [متوسط] المحصِّل يلغي مطابقةً خاطئة بعد رفعها وقبل أن يطبّقها المالك: بعد المزامنة السطر مفتوحٌ على الجهازين ببيان المالك', async () => {
  const ORG = 'owner-g2-7';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع G2-7', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع G2-7' });
  const contract = confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'G27-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000004701', phone: '0500004701', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const inst = O.get<{ id: string; due: string }>(`SELECT id, due_date AS due FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [contract])!;
  recordRentPayment(O, contract, { installmentId: inst.id, period: periodLabel(inst.due), date: '2026-10-02',
    lines: [{ method: 'bank', bankId: bank, amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  await ownerSync();
  const collector = memberDevice(r, ORG, 'member-g2-7', { banks: 3, collect: 3 });
  await collector.sync(); await collector.sync();

  const oct = (descr: string) => {
    const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'], ['2026/10/02', descr, '', '1,000.00', '1,000.00']]);
    if (!g.ok) throw new Error(g.error);
    return g;
  };
  // المالك يقرأ كشف PDF ويرفعه
  saveStatement(O, bank, oct('حوالة واردة'), { name: 'oct-g2-7.pdf', hash: 'g2-7-pdf' });
  await ownerSync();
  // المحصِّل (لم يسحب) يقرأ تصدير Excel ببيانٍ أطول (السطر نفسه بمعرّفه) ويطابقه بالحركة ويرفع
  saveStatement(collector.db, bank, oct('حوالة واردة رقم 7731 من بنك مصطنع'), { name: 'oct-g2-7.xlsx', hash: 'g2-7-xlsx' });
  const line = collector.db.get<{ id: string }>(`SELECT id FROM bank_statement_lines`)!.id;
  expect(O.get(`SELECT 1 FROM bank_statement_lines WHERE id = ?`, [line])).toBeTruthy();
  approveMatch(collector.db, line, collector.db.get<{ id: string }>(`SELECT id FROM bank_tx`)!.id);
  await collector.sync();
  // ثم يلغي المطابقة قبل أن يسحب (بعد رفعها، وقبل أن يطبّقها المالك)
  await tick();
  unmatchLine(collector.db, line);
  await tick();
  await ownerSync(); await ownerSync();
  await collector.sync(); await collector.sync();
  await ownerSync(); await ownerSync();
  await collector.sync();

  const state = (db: DB) => db.get<{ s: string; d: string }>(`SELECT status AS s, descr AS d FROM bank_statement_lines WHERE id = ?`, [line])!;
  // (الواقع: السطر «matched» على الجهازين، وإلغاء المحصِّل لم يصل أحداً)
  expect({ owner: state(O), collector: state(collector.db) })
    .toEqual({ owner: { s: 'open', d: 'حوالة واردة' }, collector: { s: 'open', d: 'حوالة واردة' } });
  O.close(); collector.db.close();
});
