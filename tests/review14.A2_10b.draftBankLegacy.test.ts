/**
 * A2.10 (الباقي) × إصدارٌ أقدم · المدقق المستقل للمرحلة ٣ · بيانات مصطنعة.
 *
 * متوسط · src/sync/engine.ts (applyJournal): مسودة العضو ببنكها (الهجرة ٦٧) يرحّلها جهاز مالكٍ بإصدارٍ أقدم (٦٥) من المحفظة، فمستند
 * القيد المرحّل بلا draft_bank_id · والأجهزة على ٦٧ كانت تُبقي البنك على القيد المرحّل (الغياب يُقرأ «بلا بنك» للمسودة وحدها، وupsertRow
 * يترك ما لا يحمله المستند)، فإذا عكسه جهازٌ منها رفع ربط العاكس بالحقل والسحابة بلا حقله، فرفضته القاعدة orgOnlyLinksReversal نهائياً.
 * السلوك الصحيح: غياب الحقل «بلا بنك» دائماً، كما يرفعه buildDoc (الحاضر بنكٌ والغائب لا شيء).
 *
 * منخفض · firestore.rules (orgOnlyLinksReversal): جهازٌ بإصدارٍ أقدم يعكس مسودةً رحّلها مالكٌ على ٦٧ من بنكها، فمستند ربطه بلا الحقل
 * والسحابة به · نزع الحقل وحده في ربط العاكس لا يُعدّ تغييراً (بنك المسودة لا يُقرأ بعد ترحيلها، وحركة البنك صفٌّ مستقل) ·
 * وإضافته أو تغيير قيمته يبقيان مرفوضين.
 *   TZ=Asia/Riyadh npx jest tests/review14.A2_10b.draftBankLegacy.test.ts
 */
import { addBank } from './helpers/fixtures';
import { saveManualDraft, postDraftEntry } from '@/domain/accounting/post';
import { reverseFromJournal } from '@/domain/accounting/journalReversal';
import { ownerCashIn, depositCashToBank } from '@/domain/cashOps';
import { walletCashBalance, bankBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { docId } from '@/sync/engine';
import { pair, sync, ownerPulls, reasonOf, MEMBER } from './helpers/rederive';
import type { MemoryRemote } from './helpers/memoryRemote';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

const L = (account: string, debit: number, credit: number) => ({ account, debit, credit });
// ٢٠٠٫٠٠ تكفيها المحفظة (٥٠٠٫٠٠) والبنك (٢٬٥٠٠٫٠٠)
const TAX = [L('2200', 20000, 0), L('1100', 0, 20000)];
const draftBank = (db: DB, id: string) => db.get<{ b: string | null }>(`SELECT draft_bank_id AS b FROM journal_entries WHERE id = ?`, [id])?.b;
const red = (db: DB) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')');
const cloud = (r: MemoryRemote, id: string) => r.docs.get(docId('journal_entries', id))!;

function funded(db: DB): string {
  const bank = addBank(db, 'بنك ضريبة مصطنع');
  ownerCashIn(db, { amountHalalas: 300000, date: '2026-10-01' });
  depositCashToBank(db, { bankId: bank, amountHalalas: 250000, date: '2026-10-01' });
  return bank;
}

/** مسودة العضو ببنكها على الجهاز الثاني، تصل جهاز المالك بكاتبها العضو */
async function memberDraft() {
  const s = await pair();
  const bank = funded(s.owner);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const d = saveManualDraft(s.dev, { date: '2026-10-20', memo: 'سداد ضريبة مصطنع', lines: TAX, bankId: bank })!;
  await sync(s.dev, s.r);
  s.r.inject({ ...cloud(s.r, d.id), by: MEMBER, op: 'ledger' } as RemoteDoc);
  await ownerPulls(s.owner, s.r);
  expect([draftBank(s.owner, d.id), draftBank(s.dev, d.id)]).toEqual([bank, bank]);
  return { ...s, bank, d };
}

test('مالكٌ بإصدارٍ أقدم يرحّل مسودة البنك من المحفظة: الجهاز على ٦٧ يسقط بنكها، فعكسه منه يُزامَن ولا يُرفض', async () => {
  const s = await memberDraft();
  // الإصدار الأقدم لا يعرف العمود: يرحّلها من المحفظة ومستنده المرحّل بلا الحقل
  s.owner.run(`UPDATE journal_entries SET draft_bank_id = NULL WHERE id = ?`, [s.d.id]);
  postDraftEntry(s.owner, s.d.id);
  expect([bankBalance(s.owner, s.bank), walletCashBalance(s.owner)]).toEqual([250000, 30000]);
  await sync(s.owner, s.r);
  expect('draft_bank_id' in cloud(s.r, s.d.id).d!).toBe(false);

  await sync(s.dev, s.r);
  expect(s.dev.get(`SELECT status AS s FROM journal_entries WHERE id = ?`, [s.d.id])).toEqual({ s: 'مرحّل' });
  // الغياب «بلا بنك» كما في السحابة
  expect(draftBank(s.dev, s.d.id)).toBeNull();
  expect([bankBalance(s.dev, s.bank), walletCashBalance(s.dev)]).toEqual([250000, 30000]);

  const rev = reverseFromJournal(s.dev, s.d.id)!;
  await sync(s.dev, s.r);
  expect(reasonOf(s.dev, s.d.id)).toBe('');
  expect(cloud(s.r, s.d.id).d!.reversed_by).toBe(rev.id);
  await ownerPulls(s.owner, s.r);
  expect(s.owner.get(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [s.d.id])).toEqual({ r: rev.id });
  expect([walletCashBalance(s.owner), walletCashBalance(s.dev)]).toEqual([50000, 50000]);
  expect([...red(s.owner), ...red(s.dev)]).toEqual([]);
  s.close();
});
