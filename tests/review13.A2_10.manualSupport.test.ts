/**
 * A2.10 · متوسط · src/domain/accounting/post.ts (postManualEntry) · app/journal.tsx · قرار المالك س٢٠ (2026-11-13: موافق على التوصية)
 *
 * السيناريو (بيانات مصطنعة): قيدٌ يدوي على 2410 أو 2400 أو 1250 أو 1200 أو 2450 أو 1270 أو حسابات الأصول بلا أصل يغيّر الدفتر ولا
 * يغيّر سجلّه المساند، فتحمرّ فحوص المطابقة ولا يصلحها إلا عكسه · وكل سطر 1100 في القيد اليدوي كان محفظةً: دفع ضريبة الربع للهيئة
 * ١٬٩٥٠٫٠٠ من البنك كان يُنقص المحفظة لا البنك، أو يُرفض لعدم كفايتها.
 * القرار (س٢٠): يُمنع للعضو برسالةٍ تسمّي الشاشة الصحيحة، ويُقبل للمالك بتنبيهٍ صريح، وتُضاف خانة «البنك» لسطر النقدية.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { postManualEntry, saveManualDraft, postDraftEntry } from '@/domain/accounting/post';
import { supportingAccountsIn, SupportingAccountsError } from '@/domain/accounting/manualGuard';
import { reverseFromJournal } from '@/domain/accounting/journalReversal';
import { ownerCashIn, depositCashToBank } from '@/domain/cashOps';
import { CashShortfallError } from '@/domain/cashGuard';
import { walletCashBalance, bankBalance, accountBalance } from '@/domain/accounting/ledger';
import { pair, sync, ownerPulls, MEMBER, reasonOf } from './helpers/rederive';
import { t } from '@/i18n';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

const asMemberDevice = (db: DB) =>
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'org-a210', profile: { name: 'عضو مصطنع' } })]);
const L = (account: string, debit: number, credit: number) => ({ account, debit, credit });

test('A2.10 الحسابات المساندة تُعرف بأسمائها وشاشاتها · والعادية لا', () => {
  const db = memDb();
  const hits = supportingAccountsIn(db, [L('2410', 100, 0), L('1200', 0, 50), L('1410', 0, 50), L('5400', 10, 0), L('1100', 0, 10)]);
  expect(hits.map((h) => h.code)).toEqual(['2410', '1200', '1410']);
  expect(hits[1].screen).toBe(t('journal.supportScreen.invoices'));
  expect(supportingAccountsIn(db, [L('2200', 195000, 0), L('1100', 0, 195000)])).toEqual([]);
  db.close();
});

test('A2.10 العضو: مسودةٌ على حسابٍ مساند تُمنع برسالةٍ تسمّي الشاشة · والعادية تُحفظ', () => {
  const db = memDb();
  asMemberDevice(db);
  expect(() => saveManualDraft(db, { date: '2026-10-01', memo: 'مصطنع', lines: [L('1250', 5000, 0), L('4300', 0, 5000)] }))
    .toThrow(t('journal.supportScreen.claims'));
  expect(db.get(`SELECT 1 FROM journal_entries`)).toBeUndefined();
  expect(saveManualDraft(db, { date: '2026-10-01', memo: 'مصطنع', lines: [L('5400', 5000, 0), L('2100', 0, 5000)] })).toBeTruthy();
  db.close();
});

test('A2.10 المالك: يُقبل بتنبيهٍ صريح وحده · وترحيل مسودةٍ قديمة على حسابٍ مساند كذلك', () => {
  const db = memDb();
  const lines = [L('2410', 30000, 0), L('4300', 0, 30000)];
  expect(() => postManualEntry(db, { date: '2026-10-01', memo: 'مصطنع', lines })).toThrow(SupportingAccountsError);
  expect(db.get(`SELECT 1 FROM journal_entries`)).toBeUndefined();
  postManualEntry(db, { date: '2026-10-01', memo: 'مصطنع', lines, ackSupport: true });
  expect(accountBalance(db, '2410')).toBe(-30000);
  // مسودةٌ على 1270 (من قبل المنع، أو من جهاز المالك) لا تُرحَّل بلا تنبيه
  const d = saveManualDraftAsLegacy(db, [L('1270', 15000, 0), L('2200', 0, 15000)]);
  expect(() => postDraftEntry(db, d)).toThrow(SupportingAccountsError);
  postDraftEntry(db, d, true);
  expect(accountBalance(db, '1270')).toBe(15000);
  db.close();
});

/** مسودة يدوية كما كانت تُحفظ قبل المنع (بيانات قائمة) */
function saveManualDraftAsLegacy(db: DB, lines: ReturnType<typeof L>[]): string {
  const id = 'legacy-draft';
  db.run(`INSERT INTO journal_entries (id, no, date, memo, status, auto, created_at) VALUES (?, 'JE-LEG', '2026-10-02', 'مسودة قديمة مصطنعة', 'قيد الإنشاء', 0, ?)`,
    [id, new Date().toISOString()]);
  lines.forEach((l, i) => db.run(`INSERT INTO journal_lines (id, entry_id, account_code, descr, debit_halalas, credit_halalas) VALUES (?,?,?,?,?,?)`,
    [id + '-' + i, id, l.account, '', l.debit, l.credit]));
  return id;
}

test('A2.10 خانة البنك لسطر النقدية: سداد ضريبة الربع ١٬٩٥٠٫٠٠ للهيئة من البنك يُنقص البنك لا المحفظة · وعكسه يعيدها إليه', () => {
  const db = memDb();
  const bank = addBank(db, 'بنك ضريبة مصطنع');
  ownerCashIn(db, { amountHalalas: 300000, date: '2026-10-01' });
  depositCashToBank(db, { bankId: bank, amountHalalas: 250000, date: '2026-10-01' });
  const lines = [L('2200', 195000, 0), L('1100', 0, 195000)];
  // نقداً: المحفظة ٥٠٠٫٠٠ لا تكفي
  expect(() => postManualEntry(db, { date: '2026-10-20', memo: 'سداد ضريبة مصطنع', lines })).toThrow(CashShortfallError);
  // وبنكٌ لا يكفي (١٬٩٥٠٫٠٠ > ١٬٠٠٠٫٠٠ في بنكٍ آخر)
  const small = addBank(db, 'بنك صغير مصطنع');
  depositCashToBank(db, { bankId: small, amountHalalas: 10000, date: '2026-10-01' });
  expect(() => postManualEntry(db, { date: '2026-10-20', memo: 'سداد ضريبة مصطنع', lines, bankId: small })).toThrow(t('bankTx.bankShort', { bank: 'بنك صغير مصطنع', balance: '100.00', amount: '1,950.00' }));
  // وبنكٌ بلا سطر نقدية يُرفض
  expect(() => postManualEntry(db, { date: '2026-10-20', memo: 'مصطنع', lines: [L('5400', 100, 0), L('2100', 0, 100)], bankId: bank })).toThrow(t('journal.bankNeedsCash'));
  const e = postManualEntry(db, { date: '2026-10-20', memo: 'سداد ضريبة مصطنع', lines, bankId: bank })!;
  expect([bankBalance(db, bank), walletCashBalance(db), accountBalance(db, '2200')]).toEqual([250000 - 195000, 40000, -195000]);
  expect(db.get(`SELECT amount_halalas AS a, date AS d FROM bank_tx WHERE journal_no = ?`, [e.no])).toEqual({ a: -195000, d: '2026-10-20' });
  reverseFromJournal(db, e.id);
  expect([bankBalance(db, bank), walletCashBalance(db), accountBalance(db, '2200')]).toEqual([250000, 40000, 0]);
  db.close();
});

describe('A2.10 جهاز المالك على مسودة العضو', () => {
  for (const support of [false, true]) {
    test((support ? 'سلبي · مسودةٌ على حسابٍ مساند (مزوَّرة: تطبيق العضو يمنعها): تُرفض' : 'إيجابي · مسودةٌ عادية: تُقبل'), async () => {
      const s = await pair();
      saveManualDraft(s.dev, { date: '2026-10-01', memo: 'مصطنع', lines: [L('5400', 5000, 0), L('2100', 0, 5000)] });
      await sync(s.dev, s.r);
      const d = [...s.r.docs.values()].find((x) => x.t === 'journal_entries')!;
      const lines = support ? d.lines!.map((l) => (l.account_code === '5400' ? { ...l, account_code: '1250' } : l)) : d.lines;
      s.r.inject({ ...d, by: MEMBER, op: 'ledger', lines } as RemoteDoc);
      await ownerPulls(s.owner, s.r);
      expect(!!s.owner.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [d.k])).toBe(!support);
      if (support) expect(reasonOf(s.owner, d.k)).toContain('1250');
      s.close();
    });
  }
});
