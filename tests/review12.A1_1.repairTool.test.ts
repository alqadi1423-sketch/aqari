/**
 * المراجعة الشاملة 2026-11-13 · A1-1 (البيانات القائمة) · بيانات مصطنعة كلها، والأرقام بالهللة محسوبة باليد (١ ريال = ١٠٠).
 *
 * الإصلاح في الخدمة يمنع اليوم ترحيل تأمينٍ سُوّي · وما رحّله الإصدار السابق باقٍ: العقد المجدَّد يحمل تأميناً لم يُقبض، وقيد الترحيل
 * 2400/2400 حيّ، فالفحص الثالث أحمر وتسوية المجدَّد تعرض ردّه ثانية · الأداة في «فحص المطابقة» تسرد كل عقدٍ مجدَّد رُحِّل تأمينه بعد
 * تسوية سلفه، وتعكس الترحيل وتنزل تأمين الجديد بما رُحِّل (لا تحت ما قُبض له فعلاً) بموافقة المالك.
 *
 * الحالة المعيبة تُبنى كما بناها renewContract القديم: التجديد بلا ترحيل، ثم قيد الترحيل نفسه (postDepositCarry) بتاريخ بداية
 * التجديد أو تاريخ التصحيح، وتأمين الجديد = تأمين السابق + الزيادة (totalDeposit).
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, saveDepositSettlement, renewContract } from '@/domain/contracts/service';
import { getContract } from '@/domain/contracts/rules';
import { ownerCashIn } from '@/domain/cashOps';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks, DEPOSIT_CHECK_NAME } from '@/domain/accounting/integrity';
import { postDepositCarry } from '@/domain/accounting/post';
import { correctionDate, fileVatReturn, isFiledDate } from '@/domain/vatFilings';
import { today } from '@/domain/dates';
import { carryAfterSettleItems, reverseCarryAfterSettle } from '@/domain/contracts/carryRepair';
import { t } from '@/i18n';
import type { DB } from '@/db/adapter';

const renewInput = (start: string, end: string, extra = 0) => ({
  start, end, valueHalalas: 300000, cycle: 'شهرية', carryDeposit: false, extraDepositHalalas: extra,
  services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '',
});

/** التجديد كما كان قبل الإصلاح: ترحيل التأمين ولو سُوّي (service.ts قبل A1-1) */
function oldRenew(db: DB, a: string, start: string, end: string, extra = 0): string {
  const prev = getContract(db, a)!;
  const b = renewContract(db, a, renewInput(start, end, extra));
  const nb = getContract(db, b)!;
  postDepositCarry(db, { fromNo: prev.contract_no || '', toNo: nb.contract_no || '', toId: b, fromId: a,
    deposit: Number(prev.deposit_halalas), date: correctionDate(db, start) });
  db.run(`UPDATE contracts SET deposit_halalas = deposit_halalas + ? WHERE id = ?`, [Number(prev.deposit_halalas), b]);
  return b;
}

const check3 = (db: DB) => integrityChecks(db).find((x) => x.name === DEPOSIT_CHECK_NAME)!;
const depositOf = (db: DB, id: string) => Number(db.get<{ d: number }>(`SELECT deposit_halalas AS d FROM contracts WHERE id = ?`, [id])!.d);
/** التزام 2400 بعقده (دائنه موجب) */
const liability = (db: DB, contractId: string) => Number(db.get<{ n: number }>(
  `SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
   WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL AND l.account_code = '2400' AND l.contract_id = ?`, [contractId])!.n);
const entries = (db: DB) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n);
const audits = (db: DB) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log`)!.n);
const carryLive = (db: DB, b: string) => !!db.get(
  `SELECT 1 FROM journal_entries WHERE src_type = 'deposit_carry' AND src_id = ? AND reversed_by IS NULL AND deleted_at IS NULL`, [b]);
const refund = (n: number) => ({ deductionHalalas: 0, deductionReason: '', refundHalalas: n, notes: '' });

/** عقد (أ) من 2026-01-01 إلى 2026-06-30 بتأمين ١٬٠٠٠ لدى جهته، سُوّي في 2026-07-01 بردّه كاملاً · ثم تجديده (ب) بالترحيل القديم */
function badState(holder: string = 'المكتب', extra = 0) {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 500000, date: '2026-01-01' });
  const u = addUnit(db, addProperty(db, { name: 'عقار أداة الترحيل المصطنع' }), { unit_no: 'TR-1' });
  const a = confirmContract(db, { ...contractInput(u, { tenant: 'مستأجر أداة الترحيل', idNumber: '1000012101',
    valueHalalas: 600000, start: '2026-01-01', end: '2026-06-30', depositHalalas: 100000 }),
    depositHolder: holder, depositHolderName: holder === 'طرف آخر' ? 'وسيط مصطنع' : '' });
  saveDepositSettlement(db, a, { date: '2026-07-01', ...refund(100000) });
  const b = oldRenew(db, a, '2026-07-01', '2026-09-30', extra);
  return { db, a, b };
}

test('المكتب: الفحص الثالث أحمر، والأداة تعكس الترحيل وتصفّر تأمين الجديد، ولا يتحرك شيء آخر', () => {
  const { db, a, b } = badState();
  // الحالة المعيبة: النقد ٥٬٠٠٠ (إيداع ٥٬٠٠٠ + تأمين ١٬٠٠٠ − ردّه ١٬٠٠٠) · 2400 صفر، والتزام (أ) −١٬٠٠٠ و(ب) +١٬٠٠٠
  expect(accountBalance(db, '1100')).toBe(500000);
  expect(accountBalance(db, '2400')).toBe(0);
  expect([liability(db, a), liability(db, b)]).toEqual([-100000, 100000]);
  expect(depositOf(db, b)).toBe(100000);
  expect(check3(db).ok).toBe(false);
  expect(check3(db).value).toBe('0.00 / 1,000.00');

  const items = carryAfterSettleItems(db);
  expect(items).toHaveLength(1);
  const it0 = items[0];
  expect(it0.renewalId).toBe(b);
  expect(it0.prevId).toBe(a);
  expect([it0.carried, it0.deposit, it0.received, it0.target]).toEqual([100000, 100000, 0, 0]);
  expect([it0.settledOn, it0.reverseOn]).toEqual(['2026-07-01', '2026-07-01']);
  expect(it0.blocked).toBeUndefined();

  const before = entries(db);
  expect(reverseCarryAfterSettle(db, b)).toBe(true);
  // قيدٌ عاكسٌ واحد بتاريخ أصله (فترته مفتوحة)، مرآةٌ بأبعاده: التزام (أ) يعود صفراً و(ب) صفراً
  expect(entries(db)).toBe(before + 1);
  const rev = db.get<{ date: string; src_type: string; src_id: string }>(
    `SELECT r.date, r.src_type, r.src_id FROM journal_entries e JOIN journal_entries r ON r.id = e.reversed_by
     WHERE e.src_type = 'deposit_carry' AND e.src_id = ?`, [b])!;
  expect(rev).toEqual({ date: '2026-07-01', src_type: 'deposit_carry_rev', src_id: b });
  expect([liability(db, a), liability(db, b)]).toEqual([0, 0]);
  expect(accountBalance(db, '2400')).toBe(0);
  expect(accountBalance(db, '1100')).toBe(500000); // النقد لم يتحرك
  expect(depositOf(db, b)).toBe(0);
  expect(depositOf(db, a)).toBe(100000); // تأمين السابق كما سُوّي
  expect(check3(db)).toMatchObject({ ok: true, value: '0.00 / 0.00' });
  expect(integrityChecks(db).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  expect(db.get(`SELECT 1 FROM audit_log WHERE entity_type = ? AND before_json LIKE '%100000%'`, [t('carryRepair.auditEntity', { lng: 'ar' })])).toBeTruthy();
  expect(carryAfterSettleItems(db)).toEqual([]);

  // تسوية (ب) بعد انتهائه لا تعرض ردّ ما لم يُقبض: ردّ ١٬٠٠٠ مرفوض، والتسوية الصفرية تُحفظ ولا يخرج نقد
  expect(() => saveDepositSettlement(db, b, { date: '2026-10-01', ...refund(100000) })).toThrow(t('deposit.refundOver'));
  saveDepositSettlement(db, b, { date: '2026-10-01', ...refund(0) });
  expect([accountBalance(db, '1100'), accountBalance(db, '2400')]).toEqual([500000, 0]);
  expect(check3(db).ok).toBe(true);
  db.close();
});

test('مكررة: التطبيق الثاني لا يغيّر شيئاً', () => {
  const { db, b } = badState();
  expect(reverseCarryAfterSettle(db, b)).toBe(true);
  const [n, au] = [entries(db), audits(db)];
  expect(reverseCarryAfterSettle(db, b)).toBe(false);
  expect([entries(db), audits(db), depositOf(db, b)]).toEqual([n, au, 0]);
  expect(check3(db).ok).toBe(true);
  db.close();
});

test('زيادة قُبضت في التجديد: ينزل تأمين الجديد بالمرحَّل وحده ويبقى ما قُبض له', () => {
  // (ب) بترحيل ١٬٠٠٠ وزيادة ٥٠٠ قُبضت نقداً: تأمينه ١٬٥٠٠ والدفتر ٥٠٠ · النقد ٥٬٥٠٠
  const { db, a, b } = badState('المكتب', 50000);
  expect(depositOf(db, b)).toBe(150000);
  expect(accountBalance(db, '1100')).toBe(550000);
  expect(check3(db)).toMatchObject({ ok: false, value: '500.00 / 1,500.00' });
  const [x] = carryAfterSettleItems(db);
  expect([x.carried, x.deposit, x.received, x.target]).toEqual([100000, 150000, 50000, 50000]);
  expect(reverseCarryAfterSettle(db, b)).toBe(true);
  expect(depositOf(db, b)).toBe(50000);
  expect([liability(db, a), liability(db, b)]).toEqual([0, 50000]);
  expect([accountBalance(db, '1100'), accountBalance(db, '2400')]).toEqual([550000, 50000]);
  expect(check3(db)).toMatchObject({ ok: true, value: '500.00 / 500.00' });
  // التسوية تعرض ٥٠٠ وحدها: ردّ ١٬٥٠٠ مرفوض، وردّ ٥٠٠ يُخرجها نقداً فيعود النقد ٥٬٠٠٠
  expect(() => saveDepositSettlement(db, b, { date: '2026-10-01', ...refund(150000) })).toThrow(t('deposit.refundOver'));
  saveDepositSettlement(db, b, { date: '2026-10-01', ...refund(50000) });
  expect([accountBalance(db, '1100'), accountBalance(db, '2400')]).toEqual([500000, 0]);
  expect(check3(db).ok).toBe(true);
  db.close();
});

test('منصة إيجار: محتجزات 1260 لا تتحرك والفحص يعود أخضر', () => {
  const { db, b } = badState('منصة إيجار');
  expect([accountBalance(db, '1260'), accountBalance(db, '2400'), accountBalance(db, '1100')]).toEqual([0, 0, 500000]);
  expect(check3(db)).toMatchObject({ ok: false, value: '0.00 / 1,000.00' });
  expect(carryAfterSettleItems(db)[0]).toMatchObject({ holder: 'منصة إيجار', carried: 100000, target: 0 });
  expect(reverseCarryAfterSettle(db, b)).toBe(true);
  expect([accountBalance(db, '1260'), accountBalance(db, '2400'), accountBalance(db, '1100')]).toEqual([0, 0, 500000]);
  expect(depositOf(db, b)).toBe(0);
  expect(check3(db)).toMatchObject({ ok: true, value: '0.00 / 0.00' });
  db.close();
});

test('طرف آخر: الفحص لا يراه لكن التسوية كانت تعرض ردّه ثانية · الأداة تسرده وتصلحه', () => {
  const { db, a, b } = badState('طرف آخر');
  // التأمين لم يدخل الدفتر · والترحيل القديم 2400/2400 بأبعاد العقدين
  expect(accountBalance(db, '2400')).toBe(0);
  expect([liability(db, a), liability(db, b)]).toEqual([-100000, 100000]);
  expect(check3(db).ok).toBe(true);
  const [x] = carryAfterSettleItems(db);
  expect(x).toMatchObject({ renewalId: b, holder: 'طرف آخر', carried: 100000, deposit: 100000, received: 0, target: 0 });
  expect(reverseCarryAfterSettle(db, b)).toBe(true);
  expect([liability(db, a), liability(db, b)]).toEqual([0, 0]);
  expect(depositOf(db, b)).toBe(0);
  expect(accountBalance(db, '1100')).toBe(500000);
  expect(() => saveDepositSettlement(db, b, { date: '2026-10-01', ...refund(100000) })).toThrow(t('deposit.refundOver'));
  db.close();
});

test('المجدَّد سُوّي تأمينه بعد الترحيل: مرفوضة برسالةٍ تشرح البديل ولا يتغير شيء', () => {
  const { db, a, b } = badState();
  // سُوّي (ب) بردّ ١٬٠٠٠ لم يُقبض: خرج النقد ثانية (٤٬٠٠٠) و2400 = −١٬٠٠٠
  saveDepositSettlement(db, b, { date: '2026-10-01', ...refund(100000) });
  expect([accountBalance(db, '1100'), accountBalance(db, '2400')]).toEqual([400000, -100000]);
  const [x] = carryAfterSettleItems(db);
  const nb = getContract(db, b)!.contract_no || '';
  const msg = t('carryRepair.renewalSettled', { to: nb, date: '01/10/2026', amount: '1,000.00' });
  expect(x.blocked).toBe(msg);
  const [n, au] = [entries(db), audits(db)];
  expect(() => reverseCarryAfterSettle(db, b)).toThrow(msg);
  expect([entries(db), audits(db), depositOf(db, b), carryLive(db, b)]).toEqual([n, au, 100000, true]);
  expect([liability(db, a), accountBalance(db, '1100')]).toEqual([-100000, 400000]);
  db.close();
});

test('رُحِّل تأمين المجدَّد بعدُ إلى تجديده: مرفوضة برسالة ولا يتغير شيء', () => {
  const { db, b } = badState();
  const c = renewContract(db, b, { ...renewInput('2026-10-01', '2026-12-31'), carryDeposit: true });
  expect(depositOf(db, c)).toBe(100000);
  const [x] = carryAfterSettleItems(db);
  expect(x.renewalId).toBe(b);
  const msg = t('carryRepair.carriedOn', { to: getContract(db, b)!.contract_no || '', next: getContract(db, c)!.contract_no || '' });
  expect(x.blocked).toBe(msg);
  const n = entries(db);
  expect(() => reverseCarryAfterSettle(db, b)).toThrow(msg);
  expect([entries(db), depositOf(db, b), depositOf(db, c), carryLive(db, b)]).toEqual([n, 100000, 100000, true]);
  db.close();
});

test('قيد الترحيل في ربعٍ قُدِّم إقراره: العاكس بتاريخ اليوم المفتوح لا في الربع المقدَّم', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 500000, date: '2026-01-01' });
  const u = addUnit(db, addProperty(db, { name: 'عقار ربعٍ مقدَّمٍ مصطنع' }), { unit_no: 'TR-2' });
  const a = confirmContract(db, contractInput(u, { tenant: 'مستأجر ربعٍ مقدَّم', idNumber: '1000012102',
    valueHalalas: 300000, start: '2026-01-01', end: '2026-03-31', depositHalalas: 100000 }));
  saveDepositSettlement(db, a, { date: '2026-04-01', ...refund(100000) });
  const b = oldRenew(db, a, '2026-04-01', '2026-06-30');
  fileVatReturn(db, 2026, 2);
  expect(isFiledDate(db, '2026-04-01')).toBe(true);
  expect(check3(db).ok).toBe(false);
  expect(carryAfterSettleItems(db)[0].reverseOn).toBe(today());
  expect(reverseCarryAfterSettle(db, b)).toBe(true);
  const rev = db.get<{ date: string }>(`SELECT date FROM journal_entries WHERE src_type = 'deposit_carry_rev' AND src_id = ?`, [b])!;
  expect(rev.date).toBe(correctionDate(db, '2026-04-01'));
  expect(rev.date).toBe(today());
  expect(isFiledDate(db, rev.date)).toBe(false);
  expect([liability(db, a), liability(db, b), depositOf(db, b)]).toEqual([0, 0, 0]);
  expect(check3(db)).toMatchObject({ ok: true, value: '0.00 / 0.00' });
  db.close();
});

test('جهاز العضو: لا قائمة ولا تطبيق', () => {
  const { db, b } = badState();
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'O', profile: { name: 'عضو مصطنع' } })]);
  expect(carryAfterSettleItems(db)).toEqual([]);
  const n = entries(db);
  expect(() => reverseCarryAfterSettle(db, b)).toThrow(t('carryRepair.ownerOnly'));
  expect([entries(db), depositOf(db, b), carryLive(db, b)]).toEqual([n, 100000, true]);
  db.close();
});

test('التجديد الصحيح (السابق لم يُسوَّ) لا يُسرد', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار تجديدٍ سليمٍ مصطنع' }), { unit_no: 'TR-3' });
  const a = confirmContract(db, contractInput(u, { tenant: 'مستأجر تجديدٍ سليم', idNumber: '1000012103',
    valueHalalas: 600000, start: '2026-01-01', end: '2026-06-30', depositHalalas: 100000 }));
  const b = renewContract(db, a, { ...renewInput('2026-07-01', '2026-09-30'), carryDeposit: true });
  expect(carryLive(db, b)).toBe(true);
  expect(carryAfterSettleItems(db)).toEqual([]);
  expect(reverseCarryAfterSettle(db, b)).toBe(false);
  expect(carryLive(db, b)).toBe(true);
  db.close();
});
