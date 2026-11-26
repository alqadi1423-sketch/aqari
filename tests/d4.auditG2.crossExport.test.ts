/**
 * المدقق G2 · الجولة السابعة عشرة · على 3f2c136 · محصِّلان يقرآن صيغتين للشهر نفسه (CSV بأرصدةٍ وMT940 بلا رصيد) ويعتمدان الإيداع
 * الواحد لهدفين، والمالك يسحب بعدهما: جهاز المالك يقبل التحصيلين · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditG2.crossExport.test.ts
 *
 * G2-3 · عالٍ · src/sync/engine.ts:697-712 (liveDepositCollection: التحصيلات في القاعدة تُعدّ بـ «JOIN bank_statement_lines l ON l.id =
 * e.stmt_line_id» فقيدٌ سطره ما زال في الوارد لا يُعدّ، والسطر من الوارد يُقرأ للقيد الوارد نفسه وحده · E2-4) مع engine.ts:716-718 (cap
 * بسطور الجدول وحدها) وsrc/db/syncTables.ts:47 و95 (القيود قبل سطور الكشف في ترتيب التطبيق):
 * المالك لم يقرأ كشف أكتوبر · المحصِّل الأول (البنوك ٣ والتحصيل ٣) يقرأ تصدير CSV بعمود رصيد، والثاني يقرأ ملف MT940 للشهر نفسه (بلا
 * رصيد)، وفيه إيداعٌ واحد 2,500 يوم 1 أكتوبر · البصمتان «@250000» و«#1» فالمعرّفان مختلفان (Y3 يجمع القراءتين المتطابقتين وحدهما)،
 * و«#1» مع ذي رصيدٍ في القاعدة نفسها حوالةٌ واحدة (C2-1 وE2-1: أكبر عددٍ في كشفٍ واحد 1) · الأول يعتمده لقسط ماجد والثاني لقسط سالم
 * («تحتاج مراجعة» بالمبلغ والتاريخ) · المالك يسحب: قيد الأول يُقبل (لا تحصيل قبله)، وقيد الثاني لا يرى قيد الأول لأن سطر الأول في الوارد
 * لم يُطبَّق بعد فيُقبل · ثم تصل السطور فيحذف مرور التوأم «#1» ويُبقي «@250000» · دفعتان حيّتان من إيداعٍ واحد، والبنك في الدفاتر 5,000
 * والكشف 2,500، ولا شيء في «المرفوض» · ولو سحب المالك بين الرفعين لرُفض الثاني «تحصيلاً ثانياً» (جُرّب): النتيجة بترتيب الوصول.
 * لماذا يهم: هو E2-4 بقراءتين مختلفتين للإيداع نفسه بدل الملف نفسه، وDESIGN §١٣.٢٢ يقول «السطر نفسه أو بصمته إيداعٌ واحد ولو لم يصل
 * سطره بعد فيُقرأ من الوارد» · والمنشآت تأخذ MT940 والموظفون PDF أو Excel للحساب نفسه · قسطٌ يُسدَّد بلا مال، وإيرادٌ وبنكٌ مضاعفان ·
 * وليس من «جهازي المالك بلا حَكَم» (§٥ · ٢): الكاتبان عضوان.
 * السلوك الصحيح: عدّ التحصيلات وعدد الإيداعات في القاعدة يشمل ما في الوارد من سطور الكشف (أو ينتظرها) فلا يتغيّر الحكم بترتيب الوصول:
 * دفعةٌ حيّة واحدة، والبنك 2,500، والآخر في «المرفوض» تحصيلاً ثانياً.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementGrid, readStatementFile, type StatementResult } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditE2.lineLate.test.ts */
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

test('G2-3 · [عالٍ] محصِّلان يعتمدان إيداعاً واحداً لهدفين من تصديرين مختلفين (CSV وMT940): جهاز المالك يقبل تحصيلاً واحداً والبنك 2,500', async () => {
  const ORG = 'owner-g2-3';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع G2-3', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع G2-3' });
  const contracts: string[] = [];
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    contracts.push(confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'G23-' + n }), {
      tenant, idNumber: '100000430' + n, phone: '050000430' + n, valueHalalas: 3000000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    })));
  }
  await ownerSync();
  const c1 = memberDevice(r, ORG, 'member-g2-3a', { banks: 3, collect: 3 });
  const c2 = memberDevice(r, ORG, 'member-g2-3b', { banks: 3, collect: 3 });
  for (const m of [c1, c2]) { await m.sync(); await m.sync(); }

  // الإيداع نفسه بصيغتين: تصدير CSV برصيدٍ لكل سطر، وملف MT940 بلا رصيد
  const csv = ok(readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/01', 'حوالة واردة مصطنعة', '', '2,500.00', '2,500.00']]));
  const sta = ok(readStatementFile({ name: 'oct.sta', bytes: new TextEncoder().encode([':20:G23', ':60F:C260930SAR0,00',
    ':61:2610011001C2500,00NTRF//INCOMING', ':86:INCOMING TRANSFER', ':62F:C261001SAR2500,00'].join('\n')) }));
  expect([csv.lines.map((l) => [l.date, l.amount, l.balance]), sta.lines.map((l) => [l.date, l.amount, l.balance])])
    .toEqual([[['2026-10-01', 250000, 250000]], [['2026-10-01', 250000, null]]]);
  saveStatement(c1.db, bank, csv, { name: 'oct-g2-3.csv', hash: 'g2-3-csv' });
  saveStatement(c2.db, bank, sta, { name: 'oct-g2-3.sta', hash: 'g2-3-sta' });
  const keys: string[] = [];
  for (const [m, contract] of [[c1, contracts[0]], [c2, contracts[1]]] as const) {
    const line = m.db.get<{ id: string; k: string }>(`SELECT id, line_key AS k FROM bank_statement_lines`)!;
    keys.push(line.k);
    const inst = m.db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [contract])!.id;
    approveCollection(m.db, line.id, { kind: 'installments', contractId: contract, installmentIds: [inst] });
  }
  // (البصمتان «@250000» و«#1» بالقاعدة نفسها)
  expect([keys[0].split('@')[0] === keys[1].split('#')[0], keys[0].endsWith('@250000'), keys[1].endsWith('#1')]).toEqual([true, true, true]);
  await c1.sync(); await c2.sync();
  await ownerSync(); await ownerSync();

  const view = {
    livePayments: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE cancelled_at IS NULL`)!.n),
    bank: bankBalance(O, bank),
    liveLines: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_statement_lines WHERE deleted_at IS NULL`)!.n),
    rejectedTwice: Number(O.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects WHERE tbl = 'journal_entries'`)!.n),
  };
  // (الواقع: دفعتان حيّتان (ماجد وسالم)، والبنك 500,000، وسطرٌ حيٌّ واحد، ولا مرفوض)
  expect(view).toEqual({ livePayments: 1, bank: 250000, liveLines: 1, rejectedTwice: 1 });
  O.close(); c1.db.close(); c2.db.close();
});
