/**
 * A2.10 (الباقي) · متوسط · مسودة العضو لا تحمل اختيار البنك · قرار المالك س٢٠ (2026-11-13: «وتُضاف خانة البنك») والقاعدة ٩٩ في سجل
 * القرارات (بنكٌ واحد للقيد على صافي سطور 1100).
 *
 * السيناريو (بيانات مصطنعة): عضو الدفتر يُعدّ مسودة «سداد ضريبة الربع للهيئة» ١٬٩٥٠٫٠٠ من البنك، ولا خانة له ولا عمود يحملها، فيرحّلها
 * المالك من المحفظة: تنقص المحفظة لا البنك، أو تُرفض لعدم كفايتها.
 * السلوك الصحيح: المسودة تحمل البنك (journal_entries.draft_bank_id · الهجرة ٦٧) ويُزامَن معها، وجهاز المالك يرحّلها بحركة بنكٍ مربوطة
 * برقم القيد بتحقق خانة المالك نفسه: البنك قائم، وللقيد صافٍ على 1100، ويكفي البنك من تاريخ القيد فما بعده (A2.8).
 */
import * as path from 'node:path';
import { memDb, tempDir, rmrf } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { schemaAt } from './helpers/oldSchema';
import { makeBackupEnv } from './helpers/backupEnv';
import { saveManualDraft, postDraftEntry } from '@/domain/accounting/post';
import { reverseFromJournal } from '@/domain/accounting/journalReversal';
import { ownerCashIn, depositCashToBank, withdrawCashFromBank } from '@/domain/cashOps';
import { walletCashBalance, bankBalance, accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { MIGRATIONS, SCHEMA_VERSION } from '@/db/schema';
import { migrate, currentSchemaVersion } from '@/db/migrations';
import { createBackup } from '@/domain/backup/create';
import { restoreBackup } from '@/domain/backup/restore';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { t } from '@/i18n';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

const asMemberDevice = (db: DB) =>
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'org-a210b', profile: { name: 'عضو مصطنع' } })]);
const L = (account: string, debit: number, credit: number) => ({ account, debit, credit });
const TAX = [L('2200', 195000, 0), L('1100', 0, 195000)];
const red = (db: DB) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')');
const draftBank = (db: DB, id: string) => db.get<{ b: string | null }>(`SELECT draft_bank_id AS b FROM journal_entries WHERE id = ?`, [id])?.b;

/** المحفظة ٣٬٠٠٠٫٠٠ أودع منها ٢٬٥٠٠٫٠٠ في البنك يوم 10-01: البنك ٢٬٥٠٠٫٠٠ والمحفظة ٥٠٠٫٠٠ */
function funded(db: DB): string {
  const bank = addBank(db, 'بنك ضريبة مصطنع');
  ownerCashIn(db, { amountHalalas: 300000, date: '2026-10-01' });
  depositCashToBank(db, { bankId: bank, amountHalalas: 250000, date: '2026-10-01' });
  return bank;
}

test('الهجرة ٦٧: عمود بنك المسودة فارغٌ للقائم، والإصدار ٦٧', () => {
  expect(SCHEMA_VERSION).toBe(67);
  expect(MIGRATIONS).toHaveLength(67);
  const db = schemaAt(':memory:', 65);
  db.run(`INSERT INTO journal_entries (id, no, date, memo, status, auto, created_at) VALUES ('E65', 'JE-65', '2026-10-02', 'مسودة قائمة مصطنعة', 'قيد الإنشاء', 0, 'x')`);
  migrate(db);
  expect(currentSchemaVersion(db)).toBe(67);
  expect(db.all<{ name: string }>(`PRAGMA table_info(journal_entries)`).map((c) => c.name)).toContain('draft_bank_id');
  expect(draftBank(db, 'E65')).toBeNull();
  db.close();
});

test('العضو: المسودة تحمل البنك بتحقق خانة المالك (بنكٌ قائم، وصافٍ على 1100) · والمالك يرحّلها من البنك لا المحفظة', () => {
  const db = memDb();
  const bank = funded(db);
  asMemberDevice(db);
  expect(() => saveManualDraft(db, { date: '2026-10-20', memo: 'مصطنع', lines: [L('5400', 100, 0), L('2100', 0, 100)], bankId: bank }))
    .toThrow(t('journal.bankNeedsCash'));
  expect(() => saveManualDraft(db, { date: '2026-10-20', memo: 'مصطنع', lines: TAX, bankId: 'لا-بنك' })).toThrow(t('journal.bankMissing'));
  const d = saveManualDraft(db, { date: '2026-10-20', memo: 'سداد ضريبة مصطنع', lines: TAX, bankId: bank })!;
  expect(draftBank(db, d.id)).toBe(bank);
  // المسودة لا تمسّ الأرصدة
  expect([bankBalance(db, bank), walletCashBalance(db)]).toEqual([250000, 50000]);
  db.run(`DELETE FROM sync_state WHERE k = 'membership'`);
  postDraftEntry(db, d.id);
  expect([bankBalance(db, bank), walletCashBalance(db), accountBalance(db, '2200')]).toEqual([250000 - 195000, 50000, -195000]);
  expect(db.get(`SELECT amount_halalas AS a, date AS d, journal_no AS n FROM bank_tx WHERE journal_no = ?`, [d.no])).toEqual({ a: -195000, d: '2026-10-20', n: d.no });
  // وعكسه من الدفتر يعكس حركة بنكه
  reverseFromJournal(db, d.id);
  expect([bankBalance(db, bank), walletCashBalance(db), accountBalance(db, '2200')]).toEqual([250000, 50000, 0]);
  expect(red(db)).toEqual([]);
  db.close();
});

test('المالك يرحّل مسودة البنك بكفاية البنك من تاريخها (A2.8) ويرفض بنكاً حُذف بعدها · ولا شيء يُكتب', () => {
  const db = memDb();
  const bank = funded(db);
  const d = saveManualDraft(db, { date: '2026-10-20', memo: 'سداد ضريبة مصطنع', lines: TAX, bankId: bank })!;
  // البنك يفرغ يوم 10-21 ثم يعود ٢٬٥٠٠٫٠٠ يوم 11-01: يكفي الآن، لكنه يوم 10-21 صفر
  withdrawCashFromBank(db, { bankId: bank, amountHalalas: 250000, date: '2026-10-21' });
  depositCashToBank(db, { bankId: bank, amountHalalas: 250000, date: '2026-11-01' });
  expect(() => postDraftEntry(db, d.id)).toThrow(/21\/10\/2026/);
  expect(db.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = ?`, [d.id])!.s).toBe('قيد الإنشاء');
  expect(bankBalance(db, bank)).toBe(250000);
  // وبنكٌ حُذف بعد حفظ المسودة
  db.run(`UPDATE banks SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), bank]);
  expect(() => postDraftEntry(db, d.id)).toThrow(t('journal.bankMissing'));
  expect(db.get(`SELECT 1 FROM bank_tx WHERE journal_no = ?`, [d.no])).toBeUndefined();
  db.close();
});

test('المزامنة: مسودة العضو ببنكها تصل جهاز المالك فيرحّلها من البنك · والقيد المرحّل بلا بنك لا يحمل العمود في السحابة', async () => {
  const s = await pair();
  const bank = funded(s.owner);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const d = saveManualDraft(s.dev, { date: '2026-10-20', memo: 'سداد ضريبة مصطنع', lines: TAX, bankId: bank })!;
  await sync(s.dev, s.r);
  const doc = [...s.r.docs.values()].find((x) => x.t === 'journal_entries' && x.k === d.id)!;
  expect(doc.d!.draft_bank_id).toBe(bank);
  s.r.inject({ ...doc, by: MEMBER, op: 'ledger' } as RemoteDoc);
  await ownerPulls(s.owner, s.r);
  expect(draftBank(s.owner, d.id)).toBe(bank);
  postDraftEntry(s.owner, d.id);
  expect([bankBalance(s.owner, bank), walletCashBalance(s.owner)]).toEqual([55000, 50000]);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  expect([bankBalance(s.dev, bank), walletCashBalance(s.dev)]).toEqual([55000, 50000]);
  // قيد «إيداع المالك» المرحّل بلا بنك: مستنده بلا العمود، فربط عاكسه من جهازٍ أقدم لا يُعدّ تغييراً في الحقول (orgOnlyLinksReversal)
  const cashIn = [...s.r.docs.values()].find((x) => x.t === 'journal_entries' && x.d?.src_type === 'cash_op')!;
  expect('draft_bank_id' in cashIn.d!).toBe(false);
  s.close();
});

test('النسخة الاحتياطية تحفظ بنك المسودة وتستعيده', async () => {
  const dirs = [tempDir(), tempDir()];
  try {
    const src = makeBackupEnv(dirs[0]);
    const bank = funded(src.db);
    const d = saveManualDraft(src.db, { date: '2026-10-20', memo: 'سداد ضريبة مصطنع', lines: TAX, bankId: bank })!;
    const archive = path.join(src.root, 'out.aqbk');
    await createBackup(src, archive);
    const res = await restoreBackup(makeBackupEnv(dirs[1]), archive);
    expect(draftBank(res.db, d.id)).toBe(bank);
  } finally {
    for (const x of dirs) rmrf(x);
  }
});
