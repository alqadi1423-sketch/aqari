/**
 * A2.9 · متوسط · src/domain/purchases.ts (markVatRefunded) · app/purchases.tsx
 *
 * السيناريو (بيانات مصطنعة): فاتورة شراء قابلة للخصم ١٬٠٠٠٫٠٠ + ضريبة ١٥٠٫٠٠، والهيئة تردّ الضريبة بتحويلٍ بنكي في 2026-11-20.
 * الخطأ: الاسترداد كان يدخل المحفظة نقداً بتاريخ اليوم دائماً، بلا بنك ولا تاريخ · فالمحفظة أكبر من الحقيقة والبنك أقل، وإيداع
 * الهيئة في كشف البنك بلا مقابل.
 * السلوك الصحيح: الاسترداد بتاريخٍ وطريقة (نقداً أو بنكاً) كتحصيل المطالبة، وحركة بنكٍ مربوطة برقم القيد · وإلغاؤه يعكسها
 * ولا يُنزل البنك تحت الصفر · وجهاز المالك يقبل ما يكتبه التطبيق من عضوٍ ويرفض حركةً مزوّرة فوق ضريبة الفاتورة.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { savePurchase, markVatRefunded, TS_DEDUCTIBLE, type PurchaseInput } from '@/domain/purchases';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { recordManualBankTx } from '@/domain/cashOps';
import { accountBalance, walletCashBalance, bankBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { pair, sync, ownerPulls, srcAsMember, MEMBER, has, reasonOf } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

const red = (db: DB) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')');
const pur = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد استرداد مصطنع', date: '2026-10-05', due: '2026-10-05', category: 'صيانة', incorpItem: '', amortize: false,
  amortizeMonths: null, exempt: false, excludeFromVat: false, taxStatus: TS_DEDUCTIBLE,
  subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000, ...over,
} as PurchaseInput);
const setupCompany = (db: DB) => {
  db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`); // المنشأة مسجّلة: «قابلة للخصم» لها وحدها
  db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S-A29', 'مورد استرداد مصطنع', '300000000000003', '2026-01-01')`);
};

test('A2.9 الاسترداد إلى البنك بتاريخه: البنك يزيد بالضريبة والمحفظة كما هي، وحركته مربوطة برقم القيد', () => {
  const db = memDb();
  setupCompany(db);
  const bank = addBank(db, 'بنك استرداد مصطنع');
  const id = savePurchase(db, pur());
  markVatRefunded(db, id, '2026-11-20', bank);
  const e = db.get<{ id: string; no: string; date: string }>(`SELECT id, no, date FROM journal_entries WHERE src_type = 'vat_refund' AND src_id = ?`, [id])!;
  expect(e.date).toBe('2026-11-20');
  // الأرقام الذهبية: الضريبة ١٥٠٫٠٠ = ١٥٬٠٠٠ هللة
  expect([bankBalance(db, bank), walletCashBalance(db), accountBalance(db, '1270'), accountBalance(db, '1100')]).toEqual([15000, 0, 0, 15000]);
  expect(db.all(`SELECT bank_id AS b, date AS d, amount_halalas AS a FROM bank_tx WHERE journal_no = ? AND deleted_at IS NULL`, [e.no]))
    .toEqual([{ b: bank, d: '2026-11-20', a: 15000 }]);
  expect(db.get<{ s: string; d: string }>(`SELECT refund_status AS s, refund_date AS d FROM purchases WHERE id = ?`, [id]))
    .toEqual({ s: 'مسترَد بتاريخ 2026-11-20', d: '2026-11-20' });
  expect(red(db)).toEqual([]);
  db.close();
});

test('A2.9 الاسترداد نقداً بتاريخه يدخل المحفظة · وبنكٌ غير موجود يُرفض قبل أي كتابة', () => {
  const db = memDb();
  setupCompany(db);
  const id = savePurchase(db, pur());
  expect(() => markVatRefunded(db, id, '2026-11-20', 'no-such-bank')).toThrow();
  expect(db.get(`SELECT 1 FROM journal_entries WHERE src_type = 'vat_refund'`)).toBeUndefined();
  markVatRefunded(db, id, '2026-11-18', null);
  expect([walletCashBalance(db), accountBalance(db, '1270')]).toEqual([15000, 0]);
  expect(db.get<{ d: string }>(`SELECT date AS d FROM journal_entries WHERE src_type = 'vat_refund'`)!.d).toBe('2026-11-18');
  db.close();
});

test('A2.9 إلغاء الاسترداد البنكي يعكس حركة البنك · ولا يُلغى إن لم يبقَ في البنك ما يكفي', () => {
  const db = memDb();
  setupCompany(db);
  const bank = addBank(db, 'بنك إلغاء مصطنع');
  const id = savePurchase(db, pur());
  markVatRefunded(db, id, '2026-11-20', bank);
  const e = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'vat_refund' AND src_id = ?`, [id])!.id;
  // رسومٌ تسحب ١٠٠٫٠٠ من البنك: الباقي ٥٠٫٠٠ لا يكفي عكس ١٥٠٫٠٠
  recordManualBankTx(db, { kind: 'fee', bankId: bank, amountHalalas: 10000, date: '2026-11-21', descr: 'رسوم مصطنعة' });
  const blocked = entrySourceAction(db, e);
  if (blocked?.kind !== 'op') throw new Error('op');
  expect(blocked.blockers.length).toBe(1);
  expect(() => blocked.run('2026-11-22', 'إلغاء مصطنع')).toThrow();
  recordManualBankTx(db, { kind: 'income', bankId: bank, amountHalalas: 10000, date: '2026-11-21', descr: 'عائد مصطنع' });
  const a = entrySourceAction(db, e);
  if (a?.kind !== 'op') throw new Error('op');
  expect(a.blockers).toEqual([]);
  a.run('2026-11-22', 'إلغاء مصطنع');
  expect([bankBalance(db, bank), walletCashBalance(db), accountBalance(db, '1270')]).toEqual([0, 0, 15000]);
  expect(red(db)).toEqual([]);
  db.close();
});

describe('A2.9 جهاز المالك على استرداد العضو إلى البنك', () => {
  async function setup() {
    const p = await pair();
    for (const db of [p.owner, p.dev]) db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
    const bank = addBank(p.owner, 'بنك عضو مصطنع');
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    p.dev.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S-A29', 'مورد استرداد مصطنع', '300000000000003', '2026-01-01')`);
    const id = savePurchase(p.dev, pur());
    await sync(p.dev, p.r);
    srcAsMember(p.r, /^purchase$/);
    await ownerPulls(p.owner, p.r);
    return { ...p, bank, id };
  }
  const memberDocs = (r: Awaited<ReturnType<typeof pair>>['r']) => {
    srcAsMember(r, /^vat_refund$/);
    const tx = [...r.docs.values()].filter((d) => d.t === 'bank_tx');
    for (const d of tx) r.inject({ ...d, by: MEMBER, op: 'purchases' } as RemoteDoc);
    return tx;
  };

  test('إيجابي · ما يكتبه التطبيق يُقبل: القيد وحركة بنكه، والبنك يزيد بالضريبة على جهاز المالك', async () => {
    const s = await setup();
    markVatRefunded(s.dev, s.id, '2026-11-20', s.bank);
    await sync(s.dev, s.r);
    const [tx] = memberDocs(s.r);
    await ownerPulls(s.owner, s.r);
    const k = s.owner.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'vat_refund'`)?.id ?? '';
    expect(has(s.owner, k)).toBe(true);
    expect(s.owner.get(`SELECT 1 FROM bank_tx WHERE id = ?`, [tx.k])).toBeTruthy();
    expect([bankBalance(s.owner, s.bank), walletCashBalance(s.owner)]).toEqual([15000, 0]);
    s.close();
  });

  test('سلبي · حركة بنكٍ مزوّرة بضعف الضريبة على قيد الاسترداد: تُرفض ولا تدخل البنك', async () => {
    const s = await setup();
    markVatRefunded(s.dev, s.id, '2026-11-20', s.bank);
    await sync(s.dev, s.r);
    const [tx] = memberDocs(s.r);
    s.r.inject({ ...tx, by: MEMBER, op: 'purchases', d: { ...tx.d, amount_halalas: 30000 } } as RemoteDoc);
    await ownerPulls(s.owner, s.r);
    expect(s.owner.get(`SELECT 1 FROM bank_tx WHERE id = ?`, [tx.k])).toBeUndefined();
    expect(reasonOf(s.owner, tx.k)).not.toBe('');
    expect(bankBalance(s.owner, s.bank)).toBe(0);
    s.close();
  });
});
