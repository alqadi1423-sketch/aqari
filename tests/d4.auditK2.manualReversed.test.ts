/**
 * المدقق K2 · الجولة التاسعة عشرة · على 5c203a6 · المطابقة اليدوية التي يعدّها حارس الإيداع محجوزةً لا تنظر في عكسٍ لقيدها ينتظر في الوارد:
 * محصِّلٌ يصحّح مطابقةً خاطئة (يفكّها، ويعتمد الإيداع لصاحبه، ثم يلغي الدفعة الخاطئة) فيُرفض تحصيله الصحيح رفضاً نهائياً · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditK2.manualReversed.test.ts
 *
 * K2-3 · متوسط · src/sync/engine.ts:733-739 (liveDepositCollection: «manual» يعدّ السطر المطابَق يدوياً محجوزاً إن كان قيد حركته حيّاً هنا
 * «reversed_by IS NULL»، ولا يسأل reversalPending كما يُسأل للتحصيلات من الكشف في engine.ts:740) مع engine.ts:742-743 (same ← يُعاد معرّف
 * الحركة فيُرفض) وengine.ts:2042-2044 (الرفض نهائي، لا «retry») · والنسخة القديمة للسطر هنا تُقدَّم على نسخته الواردة (versions: ما هنا أولاً):
 * المالك قرأ كشف أكتوبر (إيداعٌ واحد 2,500 يوم 1 أكتوبر، بيانه «TRANSFER SALEM»)، وسجّل خطأً تحويلاً من ماجد بالمبلغ واليوم نفسيهما من شاشة
 * التحصيل، واعتمد مطابقة السطر به · المحصِّل (البنوك ٣ والتحصيل ٣) يرى الخطأ: يلغي مطابقة السطر، ويعتمد الإيداع لقسط سالم من الكشف، ثم يلغي دفعة
 * ماجد الخاطئة بسببها · دفاتره صحيحة: دفعة سالم حيّة ودفعة ماجد ملغاة والبنك 2,500 · يرفع · المالك يسحب: القيود بترتيب وقتها، فقيد سالم قبل عاكس
 * دفعة ماجد، والحارس يجد السطر هنا «مطابَقاً» بحركة دفعة ماجد وقيدها لم يُعكس بعد (عاكسه في الوارد نفسه) ← «تحصيلٌ ثانٍ» مرفوض · ثم يُطبَّق عاكس
 * ماجد وإلغاء دفعته · فعلى جهاز المالك لا دفعة حيّة لإيداعٍ حقيقي، وقسط سالم قائمٌ وقد دفع، والبنك صفر والكشف 2,500.
 * لماذا يهم: التحصيلات من الكشف يُنتظر عكسها إن كان في الطريق (A2-3 وB2-3: «ينتظر لا يرفض»)، والمطابقة اليدوية التي أضافتها الجولتان السابعة
 * عشرة والثامنة عشرة (G2-2 وI2-1) لا تُنتظر · تصحيح خطأٍ في الدفاتر بخطواتٍ مدعومة كلها ينتهي بمالٍ دخل البنك لا يظهر في دفاتر المالك ومستأجرٍ
 * دفع يبقى مطالَباً، والرفض نهائي فلا تعيده مزامنةٌ تالية · وليس من «جهازي المالك بلا حَكَم» (§٥ · ٢): الكاتب عضو.
 * السلوك الصحيح: مطابقةٌ يدوية قيد حركتها في طريقه إلى العكس لا تحجز الإيداع (ينتظر التحصيل كما ينتظر أمام تحصيلٍ من الكشف): على جهاز المالك دفعة
 * سالم حيّة ودفعة ماجد ملغاة، والبنك 250,000 هللة، ولا قيد مرفوض.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { bankBalance } from '@/domain/accounting/ledger';
import { periodLabel } from '@/domain/dates';
import { readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';
import { saveStatement, matchSuggestions, approveMatch, unmatchLine } from '@/domain/bankStatement/store';
import { approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditI2.twinMatch.test.ts */
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
const ok = (r: StatementResult) => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار

test('K2-3 · [متوسط] محصِّلٌ يفكّ مطابقةً خاطئة ويعتمد الإيداع لصاحبه ثم يلغي الدفعة الخاطئة: جهاز المالك يقبل التحصيل الصحيح', async () => {
  const ORG = 'owner-k2-3';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع K2-3', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع K2-3' });
  const contracts: string[] = [];
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    contracts.push(confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'K23-' + n }), {
      tenant, idNumber: '100000730' + n, phone: '050000730' + n, valueHalalas: 3000000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    })));
  }
  const firstInst = (db: DB, c: string) => db.get<{ id: string; due: string }>(
    `SELECT id, due_date AS due FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!;

  // المالك: كشف أكتوبر، وتحويلٌ من ماجد سُجّل خطأً، ومطابقة السطر به
  saveStatement(O, bank, ok(readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/01', 'TRANSFER SALEM', '', '2,500.00', '2,500.00']])), { name: 'oct-k2-3.csv', hash: 'k2-3-csv' });
  const inst = firstInst(O, contracts[0]);
  const wrongPayment = recordRentPayment(O, contracts[0], { installmentId: inst.id, period: periodLabel(inst.due), date: '2026-10-01',
    lines: [{ method: 'bank', bankId: bank, amountHalalas: 250000 }], discountHalalas: 0, notes: '' });
  const [m] = matchSuggestions(O, bank);
  approveMatch(O, m.line.id, m.tx.id);
  await ownerSync();

  const collector = memberDevice(r, ORG, 'member-k2-3', { banks: 3, collect: 3 });
  await collector.sync(); await collector.sync();
  // المحصِّل يصحّح: يفكّ المطابقة، ويعتمد الإيداع لقسط سالم، ثم يلغي دفعة ماجد الخاطئة
  unmatchLine(collector.db, m.line.id);
  approveCollection(collector.db, m.line.id, { kind: 'installments', contractId: contracts[1], installmentIds: [firstInst(collector.db, contracts[1]).id] });
  cancelPayment(collector.db, wrongPayment, { date: '2026-10-02', reason: 'سُجّلت خطأً · الإيداع لسالم' });
  const live = (db: DB) => db.all<{ c: string }>(`SELECT contract_id AS c FROM contract_payments WHERE cancelled_at IS NULL`).map((x) => x.c);
  // (دفاتر المحصِّل صحيحة)
  expect({ live: live(collector.db), bank: bankBalance(collector.db, bank) }).toEqual({ live: [contracts[1]], bank: 250000 });
  await collector.sync(); await collector.sync();
  await ownerSync(); await ownerSync();

  const view = {
    live: live(O),
    bank: bankBalance(O, bank),
    rejected: O.all<{ w: string }>(`SELECT reason AS w FROM sync_rejects WHERE tbl = 'journal_entries'`).map((x) => x.w),
  };
  // (الواقع: لا دفعة حيّة، والبنك 0، وقيد سالم مرفوض «تحصيلٌ ثانٍ» · وبترتيب الإلغاء قبل الاعتماد يُقبل · جُرّب)
  expect(view).toEqual({ live: [contracts[1]], bank: 250000, rejected: [] });
  O.close(); collector.db.close();
});
