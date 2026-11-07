/**
 * المدقق الخارجي Q · الجولة التاسعة · على e7c151c · بيانات مصطنعة كلها.
 * Q٣: فحص O٢ الجديد في memberBankTxCheck (engine.ts: «حركة القيد السالبة الجديدة لا تُنزل بنكها تحت الصفر» → AwaitOriginal) أشدّ من
 * التطبيق: إلغاء دفعة إيجارٍ حُصّلت في بنك (cancelPayment في contracts/cancelPayment.ts) يكتب حركةً سالبة مربوطة بالقيد العكسي ولا
 * يفحص رصيد البنك (شيكٌ مرتجع بعد أن سُحب من البنك) · فعلى جهاز المالك يُطبَّق القيد العكسي (دائن 1100) وتنتظر حركته ثلاثين يوماً ثم
 * تُرفض: المحفظة تنقص بمبلغ الدفعة كله والبنك يبقى بمالٍ خرج، ويختلف الجهازان إلى الأبد.
 * السلوك الصحيح: إلغاءٌ يجيزه التطبيق يُطبَّق كما هو على جهاز المالك (أو يمنعه التطبيق نفسه على جهاز العضو)، فلا يُرفض نصفه.
 */
import { withdrawCashFromBank } from '@/domain/cashOps';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls } from './helpers/rederive';
import { snap, newAsMember, bal, cash1100, rejects, waiting } from './helpers/auditI';

test('Q3: عضو التحصيل يلغي دفعة إيجارٍ حُصّلت في بنكٍ سُحب منه بعدها: يُطبَّق قيد الإلغاء وتُرفض حركة بنكه', async () => {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع Q3', 0);
  const pa = addProperty(s.owner, { name: 'عقار مصطنع Q3' });
  const ua = addUnit(s.owner, pa, { unit_no: 'Q3-A' });
  const cid = confirmContract(s.owner, contractInput(ua, { tenant: 'مستأجر مصطنع Q3', idNumber: '1000000093', phone: '0555550093' }));
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // ١) العضو يحصّل قسطاً بشيكٍ في بنك أ
  let since = snap(s.r);
  const inst = s.dev.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  const pay = recordRentPayment(s.dev, cid, { installmentId: inst, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cheque', bankId: A, amountHalalas: 120000 }], discountHalalas: 0, notes: '' });
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  await ownerPulls(s.owner, s.r);
  // ٢) المالك يسحب من بنك أ نقداً إلى المحفظة (cashOps: في حدّ رصيده)
  withdrawCashFromBank(s.owner, { bankId: A, amountHalalas: 100000, date: '2026-02-05' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // ٣) الشيك يرتجع: العضو يلغي الدفعة كما يجيزه التطبيق (لا فحص لرصيد البنك في planCancelPayment)
  since = snap(s.r);
  cancelPayment(s.dev, pay, { date: '2026-02-10', reason: 'شيك مرتجع مصطنع' });
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  await ownerPulls(s.owner, s.r);
  // ٤) يمضي شهر
  s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await ownerPulls(s.owner, s.r);
  const out = { owner: bal(s.owner, [A]), member: bal(s.dev, [A]), o1100: cash1100(s.owner), m1100: cash1100(s.dev),
    rejects: rejects(s.owner).map((r) => r.tbl + ': ' + r.reason), waiting: waiting(s.owner).map((w) => w.tbl + ': ' + w.last_error) };
  // eslint-disable-next-line no-console
  console.log('Q3', JSON.stringify(out));
  // الجهازان متفقان: [رصيد بنك أ، المحفظة] كما عند العضو، ولا مرفوض
  expect({ owner: out.owner, rejects: out.rejects }).toEqual({ owner: out.member, rejects: [] });
  s.close();
});

/**
 * Q٣ب: والسداد من البنك نفسه بالتزامن (العضو يسدّد فاتورةً من بنكٍ يكفيها عنده، والمالك بلا اتصال يسحب من البنك نفسه): يُطبَّق قيد السداد
 * وتُعلَّم الفاتورة مسدّدة من البنك، وتُرفض حركة البنك بعد شهر · فيُحمَّل السدادُ على المحفظة لا على البنك (L٦ الموثَّق حركةٌ بلا قيد تُرفض
 * كلها، وهنا يُرفض نصف العملية).
 */
import { savePurchase, payPurchase, type PurchaseInput } from '@/domain/purchases';
test('Q3b: سدادٌ من البنك متزامنٌ مع سحب المالك منه: قيد السداد يُطبَّق وحركة بنكه تُرفض فيُحمَّل على المحفظة', async () => {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع Q3b', 120000);
  s.owner.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['SUP-Q3', 'مورد مصطنع Q3', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  const pid = savePurchase(s.owner, {
    supplier: 'مورد مصطنع Q3', date: '2026-10-02', due: '2026-11-02', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: null, propertyId: null, meterId: null, meterReading: null,
    subtotalHalalas: 100000, taxHalalas: 0, totalHalalas: 100000,
  } as PurchaseInput);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // المالك بلا اتصال يسحب من بنك أ · والعضو في الوقت نفسه يسدّد الفاتورة من بنك أ (requireBankCovers يمرّ: 120000 ≥ 100000)
  withdrawCashFromBank(s.owner, { bankId: A, amountHalalas: 100000, date: '2026-10-05' });
  const since = snap(s.r);
  payPurchase(s.dev, pid, 'bank', A, '2026-10-05');
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  await ownerPulls(s.owner, s.r);
  s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await ownerPulls(s.owner, s.r);
  await sync(s.dev, s.r);
  await sync(s.dev, s.r);
  const paidFrom = s.owner.get<{ b: string | null; j: string | null }>(`SELECT payment_bank_id AS b, payment_journal_entry_id AS j FROM purchases WHERE id = ?`, [pid])!;
  const out = { owner: bal(s.owner, [A]), member: bal(s.dev, [A]), paidFromBank: paidFrom.b === A, payEntryApplied: !!paidFrom.j,
    rejects: rejects(s.owner).map((r) => r.tbl + ': ' + r.reason) };
  // eslint-disable-next-line no-console
  console.log('Q3b', JSON.stringify(out));
  // العملية كلها أو لا شيء: الجهازان متفقان على البنك والمحفظة، ولا تُرفض حركة بنكٍ قيدُها مطبَّق
  expect({ owner: out.owner, rejects: out.rejects }).toEqual({ owner: out.member, rejects: [] });
  s.close();
});

/**
 * Q٣ج: واستعادة فاتورة شراءٍ مسدّدة من البنك من السلة (restorePurchase → repostCopy) تعيد حركة البنك السالبة بلا فحص رصيده
 * (repostBlockers يفحص المحفظة وحدها) · والبنك فرغ بعد الحذف: جهاز المالك يطبّق قيد السداد وتنتظر حركته ثم تُرفض.
 */
import { restoreFromTrash } from '@/domain/trash';
import { deletePurchase } from '@/domain/purchases';
test('Q3c: عضو المشتريات يستعيد من السلة فاتورةً سُدّدت من بنكٍ سُحب منه بعد حذفها: قيد السداد يُطبَّق وحركة بنكه تُرفض', async () => {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع Q3c', 100000);
  s.owner.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['SUP-Q3C', 'مورد مصطنع Q3c', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  const pid = savePurchase(s.owner, {
    supplier: 'مورد مصطنع Q3c', date: '2026-10-02', due: '2026-11-02', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: null, propertyId: null, meterId: null, meterReading: null,
    subtotalHalalas: 100000, taxHalalas: 0, totalHalalas: 100000,
  } as PurchaseInput);
  payPurchase(s.owner, pid, 'bank', A, '2026-10-03');
  // المالك يحذف الفاتورة إلى السلة (يعود المبلغ إلى البنك) ثم يسحبه نقداً
  deletePurchase(s.owner, pid);
  withdrawCashFromBank(s.owner, { bankId: A, amountHalalas: 100000, date: '2026-10-04' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const since = snap(s.r);
  restoreFromTrash(s.dev, 'purchases', pid);
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  await ownerPulls(s.owner, s.r);
  s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await ownerPulls(s.owner, s.r);
  const out = { owner: bal(s.owner, [A]), member: bal(s.dev, [A]), rejects: rejects(s.owner).map((r) => r.tbl + ': ' + r.reason) };
  // eslint-disable-next-line no-console
  console.log('Q3c', JSON.stringify(out));
  expect({ owner: out.owner, rejects: out.rejects }).toEqual({ owner: out.member, rejects: [] });
  s.close();
});
