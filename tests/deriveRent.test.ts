/**
 * إعادة اشتقاق قيد العضو من مصدره · المرحلة الأولى: الدفعات والتحصيل (المراجعة الخارجية ٧ · النتيجة ١ · قرار المالك 2026-10-15
 * «١»): قيد تحصيلٍ كتبه عضو بسطورٍ تخالف دفعته يُرفض على جهاز المالك ولا يدخل الدفتر · والمطابق يُقبل · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import { confirmContract, recordRentPayment, recordBulkRentPayment } from '@/domain/contracts/service';
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
