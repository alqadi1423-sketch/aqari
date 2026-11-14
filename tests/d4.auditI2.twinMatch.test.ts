/**
 * المدقق I2 · الجولة الثامنة عشرة · على ae6765f · مطابقة المالك اليدوية على سطر MT940 («#1») تُمحى حين يصل من محصِّلٍ سطر الإيداع نفسه بصيغةٍ
 * أخرى («@الرصيد») مطابَقاً بتحصيلٍ يرفضه جهاز المالك · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditI2.twinMatch.test.ts
 *
 * I2-4 · متوسط · src/sync/engine.ts:1079-1083 (statementLineFix: مطابقة السطر المحذوف توأماً تُنقل إلى سطر العضو الباقي «إن كان مفتوحاً» وحده)
 * مع engine.ts:1089-1094 (التوأم المحذوف تُفكّ مطابقته قبل فحص مطابقة الوارد) وengine.ts:1107-1114 (keepHere: يُبقي مطابقةً حيّةً هنا للسطر
 * بمعرّفه نفسه وحده «WHERE l.id = ?»، والسطر الوارد جديدٌ هنا فلا شيء له فيُفكّ) وengine.ts:1123 (حركة الوارد مرفوضة ← keepHere):
 * المالك قرأ كشف أكتوبر MT940 (إيداعٌ واحد 2,500 يوم 1 أكتوبر، بصمته «#1»)، وسجّل تحويل ماجد من شاشة التحصيل، واعتمد اقتراح المطابقة «الجاهز»
 * فطابق السطر بحركته · المحصِّل (البنوك ٣ والتحصيل ٣) لم يسحب بعد، فقرأ تصدير CSV للشهر نفسه بأرصدته («@250000»، معرّفٌ آخر) واعتمد الإيداع
 * لقسط سالم · المالك يسحب: حارس الإيداع يرفض تحصيل المحصِّل «تحصيلاً ثانياً» (صحيح · G2-2 وG2-5)، ثم يصل سطر المحصِّل مطابَقاً بحركته المرفوضة:
 * مرور التوأم يُبقي ذا الرصيد ويحذف سطر المالك ويفكّ مطابقته، ولا تُنقل المطابقة لأن سطر المحصِّل «مطابَق»، ثم keepHere لا يجد لسطر المحصِّل
 * مطابقةً هنا فيعيده مفتوحاً · فالإيداع «في الكشف وحده» وحركة المالك «في الدفاتر وحدها»، وتقرير أكتوبر «المطابَق» صفر، والمطابقة التي اعتمدها
 * المالك ذهبت بلا أثر · ولو وصل سطر المحصِّل مفتوحاً لنُقلت إليه مطابقة المالك (G2-5).
 * لماذا يهم: قاعدة الجولة السابعة عشرة «مطابقةٌ واردة لا تثبت لا تمحو مطابقةً حيّةً هنا» (DESIGN §١٣.٢٢ · سجل القرارات ٦٦(٣)) لا تصدق إن كانت
 * المطابقة الحيّة على توأم السطر لا عليه، وهو المسار الذي يجمع G2-2 وG2-5 (صيغتان للكشف، وتحصيلٌ من أحدهما) · يعيد المالك اعتمادها يدوياً،
 * وتقريره يعرض فرقين متقابلين حتى يفعل · وليس من «جهازي المالك بلا حَكَم» (§٥ · ٢): الكاتب عضو.
 * السلوك الصحيح: مطابقة المالك الحيّة تبقى للإيداع: السطر الباقي مطابَقٌ بحركة المالك، فتقرير أكتوبر «المطابَق» 1 ولا شيء «في الدفاتر وحدها»،
 * وتحصيل المحصِّل في «المرفوض».
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';
import { periodLabel } from '@/domain/dates';
import { readStatementGrid, readStatementFile, type StatementResult } from '@/domain/bankStatement/read';
import { saveStatement, matchSuggestions, approveMatch, reconciliation } from '@/domain/bankStatement/store';
import { approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditG2.manualMatch.test.ts */
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

test('I2-4 · [متوسط] مطابقة المالك على سطر MT940 وسطرٌ من محصِّلٍ بصيغةٍ أخرى مطابَقٌ بتحصيلٍ مرفوض: تبقى مطابقة المالك للإيداع', async () => {
  const ORG = 'owner-i2-4';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع I2-4', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع I2-4' });
  const contracts: string[] = [];
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    contracts.push(confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'I24-' + n }), {
      tenant, idNumber: '100000640' + n, phone: '050000640' + n, valueHalalas: 3000000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    })));
  }
  await ownerSync();
  const collector = memberDevice(r, ORG, 'member-i2-4', { banks: 3, collect: 3 });
  await collector.sync(); await collector.sync();
  const firstInst = (db: DB, c: string) => db.get<{ id: string; due: string }>(
    `SELECT id, due_date AS due FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!;

  // المالك: كشف أكتوبر MT940، وتحويل ماجد من شاشة التحصيل، واعتماد المطابقة «الجاهزة»
  saveStatement(O, bank, ok(readStatementFile({ name: 'oct.sta', bytes: new TextEncoder().encode([':20:I24', ':60F:C260930SAR0,00',
    ':61:2610011001C2500,00NTRF//INCOMING', ':86:INCOMING TRANSFER', ':62F:C261001SAR2500,00'].join('\n')) })), { name: 'oct-i2-4.sta', hash: 'i2-4-sta' });
  const inst = firstInst(O, contracts[0]);
  recordRentPayment(O, contracts[0], { installmentId: inst.id, period: periodLabel(inst.due), date: '2026-10-01',
    lines: [{ method: 'bank', bankId: bank, amountHalalas: 250000 }], discountHalalas: 0, notes: '' });
  const [m] = matchSuggestions(O, bank);
  expect(m.level).toBe('ready');
  approveMatch(O, m.line.id, m.tx.id);
  const ownerTx = m.tx.id;

  // المحصِّل قبل أن يسحب: تصدير CSV للشهر نفسه بأرصدته، ويعتمد الإيداع لقسط سالم
  saveStatement(collector.db, bank, ok(readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/01', 'حوالة واردة مصطنعة', '', '2,500.00', '2,500.00']])), { name: 'oct-i2-4.csv', hash: 'i2-4-csv' });
  const line = collector.db.get<{ id: string; k: string }>(`SELECT id, line_key AS k FROM bank_statement_lines`)!;
  expect(line.k.endsWith('@250000')).toBe(true);
  approveCollection(collector.db, line.id, { kind: 'installments', contractId: contracts[1], installmentIds: [firstInst(collector.db, contracts[1]).id] });
  await collector.sync(); await collector.sync();
  await ownerSync(); await ownerSync();

  const rec = reconciliation(O, bank, '2026-10');
  const view = {
    livePayments: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE cancelled_at IS NULL`)!.n),
    bank: bankBalance(O, bank),
    liveLineTx: O.all<{ tx: string | null }>(`SELECT bank_tx_id AS tx FROM bank_statement_lines WHERE deleted_at IS NULL`).map((x) => x.tx),
    matched: rec.matched,
    onlyInBooks: rec.onlyInBooks.length,
    rejectedEntries: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'journal_entries'`)!.n),
  };
  // (الواقع: دفعةٌ واحدة والبنك 250,000 والمرفوض 1 كما يجب، لكن السطر الحيّ مفتوح [null] و«المطابَق» 0 وحركة المالك «في الدفاتر وحدها» 1)
  expect(view).toEqual({ livePayments: 1, bank: 250000, liveLineTx: [ownerTx], matched: 1, onlyInBooks: 0, rejectedEntries: 1 });
  O.close(); collector.db.close();
});
