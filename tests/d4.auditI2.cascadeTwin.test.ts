/**
 * المدقق I2 · الجولة الثامنة عشرة · على ae6765f · المالك حذف كشف MT940 وأعاد قراءته، وموظف البنوك قرأ تصدير CSV للشهر نفسه بأرصدته: جهاز
 * المالك يُحيي سطور القراءة المحذوفة في كشف الموظف، فيصير الإيداع والرسم مرتين عنده وحده · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditI2.cascadeTwin.test.ts
 *
 * I2-5 · عالٍ · src/sync/engine.ts:1203-1207 (statementCascade: «dupOfLive(db, bankId, k, …)» يفحص بصمة الكشف الوارد «@الرصيد» وهي ذات رصيدٍ
 * فيُبقيها keepInOrder دائماً، ثم يُحيي سطراً محذوفاً «بمعيار sameLineKey» قد يكون «#n» ببصمةٍ أخرى لم تُفحص) مع src/domain/bankStatement/
 * dedupe.ts:51-52 (SAME_KEY_SQL: «#n» يطابق أي ذي رصيدٍ في قاعدته) وsrc/domain/bankStatement/store.ts:45-46 و57 (إعادة القراءة بعد الحذف
 * بمعرّفاتٍ جديدة، فالقديمة تبقى محذوفة · Z1-5):
 * المالك قرأ كشف أكتوبر MT940 (حوالة ماجد 2,500 يوم 1 ورسم 5 يوم 2، بصمتاهما «#1») ثم حذفه وقرأ الملف نفسه ثانيةً (المسار المدعوم لتصحيح
 * قراءة) · موظف البنوك (البنوك ٢) سحب ذلك ثم قرأ تصدير CSV للشهر نفسه بأرصدته (ورسمٌ ثالث يوم 3) فتخطّى الحفظ الحوالة والرسم (صحيح:
 * «#1» هنا) وحفظ رسم يوم 3 · المالك يسحب: لكل بصمةٍ في الكشف الوارد «@350000» و«@349500» يسأل statementCascade هل هي تكرار، وذو الرصيد
 * لا يكون تكراراً، فيُحيي «#1» المحذوفة من القراءة الأولى للحوالة وللرسم في كشف الموظف ويرفعها · عند المالك حوالتا ماجد ورسمان، وتقرير أكتوبر
 * بفرقٍ «غير مفسَّر» −2,495، وعند الموظف (مرور التوأم يحذف المكرَّر بالبصمة نفسها ولا يرفع) سطرٌ واحدٌ لكلٍّ وبلا فرق: الجهازان مختلفان.
 * لماذا يهم: هو X1 (إحياء ما للبصمة سطرٌ حيٌّ آخر) بصيغتين للكشف بدل صيغةٍ واحدة، وكلاهما مسارٌ مدعوم شائع (حذف الكشف وإعادة قراءته، والمنشأة
 * تأخذ MT940 والموظف CSV أو PDF للحساب نفسه) · إيداعٌ وهميٌّ مفتوح «في الكشف وحده» عند المالك يُقترح تحصيلاً (مالٌ يُسجَّل ولم يصل)، ورسمٌ
 * مكرَّر، وتقريرٌ بفرقٍ لا يُعرف سببه · وكل سطرٍ في القراءة المحذوفة يُحيا بهذا المسار، فالكشف كله يتضاعف لا سطرٌ واحد.
 * السلوك الصحيح: لا يُحيا سطرٌ محذوف ببصمته هو تكرارٌ لما هو حيّ (يُفحص بصمة السطر المُحيا لا بصمة الكشف الوارد): بعد المزامنة عند المالك
 * كما عند الموظف حوالة ماجد مرةً ورسم 2 أكتوبر مرةً ورسم 3 أكتوبر، وتقرير أكتوبر بلا فرقٍ غير مفسَّر على الجهازين.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { readStatementFile, readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';
import { saveStatement, deleteStatement, reconciliation } from '@/domain/bankStatement/store';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditG2.manualMatch.test.ts */
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
/** كشف أكتوبر MT940 (بلا رصيدٍ لكل حركة) */
const mt940 = () => ok(readStatementFile({ name: 'oct.sta', bytes: new TextEncoder().encode([':20:I25', ':60F:C260930SAR1000,00',
  ':61:2610011001C2500,00NTRF//MAJED', ':86:TRANSFER MAJED', ':61:2610021002D5,00NCHG//SMS', ':86:SMS CHARGES', ':62F:C261002SAR3495,00'].join('\n')) }));
/** تصدير CSV للشهر نفسه بأرصدته، ومعه رسمٌ يوم 3 */
const csv = () => ok(readStatementGrid([['الرصيد الافتتاحي', '1,000.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
  ['2026/10/01', 'حوالة واردة ماجد', '', '2,500.00', '3,500.00'], ['2026/10/02', 'رسوم رسائل', '5.00', '', '3,495.00'],
  ['2026/10/03', 'رسوم خدمة', '1.00', '', '3,494.00']]));
/** السطور الحيّة يوماً ومبلغاً */
const live = (db: DB, bank: string) => db.all<{ d: string; a: number }>(
  `SELECT date AS d, amount_halalas AS a FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY date, amount_halalas`, [bank])
  .map((x) => `${x.d} ${x.a}`);

test('I2-5 · [عالٍ] قراءة MT940 محذوفةٌ ثم معادة عند المالك، وتصدير CSV من موظف البنوك: لا يُحيي المالك سطور القراءة المحذوفة والتقرير بلا فرق', async () => {
  const ORG = 'owner-i2-5';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع I2-5', 100000);
  // المالك يقرأ الكشف ثم يحذفه ويقرؤه ثانيةً (معرّفاتٌ جديدة، والقديمة محذوفة)
  const first = saveStatement(O, bank, mt940(), { name: 'oct-i2-5.sta', hash: 'i2-5-sta' });
  deleteStatement(O, first.statementId);
  expect(saveStatement(O, bank, mt940(), { name: 'oct-i2-5.sta', hash: 'i2-5-sta' })).toMatchObject({ added: 2, skipped: 0 });
  await ownerSync();

  // موظف البنوك يسحب ثم يقرأ تصدير CSV للشهر نفسه: الحوالة والرسم «#1» عنده فيُتخطّيان، ويُحفظ رسم يوم 3
  const clerk = memberDevice(r, ORG, 'member-i2-5', { banks: 2 });
  await clerk.sync(); await clerk.sync();
  expect(saveStatement(clerk.db, bank, csv(), { name: 'oct-i2-5.csv', hash: 'i2-5-csv' })).toMatchObject({ added: 1, skipped: 2 });
  await clerk.sync(); await clerk.sync();
  await ownerSync(); await ownerSync();
  await clerk.sync(); await clerk.sync();

  const want = ['2026-10-01 250000', '2026-10-02 -500', '2026-10-03 -100'];
  // (الواقع عند المالك: ['2026-10-01 250000', '2026-10-01 250000', '2026-10-02 -500', '2026-10-02 -500', '2026-10-03 -100'] والفرق −249,500،
  //  وعند الموظف السطور الثلاثة بلا فرق)
  expect({ owner: live(O, bank), clerk: live(clerk.db, bank) }).toEqual({ owner: want, clerk: want });
  expect([reconciliation(O, bank, '2026-10').unexplained, reconciliation(clerk.db, bank, '2026-10').unexplained]).toEqual([0, 0]);
  O.close(); clerk.db.close();
});
