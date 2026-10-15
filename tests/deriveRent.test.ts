/**
 * إعادة اشتقاق قيد العضو من مصدره · المرحلة الأولى: الدفعات والتحصيل (المراجعة الخارجية ٧ · النتيجة ١ · قرار المالك 2026-10-15
 * «١»): قيد تحصيلٍ كتبه عضو بسطورٍ تخالف دفعته يُرفض على جهاز المالك ولا يدخل الدفتر · والمطابق يُقبل · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce, docId } from '@/sync/engine';
import { fileVatReturn } from '@/domain/vatFilings';
import { getMeta } from '@/repos/settings';
import { confirmContract, recordRentPayment, recordBulkRentPayment, applyTenantCredit } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { createReservation } from '@/domain/reservations';
import { getMeta as metaOf } from '@/repos/settings';
import { DISCOUNT_AFTER_DUE } from '@/domain/contracts/installments';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { postEntry } from '@/domain/accounting/post';
import { rentSplit } from '@/domain/accounting/rentSplit';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

const UID = 'owner-p1';
const MEMBER = 'member-p1';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const reasonOf = (db: DB, pk: string) => db.get<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE pk = ? ORDER BY id DESC`, [pk])?.reason ?? '';
const has = (db: DB, id: string) => !!db.get(`SELECT 1 FROM journal_entries WHERE id = ? AND status = 'مرحّل'`, [id]);

/** جهاز المالك وجهازٌ ثانٍ عليه العقد · الثاني يحصّل ثم يرفع · وقيده يُعلَّم بكاتبه العضو، ويُعدَّل إن طُلب */
async function setup() {
  const r = new MemoryRemote();
  const owner = memDb();
  const dev = memDb();
  enableSync(owner, UID);
  enableSync(dev, UID);
  const cid = confirmContract(owner, contractInput(addUnit(owner, addProperty(owner, { name: 'عقار اشتقاق مصطنع' })),
    { tenant: 'مستأجر اشتقاق مصطنع', idNumber: '1000000881', phone: '0500000881', start: '2026-01-01', depositHalalas: 0 }));
  await sync(owner, r);
  await sync(dev, r);
  const insts = dev.all<{ id: string; amount_halalas: number }>(
    `SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  return { r, owner, dev, cid, insts };
}
function rentDoc(r: MemoryRemote): RemoteDoc {
  const docs = [...r.docs.values()].filter((d) => d.t === 'journal_entries' && d.d?.src_type === 'rent');
  return docs[docs.length - 1];
}
/** قيد التحصيل في الحساب بكاتبه العضو · وسطوره بعد التعديل */
function asMember(r: MemoryRemote, edit?: (lines: NonNullable<RemoteDoc['lines']>) => NonNullable<RemoteDoc['lines']>): string {
  const o = rentDoc(r);
  r.inject({ ...o, by: MEMBER, lines: edit ? edit(o.lines!) : o.lines });
  return o.k;
}
const amount = (l: NonNullable<RemoteDoc['lines']>[number], k: number) =>
  ({ ...l, debit_halalas: Number(l.debit_halalas) * k, credit_halalas: Number(l.credit_halalas) * k });

test('قيد تحصيلٍ من عضو بضعف دفعته (متوازن) يُرفض على جهاز المالك ولا يدخل الدفتر', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  recordRentPayment(dev, cid, { installmentId: insts[0].id, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  await sync(dev, r);
  const k = asMember(r, (ls) => ls.map((l) => amount(l, 2)));
  await sync(owner, r);
  await sync(owner, r);
  expect(has(owner, k)).toBe(false);
  expect(reasonOf(owner, k)).toMatch(/قيد التحصيل مرفوض/);
  owner.close(); dev.close();
});

test('وقيدٌ نقل الإيراد إلى حسابٍ آخر بالمبلغ نفسه يُرفض', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  recordRentPayment(dev, cid, { installmentId: insts[0].id, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  await sync(dev, r);
  const k = asMember(r, (ls) => ls.map((l) => (l.account_code === '4200' ? { ...l, account_code: '2410' } : l)));
  await sync(owner, r);
  await sync(owner, r);
  expect(has(owner, k)).toBe(false);
  expect(reasonOf(owner, k)).toMatch(/2410|4200/);
  owner.close(); dev.close();
});

test('وقيد التحصيل الجماعي الذي جعل فائضه إيراداً يُرفض', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  const first = Number(insts[0].amount_halalas);
  recordBulkRentPayment(dev, cid, { installmentIds: [insts[0].id], date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: first + 7000 }], notes: '' });
  await sync(dev, r);
  const k = asMember(r, (ls) => ls.filter((l) => l.account_code !== '2410').map((l) =>
    (l.account_code === '4200' ? { ...l, credit_halalas: Number(l.credit_halalas) + 7000 } : l)));
  await sync(owner, r);
  await sync(owner, r);
  expect(has(owner, k)).toBe(false);
  owner.close(); dev.close();
});

test('والمطابق لدفعته يُقبل: تحصيل قسط · وخصمٌ بعد الاستحقاق · وتحصيل جماعي بفائض', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  recordRentPayment(dev, cid, { installmentId: insts[0].id, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  await sync(dev, r);
  const k1 = asMember(r);
  await sync(owner, r);
  recordRentPayment(dev, cid, { installmentId: insts[1].id, period: 'الثاني', date: '2026-02-02',
    lines: [{ method: 'cash', amountHalalas: Number(insts[1].amount_halalas) - 3000 }], discountHalalas: 3000, discountKind: DISCOUNT_AFTER_DUE, notes: '' });
  await sync(dev, r);
  const k2 = asMember(r);
  await sync(owner, r);
  recordBulkRentPayment(dev, cid, { installmentIds: [insts[2].id], date: '2026-02-03',
    lines: [{ method: 'cash', amountHalalas: Number(insts[2].amount_halalas) + 7000 }], notes: '' });
  await sync(dev, r);
  const k3 = asMember(r);
  await sync(owner, r);
  for (const k of [k1, k2, k3]) {
    expect(reasonOf(owner, k)).toBe('');
    expect(has(owner, k)).toBe(true);
  }
  expect(owner.get(`SELECT COUNT(*) AS n FROM contract_payments WHERE contract_id = ?`, [cid])).toEqual({ n: 3 });
  owner.close(); dev.close();
});

/** عقدٌ بإيجارٍ وخدماتٍ ومواقف · على جهاز المالك وجهازٍ ثانٍ */
async function splitSetup() {
  const r = new MemoryRemote();
  const owner = memDb();
  const dev = memDb();
  enableSync(owner, UID);
  enableSync(dev, UID);
  const u = addUnit(owner, addProperty(owner, { name: 'عقار توزيع مصطنع' }), { unit_no: 'D-1' });
  const cid = confirmContract(owner, { ...contractInput(u, { tenant: 'مستأجر توزيع مصطنع', idNumber: '1000000882', phone: '0500000882',
    depositHalalas: 0, start: '2026-01-01', end: '2026-12-31', valueHalalas: 480000, cycle: 'شهرية' } as never), servicesHalalas: 90000, parkingHalalas: 30000 });
  await sync(owner, r);
  await sync(dev, r);
  const insts = dev.all<{ id: string; amount_halalas: number }>(
    `SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  return { r, owner, dev, cid, insts };
}

test('القاعدة ٩٩: قيدٌ نقل ١٠٠ ريال من الإيجار إلى الخدمات ومجموعه صحيح يُرفض', async () => {
  const { r, owner, dev, cid, insts } = await splitSetup();
  recordRentPayment(dev, cid, { installmentId: insts[0].id, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: Number(insts[0].amount_halalas) }], discountHalalas: 0, notes: '' });
  await sync(dev, r);
  const k = asMember(r, (ls) => ls.map((l) => (l.account_code === '4200' ? { ...l, credit_halalas: Number(l.credit_halalas) - 10000 }
    : l.account_code === '4210' ? { ...l, credit_halalas: Number(l.credit_halalas) + 10000 } : l)));
  await sync(owner, r);
  await sync(owner, r);
  expect(has(owner, k)).toBe(false);
  expect(reasonOf(owner, k)).toMatch(/4200|4210/);
  owner.close(); dev.close();
});

test('القاعدة ٩٩: وفرق ثلاث هللات بين الحسابين يُرفض · والمطابق بتوزيعه يُقبل', async () => {
  const { r, owner, dev, cid, insts } = await splitSetup();
  recordRentPayment(dev, cid, { installmentId: insts[0].id, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: Number(insts[0].amount_halalas) }], discountHalalas: 0, notes: '' });
  await sync(dev, r);
  const k1 = asMember(r, (ls) => ls.map((l) => (l.account_code === '4200' ? { ...l, credit_halalas: Number(l.credit_halalas) - 3 }
    : l.account_code === '4220' ? { ...l, credit_halalas: Number(l.credit_halalas) + 3 } : l)));
  await sync(owner, r);
  await sync(owner, r);
  expect(has(owner, k1)).toBe(false);
  recordRentPayment(dev, cid, { installmentId: insts[1].id, period: 'الثاني', date: '2026-02-02',
    lines: [{ method: 'cash', amountHalalas: Number(insts[1].amount_halalas) }], discountHalalas: 0, notes: '' });
  await sync(dev, r);
  const k2 = asMember(r);
  await sync(owner, r);
  expect(reasonOf(owner, k2)).toBe('');
  expect(has(owner, k2)).toBe(true);
  owner.close(); dev.close();
});

test('القاعدة ٩٩: التوزيع من العقد ودفعاته · قيدٌ في الدفتر بعُد العقد لا يراه العضو لا يغيّره', async () => {
  const { owner, dev, cid } = await splitSetup();
  const before = rentSplit(owner, cid, 33333);
  // قيدٌ يدوي على إيراد الخدمات ببُعد العقد · في الدفتر لا في الدفعات
  postEntry(owner, { date: '2026-02-01', memo: 'قيد يدوي مصطنع على الخدمات', lines: [
    { account: '1100', debit: 7777, credit: 0 }, { account: '4210', debit: 0, credit: 7777 }], dims: { contractId: cid } });
  expect(rentSplit(owner, cid, 33333)).toEqual(before);
  expect(rentSplit(dev, cid, 33333)).toEqual(before);
  owner.close(); dev.close();
});

/** المتحقق المستقل، الجولة ٣٥: صفوف التحصيل نفسها (الدفعة وسطورها وتخصيصها) لا القيد وحده */
const docsOf = (r: MemoryRemote, t: string) => [...r.docs.values()].filter((d) => d.t === t);
const later = () => new Date(Date.now() + 60_000).toISOString();
const statusOf = (db: DB, id: string) => db.get<{ s: string }>(`SELECT status AS s FROM contract_installments WHERE id = ?`, [id])!.s;
const paidOf = (db: DB, id: string) => Number(db.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = ?`, [id])!.p);

test('الجولة ٣٥ (أ٢): دفعةٌ ثانية مزوّرة تشير إلى قيدٍ مقبول تُرفض · ولا يُسدَّد بها قسطٌ آخر', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  recordRentPayment(dev, cid, { installmentId: insts[0].id, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  await sync(dev, r);
  const k = asMember(r);
  const pay = docsOf(r, 'contract_payments').pop()!;
  r.inject({ ...pay, by: MEMBER });
  await sync(owner, r);
  expect(has(owner, k)).toBe(true);
  const full = Number(insts[1].amount_halalas);
  r.inject({ ...pay, id: docId('contract_payments', 'FORGED2'), k: 'FORGED2', by: MEMBER, u: later(),
    d: { ...pay.d!, id: 'FORGED2', installment_id: insts[1].id, net_halalas: full, gross_halalas: full } });
  await sync(owner, r);
  await sync(owner, r);
  expect(owner.get(`SELECT 1 FROM contract_payments WHERE id = 'FORGED2'`)).toBeFalsy();
  expect(paidOf(owner, insts[1].id)).toBe(0);
  expect(reasonOf(owner, 'FORGED2')).toMatch(/أكثر من دفعة/);
  owner.close(); dev.close();
});

test('الجولة ٣٥ (أ٣): رفع مبلغ الدفعة بعد قبول قيدها يُرفض أياً كان كاتبه · ويبقى المسدَّد بمبلغها', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  recordRentPayment(dev, cid, { installmentId: insts[0].id, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  await sync(dev, r);
  asMember(r);
  await sync(owner, r);
  const pay = docsOf(r, 'contract_payments').pop()!;
  const full = Number(insts[0].amount_halalas);
  r.inject({ ...pay, u: later(), d: { ...pay.d!, net_halalas: full, gross_halalas: full } });
  await sync(owner, r);
  expect(Number(owner.get<{ n: number }>(`SELECT net_halalas AS n FROM contract_payments WHERE id = ?`, [pay.k])!.n)).toBe(50000);
  expect(paidOf(owner, insts[0].id)).toBe(50000);
  expect(reasonOf(owner, pay.k)).toMatch(/لا تتغير/);
  owner.close(); dev.close();
});

test('الجولة ٣٥ (أ١): دفعةٌ نقدية قُيّدت بشكل السداد من الرصيد الدائن تُرفض', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  recordRentPayment(dev, cid, { installmentId: insts[0].id, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  await sync(dev, r);
  const pay = docsOf(r, 'contract_payments').pop()!;
  const o = rentDoc(r);
  r.inject({ ...o, by: MEMBER, d: { ...o.d!, src_id: pay.k },
    lines: o.lines!.map((l) => (l.account_code === '1100' ? { ...l, account_code: '2410' } : l)) });
  await sync(owner, r);
  await sync(owner, r);
  expect(has(owner, o.k)).toBe(false);
  expect(reasonOf(owner, o.k)).toMatch(/قيد التحصيل مرفوض/);
  owner.close(); dev.close();
});

test('الجولة ٣٥ (أ٥): تحصيلٌ جماعي ضُخّم تخصيصه إلى كامل المقبوض وأُسقط رصيده الدائن يُرفض', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  const first = Number(insts[0].amount_halalas);
  recordBulkRentPayment(dev, cid, { installmentIds: [insts[0].id], date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: first + 7000 }], notes: '' });
  await sync(dev, r);
  const k = asMember(r, (ls) => ls.filter((l) => l.account_code !== '2410').map((l) =>
    (l.account_code === '4200' ? { ...l, credit_halalas: Number(l.credit_halalas) + 7000 } : l)));
  const a = docsOf(r, 'payment_allocations').pop()!;
  r.inject({ ...a, by: MEMBER, d: { ...a.d!, amount_halalas: first + 7000 } });
  await sync(owner, r);
  await sync(owner, r);
  expect(has(owner, k)).toBe(false);
  expect(reasonOf(owner, k)).toMatch(/التخصيص/);
  owner.close(); dev.close();
});

test('الجولة ٣٥ (أ٤): قيد عضوٍ بتاريخٍ في ربعٍ قُدِّم إقراره ووصل بعد تسجيل التقديم يُرفض (القرار ٦)', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  recordRentPayment(dev, cid, { installmentId: insts[0].id, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  fileVatReturn(owner, 2026, 1, '2026-04-15');
  await sync(owner, r);
  await sync(dev, r);
  const k = asMember(r);
  await sync(owner, r);
  await sync(owner, r);
  expect(has(owner, k)).toBe(false);
  expect(reasonOf(owner, k)).toMatch(/قُدِّم إقرارها/);
  expect(statusOf(owner, insts[0].id)).not.toBe('مدفوعة');
  owner.close(); dev.close();
});

/** دفعةٌ مزوّرة من العضو على قسطٍ بكامله · بقيدٍ يختاره المهاجم */
function forgedPayment(r: MemoryRemote, k: string, installmentId: string, amount: number, entryId: string) {
  const pay = docsOf(r, 'contract_payments').pop()!;
  r.inject({ ...pay, id: docId('contract_payments', k), k, by: MEMBER, u: later(),
    d: { ...pay.d!, id: k, installment_id: installmentId, net_halalas: amount, gross_halalas: amount, journal_entry_id: entryId,
      cancelled_at: null, cancel_reason: '', cancel_entry_id: null, method_label: 'نقداً' } });
}

test('الجولة ٣٦ (ع١): دفعة عضوٍ بقيدٍ مرحّل ليس قيد تحصيل (يدوي للمالك) تُرفض · ولا يُسدَّد القسط', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  const manual = postEntry(owner, { date: '2026-02-01', memo: 'قيد يدوي مصطنع', lines: [
    { account: '1100', debit: 300, credit: 0 }, { account: '3100', debit: 0, credit: 300 }] })!;
  recordRentPayment(dev, cid, { installmentId: insts[0].id, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  await sync(owner, r);
  await sync(dev, r);
  forgedPayment(r, 'FORGED-MAN', insts[1].id, Number(insts[1].amount_halalas), manual.id);
  await sync(owner, r);
  await sync(owner, r);
  expect(owner.get(`SELECT 1 FROM contract_payments WHERE id = 'FORGED-MAN'`)).toBeFalsy();
  expect(paidOf(owner, insts[1].id)).toBe(0);
  expect(reasonOf(owner, 'FORGED-MAN')).toMatch(/ليس قيد تحصيلها/);
  owner.close(); dev.close();
});

test('الجولة ٣٦ (ع٢): دفعة عضوٍ بقيد عكس دفعةٍ ملغاة تُرفض · ولا يُسدَّد القسط', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  const pid = recordRentPayment(dev, cid, { installmentId: insts[0].id, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  cancelPayment(dev, pid, { date: '2026-02-02', reason: 'إلغاء مصطنع' });
  const rev = dev.get<{ c: string }>(`SELECT cancel_entry_id AS c FROM contract_payments WHERE id = ?`, [pid])!.c;
  await sync(dev, r);
  await sync(owner, r);
  forgedPayment(r, 'FORGED-REV', insts[1].id, Number(insts[1].amount_halalas), rev);
  await sync(owner, r);
  await sync(owner, r);
  expect(owner.get(`SELECT 1 FROM contract_payments WHERE id = 'FORGED-REV'`)).toBeFalsy();
  expect(paidOf(owner, insts[1].id)).toBe(0);
  owner.close(); dev.close();
});

test('الجولة ٣٦ (ع٣): الرصيد الدائن لا يُصرف مرتين · والصرف الأول المشروع يُقبل وسطر 2410 فيه بُعد العقد', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  const first = Number(insts[0].amount_halalas);
  recordBulkRentPayment(dev, cid, { installmentIds: [insts[0].id], date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: first + 7000 }], notes: '' });
  await sync(dev, r);
  asMember(r);
  await sync(owner, r);
  applyTenantCredit(dev, cid, { installmentId: insts[1].id, amountHalalas: 5000, date: '2026-02-02' });
  await sync(dev, r);
  const k1 = asMember(r);
  const p1 = docsOf(r, 'contract_payments').pop()!;
  r.inject({ ...p1, by: MEMBER });
  await sync(owner, r);
  expect(has(owner, k1)).toBe(true);
  expect(owner.get<{ c: string | null }>(`SELECT contract_id AS c FROM journal_lines WHERE entry_id = ? AND account_code = '2410'`, [k1])!.c).toBe(cid);
  // صرفٌ ثانٍ بخمسة آلاف من عميلٍ معدَّل: قيدٌ ودفعة مستنسخان على قسطٍ آخر
  const e1 = r.docs.get(docId('journal_entries', k1))!;
  r.inject({ ...e1, id: docId('journal_entries', 'JE-DBL'), k: 'JE-DBL', u: later(), by: MEMBER,
    d: { ...e1.d!, id: 'JE-DBL', no: 'JE-DBL', src_id: 'PAY-DBL' },
    lines: e1.lines!.map((l, i) => ({ ...l, id: 'JL-DBL-' + i, entry_id: 'JE-DBL' })) });
  r.inject({ ...p1, id: docId('contract_payments', 'PAY-DBL'), k: 'PAY-DBL', by: MEMBER, u: later(),
    d: { ...p1.d!, id: 'PAY-DBL', installment_id: insts[2].id, journal_entry_id: 'JE-DBL' } });
  await sync(owner, r);
  await sync(owner, r);
  expect(has(owner, 'JE-DBL')).toBe(false);
  expect(reasonOf(owner, 'JE-DBL')).toMatch(/الدائن لا يكفي/);
  expect(paidOf(owner, insts[2].id)).toBe(0);
  owner.close(); dev.close();
});

test('القرار ٨ (الجولة ٣٦): شاهد حذف العضو لقسط عقدٍ مؤكَّد يُرفض على جهاز المالك ويُعاد رفع القسط', async () => {
  const { r, owner, dev, insts } = await setup();
  const id = docId('contract_installments', insts[0].id);
  const live = r.docs.get(id)!;
  r.inject({ ...live, dev: 'dev-member', u: later(), del: true, d: null, dby: MEMBER });
  await sync(owner, r);
  expect(owner.get(`SELECT 1 FROM contract_installments WHERE id = ?`, [insts[0].id])).toBeTruthy();
  expect(reasonOf(owner, insts[0].id)).toMatch(/مؤكَّد/);
  await sync(owner, r);
  expect(r.docs.get(id)!.del).toBe(false);
  owner.close(); dev.close();
});

test('الجولة ٣٦ (ع٣) إيجابي: سدادٌ من الرصيد أُلغي يعيد الرصيد كاملاً · فيُقبل سدادٌ بكامله بعده ولا يُعدّ الملغى مرتين', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  const first = Number(insts[0].amount_halalas);
  recordBulkRentPayment(dev, cid, { installmentIds: [insts[0].id], date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: first + 7000 }], notes: '' });
  await sync(dev, r);
  asMember(r);
  await sync(owner, r);
  const p1 = applyTenantCredit(dev, cid, { installmentId: insts[1].id, amountHalalas: 5000, date: '2026-02-02' });
  cancelPayment(dev, p1, { date: '2026-02-03', reason: 'إلغاء مصطنع' });
  const p2 = applyTenantCredit(dev, cid, { installmentId: insts[1].id, amountHalalas: 7000, date: '2026-02-04' });
  await sync(dev, r);
  for (const d of [...r.docs.values()]) if (d.t === 'journal_entries' || d.t === 'contract_payments') r.inject({ ...d, by: MEMBER });
  await sync(owner, r);
  await sync(owner, r);
  expect(owner.get(`SELECT 1 FROM contract_payments WHERE id = ?`, [p2])).toBeTruthy();
  const je = owner.get<{ j: string }>(`SELECT journal_entry_id AS j FROM contract_payments WHERE id = ?`, [p2])!.j;
  expect(has(owner, je)).toBe(true);
  owner.close(); dev.close();
});

test('الجولة ٣٧ (ر١): عربونٌ مزوّر بلا حجزٍ وراءه لا يسدّد قسطاً · وتحويل عربون حجزٍ حقيقي من العضو يُقبل', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  const dev = memDb();
  enableSync(owner, UID);
  enableSync(dev, UID);
  const u = addUnit(owner, addProperty(owner, { name: 'عقار عربون مصطنع' }));
  await sync(owner, r);
  await sync(dev, r);
  const rid = createReservation(dev, { unitId: u, name: 'حاجز مصطنع', phone: '', depositHalalas: 30000, expiryDate: '2099-01-01' });
  const cid = confirmContract(dev, { ...contractInput(u, { tenant: 'مستأجر عربون مصطنع', idNumber: '1000000883', phone: '0500000883',
    start: '2026-01-01', depositHalalas: 0 }), reservationId: rid } as never);
  await sync(dev, r);
  for (const d of [...r.docs.values()]) if (d.t === 'journal_entries' || d.t === 'contract_payments') r.inject({ ...d, by: MEMBER });
  await sync(owner, r);
  await sync(owner, r);
  const legit = owner.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ? AND method_label = 'من العربون'`, [cid]);
  expect(legit).toBeTruthy();
  // المزوّر: قيد تحويلٍ بلا حجز ودفعةٌ «من العربون» على قسطٍ آخر بكامله
  const insts = owner.all<{ id: string; amount_halalas: number }>(`SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  const conv = [...r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'reservation_convert')!;
  const full = Number(insts[3].amount_halalas);
  r.inject({ ...conv, id: docId('journal_entries', 'JE-RSV'), k: 'JE-RSV', u: later(), by: MEMBER,
    d: { ...conv.d!, id: 'JE-RSV', no: 'JE-RSV', src_id: 'RSV-NONE' },
    lines: conv.lines!.map((l, i) => ({ ...l, id: 'JL-RSV-' + i, entry_id: 'JE-RSV',
      debit_halalas: Number(l.debit_halalas) ? full : 0, credit_halalas: Number(l.credit_halalas) ? full : 0 })) });
  const pay = r.docs.get(docId('contract_payments', legit!.id))!;
  r.inject({ ...pay, id: docId('contract_payments', 'PAY-RSV'), k: 'PAY-RSV', by: MEMBER, u: later(),
    d: { ...pay.d!, id: 'PAY-RSV', installment_id: insts[3].id, net_halalas: full, gross_halalas: full, journal_entry_id: 'JE-RSV' } });
  await sync(owner, r);
  await sync(owner, r);
  expect(owner.get(`SELECT 1 FROM contract_payments WHERE id = 'PAY-RSV'`)).toBeFalsy();
  expect(paidOf(owner, insts[3].id)).toBe(0);
  expect(reasonOf(owner, 'PAY-RSV')).toMatch(/حجز/);
  owner.close(); dev.close();
});

test('الجولة ٣٧ (ر٥): إلغاء دفعةٍ لها قيد بتعديلٍ وحده بلا قيد عكسٍ يُرفض · ويبقى المسدَّد', async () => {
  const { r, owner, dev, cid, insts } = await setup();
  recordRentPayment(dev, cid, { installmentId: insts[0].id, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  await sync(dev, r);
  asMember(r);
  await sync(owner, r);
  const pay = docsOf(r, 'contract_payments').pop()!;
  r.inject({ ...pay, u: later(), d: { ...pay.d!, cancelled_at: '2026-02-05', cancel_reason: 'إلغاء مصطنع', cancel_entry_id: null } });
  await sync(owner, r);
  expect(owner.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [pay.k])!.c).toBeNull();
  expect(paidOf(owner, insts[0].id)).toBe(50000);
  expect(reasonOf(owner, pay.k)).toMatch(/بلا قيدٍ يعكس/);
  owner.close(); dev.close();
});

test('الجولة ٣٧: شاهد حذفٍ ينتحل معرّف جهاز المالك ليس صدى · فقسط العقد المؤكَّد يُعاد رفعه', async () => {
  const { r, owner, dev, insts } = await setup();
  const id = docId('contract_installments', insts[0].id);
  const live = r.docs.get(id)!;
  r.inject({ ...live, dev: metaOf(owner, 'device_id')!, u: later(), del: true, d: null, dby: MEMBER });
  await sync(owner, r);
  expect(reasonOf(owner, insts[0].id)).toMatch(/مؤكَّد/);
  await sync(owner, r);
  expect(r.docs.get(id)!.del).toBe(false);
  owner.close(); dev.close();
});
