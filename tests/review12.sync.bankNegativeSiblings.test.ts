/**
 * المراجعة الشاملة 2026-11-13 · R12-SYN-3 (المساران الشقيقان وضابطٌ موجب) · بيانات مصطنعة كلها.
 *
 * العيب: حدّ «لا ينزل البنك تحت الصفر» (قرار المالك ٥٥ · A2.2) يُفحص على الجهاز الذي يعكس أو يعيد، وعضو التحصيل أو الفواتير أو
 *   المشتريات لا يقرأ حركات البنك (readSections.ts: bank_tx للبنوك والتقارير والدفتر) فيرى رصيد البنك افتتاحيّه وما كتبه هو · وجهاز
 *   المالك يطبّق ما كتبه العضو مع قيده بلا فحص (Q٣) · فيصير البنك سالباً عند المالك:
 *   - عضو الفواتير والتحصيل يعيد فاتورةً حصّلها في البنك إلى «مستحقة» بعد أن سحب المالك من البنك.
 *   - عضو المشتريات يستعيد من السلة فاتورة شراءٍ سدّدها من البنك بعد أن سحب المالك ما عاد إلى البنك بحذفها.
 * الصحيح: جهاز المالك يرى كل حركة، فيرفض قيد العضو (عكساً أو إعادةً) إن أنزل بنكاً تحت الصفر، مع حركته البنكية، ويبقى ما يتبعه
 *   كما هو عنده (الفاتورة محصَّلة، وفاتورة الشراء في السلة) · وإلغاءٌ يكفيه البنك يُطبَّق كما كان.
 *   TZ=Asia/Riyadh npx jest tests/review12.sync.bankNegativeSiblings.test.ts
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce, setSyncState } from '@/sync/engine';
import { annotate, memberTokens } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { withdrawCashFromBank } from '@/domain/cashOps';
import { saveInvoice, payInvoice, setInvoiceStatus } from '@/domain/invoices';
import { savePurchase, payPurchase, deletePurchase, type PurchaseInput } from '@/domain/purchases';
import { restoreFromTrash } from '@/domain/trash';
import { bankBalance, accountBalance } from '@/domain/accounting/ledger';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteDoc, RemoteStore } from '@/sync/types';

const ORG = 'OWNER-R12-BS';
const OWNER: Access = { owner: true, uid: ORG, perms: {}, allProps: true, props: [] } as Access;
const dev = (db: DB) => getMeta(db, 'device_id')!;

/** جهاز المالك وعضوٌ يسحب ما تجيزه رموز رؤيته كما يكتبها annotate (كـ review12.sync.bankNegativeViaMember) */
async function setup(member: Access, opening: number) {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, ORG);
  owner.run(`UPDATE company SET vat_enabled = 0 WHERE id = 1`);
  const A = addBank(owner, 'بنك أ مصطنع', opening);
  const u = addUnit(owner, addProperty(owner, { name: 'عقار مصطنع' }), { unit_no: 'BS-1' });
  await syncOnce(owner, r, dev(owner));
  const tokens = new Set(memberTokens(member));
  const seen = (x: RemoteDoc | null) => !!x && (x.g ?? []).some((g) => tokens.has(g));
  const m = memDb();
  enableSync(m, member.uid!);
  m.run(`DELETE FROM sync_outbox`);
  m.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'عضو مصطنع' } })]);
  setSyncState(m, 'org', ORG);
  const remote: RemoteStore = {
    pull: async (c, l) => {
      const page = await r.pull(c, l);
      const docs: RemoteDoc[] = [];
      for (const d of page.docs) {
        const a = d.op ? { doc: d, pub: null } : annotate(owner, { ...d } as RemoteDoc, OWNER);
        if (seen(a.doc)) docs.push(a.doc);
        else if (seen(a.pub)) docs.push(a.pub!);
      }
      return { ...page, docs };
    },
    write: (d) => r.write(d), clockSample: () => r.clockSample(),
    reserveBlocks: (q) => r.reserveBlocks(q), takeInvoiceSeq: (f) => r.takeInvoiceSeq(f), memberMode: true,
    annotate: (d, doc) => annotate(d, doc, member).doc,
  };
  const msync = () => syncOnce(m, remote, dev(m));
  await msync();
  const osync = async () => { await syncOnce(owner, r, dev(owner)); await syncOnce(owner, r, dev(owner)); };
  /** يمضي شهر: ما ينتظر يُحسم */
  const monthLater = async () => {
    owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
    await osync();
  };
  return { r, owner, m, A, u, msync, osync, monthLater };
}
const rejectedTables = (db: DB) => db.all<{ t: string }>(`SELECT DISTINCT tbl AS t FROM sync_rejects ORDER BY tbl`).map((x) => x.t);

test('عضو الفواتير والتحصيل يعيد فاتورةً حصّلها في البنك إلى «مستحقة» بعد سحب المالك منه: البنك لا يصير سالباً والفاتورة محصَّلة', async () => {
  const s = await setup({ owner: false, uid: 'M-R12-BS1', perms: { invoices: 3, collect: 1 }, allProps: true, props: [] } as Access, 0);
  // العضو يصدر فاتورة ١٬٠٠٠ ريال (بلا ضريبة) ويحصّلها تحويلاً في بنك أ
  const id = saveInvoice(s.m, {
    customer: 'عميل مصطنع', customerVat: '', issue: '2026-04-10', due: '2026-04-30', notes: '', unitId: s.u, propertyId: null,
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100_000, taxPct: 0, taxCode: 'E' }],
  }, 'مستحقة');
  payInvoice(s.m, id, { method: 'bank', bankId: s.A, date: '2026-04-12' });
  await s.msync();
  await s.osync();
  expect(bankBalance(s.owner, s.A)).toBe(100_000);
  // المالك يسحب ٩٠٠ ريال من بنك أ إلى المحفظة: يبقى ١٠٠ (١٠٬٠٠٠ هللة)
  withdrawCashFromBank(s.owner, { bankId: s.A, amountHalalas: 90_000, date: '2026-04-15' });
  await s.osync();
  await s.msync();
  // العضو يعيدها «مستحقة» (جهازه يرى بنك أ ١٬٠٠٠ فيجيزه)
  try { setInvoiceStatus(s.m, id, 'مستحقة'); } catch { /* المنع على جهاز العضو أحد طرفي الصحيح */ }
  await s.msync();
  await s.osync();
  await s.monthLater();
  const out = {
    bankA: bankBalance(s.owner, s.A),
    // 1100: تحصيل ١٠٠٬٠٠٠ (البنك ١٠٬٠٠٠ والمحفظة ٩٠٬٠٠٠) · ولا عكس
    cash1100: accountBalance(s.owner, '1100'),
    status: s.owner.get<{ s: string }>(`SELECT status AS s FROM invoices WHERE id = ?`, [id])!.s,
    // ونسخة المالك عادت إلى السحابة
    cloudStatus: s.r.docs.get('invoices__' + id)?.d?.status,
    // قيد العكس وحركته البنكية مرفوضان معاً، ولا شيء ينتظر
    rejects: rejectedTables(s.owner),
    waiting: Number(s.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox`)!.n),
  };
  expect(out).toEqual({ bankA: 10_000, cash1100: 100_000, status: 'مدفوعة', cloudStatus: 'مدفوعة', rejects: ['bank_tx', 'journal_entries'], waiting: 0 });
  s.owner.close(); s.m.close();
});

test('عضو المشتريات يستعيد من السلة فاتورةً سدّدها من البنك بعد سحب المالك ما عاد بحذفها: البنك لا يصير سالباً', async () => {
  const s = await setup({ owner: false, uid: 'M-R12-BS2', perms: { purchases: 3 }, allProps: true, props: [] } as Access, 100_000);
  s.owner.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['SUP-R12-BS', 'مورد مصطنع', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  await s.osync();
  await s.msync();
  // العضو يسجّل فاتورة شراء ١٬٠٠٠ ريال ويسدّدها من بنك أ (افتتاحيه ١٬٠٠٠) ثم يحذفها إلى السلة فيعود المبلغ إلى البنك
  const pid = savePurchase(s.m, {
    supplier: 'مورد مصطنع', date: '2026-10-02', due: '2026-11-02', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: null, propertyId: null, meterId: null, meterReading: null,
    subtotalHalalas: 100_000, taxHalalas: 0, totalHalalas: 100_000,
  } as PurchaseInput);
  payPurchase(s.m, pid, 'bank', s.A, '2026-10-03');
  deletePurchase(s.m, pid);
  await s.msync();
  await s.osync();
  expect(bankBalance(s.owner, s.A)).toBe(100_000);
  // المالك يسحب ١٬٠٠٠ من بنك أ إلى المحفظة: يصير صفراً
  withdrawCashFromBank(s.owner, { bankId: s.A, amountHalalas: 100_000, date: '2026-10-04' });
  await s.osync();
  await s.msync();
  // العضو يستعيدها من السلة (جهازه يرى بنك أ ١٬٠٠٠ فيجيزه)
  try { restoreFromTrash(s.m, 'purchases', pid); } catch { /* المنع على جهاز العضو أحد طرفي الصحيح */ }
  await s.msync();
  await s.osync();
  await s.monthLater();
  const out = {
    bankA: bankBalance(s.owner, s.A),
    // 1100: افتتاحي البنك ١٠٠٬٠٠٠ · ولا سداد قائم (عُكس بالحذف)
    cash1100: accountBalance(s.owner, '1100'),
    // الاستعادة كلها مرفوضة: نسختا القيدين وحركة البنك وصفّ الفاتورة، فتبقى في السلة عند المالك وفي السحابة ولا ذمّة مورد بلا سداد
    inTrash: !!s.owner.get<{ d: string | null }>(`SELECT deleted_at AS d FROM purchases WHERE id = ?`, [pid])!.d,
    cloudInTrash: s.r.docs.get('purchases__' + pid)?.d?.deleted_at != null,
    // 2100: قيد الفاتورة −١٠٠٬٠٠٠ وسدادها +١٠٠٬٠٠٠ وعكساهما بالحذف: صفر
    ap2100: accountBalance(s.owner, '2100'),
    liveCopies: Number(s.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE src_id = ? AND src_type IN ('purchase', 'purchase_pay') AND reversed_by IS NULL`, [pid])!.n),
    rejects: rejectedTables(s.owner),
  };
  expect(out).toEqual({ bankA: 0, cash1100: 100_000, inTrash: true, cloudInTrash: true, ap2100: 0, liveCopies: 0,
    rejects: ['bank_tx', 'journal_entries', 'purchases'] });
  s.owner.close(); s.m.close();
});

test('عضو التحصيل يلغي تحصيلاً بشيكٍ بعد سحب المالك من البنك: يُرفض الإلغاء كله معاً (قيده وحركته ووسم الدفعة) وتعود نسخة المالك', async () => {
  const s = await setup({ owner: false, uid: 'M-R12-BS4', perms: { collect: 3 }, allProps: true, props: [] } as Access, 0);
  const cid = confirmContract(s.owner, contractInput(s.u, { tenant: 'مستأجر مصطنع', idNumber: '1000001295', phone: '0555551295' }));
  await s.osync();
  await s.msync();
  const inst = s.m.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  const pay = recordRentPayment(s.m, cid, { installmentId: inst, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cheque', bankId: s.A, amountHalalas: 120_000 }], discountHalalas: 0, notes: '' });
  await s.msync();
  await s.osync();
  const paid0 = Number(s.owner.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = ?`, [inst])!.p);
  // المالك يسحب ١٬٠٠٠ من بنك أ (١٬٢٠٠): يبقى ٢٠٠
  withdrawCashFromBank(s.owner, { bankId: s.A, amountHalalas: 100_000, date: '2026-02-05' });
  await s.osync();
  await s.msync();
  cancelPayment(s.m, pay, { date: '2026-02-10', reason: 'شيك مرتجع مصطنع' });
  await s.msync();
  await s.osync();
  const out = {
    bankA: bankBalance(s.owner, s.A),
    cancelled: s.owner.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [pay])!.c,
    cloudCancelled: s.r.docs.get('contract_payments__' + pay)?.d?.cancelled_at ?? null,
    paidUnchanged: Number(s.owner.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = ?`, [inst])!.p) === paid0,
    rejects: rejectedTables(s.owner),
    // لا شيء ينتظر ثلاثين يوماً: الوسم يُرفض مع عاكسه في الدورة نفسها
    waiting: Number(s.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox`)!.n),
  };
  expect(out).toEqual({ bankA: 20_000, cancelled: null, cloudCancelled: null, paidUnchanged: true,
    rejects: ['bank_tx', 'contract_payments', 'journal_entries'], waiting: 0 });
  s.owner.close(); s.m.close();
});

test('ضابط: عضو التحصيل يلغي تحصيلاً بشيكٍ والبنك يكفيه: يُطبَّق الإلغاء كله على جهاز المالك', async () => {
  const s = await setup({ owner: false, uid: 'M-R12-BS3', perms: { collect: 3 }, allProps: true, props: [] } as Access, 0);
  const cid = confirmContract(s.owner, contractInput(s.u, { tenant: 'مستأجر مصطنع', idNumber: '1000001294', phone: '0555551294' }));
  await s.osync();
  await s.msync();
  const inst = s.m.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  const pay = recordRentPayment(s.m, cid, { installmentId: inst, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cheque', bankId: s.A, amountHalalas: 120_000 }], discountHalalas: 0, notes: '' });
  await s.msync();
  await s.osync();
  const before1100 = accountBalance(s.owner, '1100');
  cancelPayment(s.m, pay, { date: '2026-02-10', reason: 'شيك مرتجع مصطنع' });
  await s.msync();
  await s.osync();
  const out = {
    bankA: bankBalance(s.owner, s.A),
    // 1100 ينقص بالتحصيل الملغى: ١٢٠٬٠٠٠
    drop1100: before1100 - accountBalance(s.owner, '1100'),
    cancelled: !!s.owner.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [pay])!.c,
    rejects: rejectedTables(s.owner),
  };
  expect(out).toEqual({ bankA: 0, drop1100: 120_000, cancelled: true, rejects: [] });
  s.owner.close(); s.m.close();
});

test('ضابط: عضو التحصيل يحصّل بشيكٍ ثم يلغيه قبل أن يزامن فيصلان معاً: يُطبَّقان كلاهما ولا يُعدّ الإلغاء فوق رصيد البنك', async () => {
  const s = await setup({ owner: false, uid: 'M-R12-BS5', perms: { collect: 3 }, allProps: true, props: [] } as Access, 0);
  const cid = confirmContract(s.owner, contractInput(s.u, { tenant: 'مستأجر مصطنع', idNumber: '1000001296', phone: '0555551296' }));
  await s.osync();
  await s.msync();
  const inst = s.m.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  const pay = recordRentPayment(s.m, cid, { installmentId: inst, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cheque', bankId: s.A, amountHalalas: 120_000 }], discountHalalas: 0, notes: '' });
  cancelPayment(s.m, pay, { date: '2026-02-10', reason: 'شيك مرتجع مصطنع' });
  await s.msync();
  await s.osync();
  const out = {
    // بنك أ: ٠ + ١٢٠٬٠٠٠ − ١٢٠٬٠٠٠ = ٠
    bankA: bankBalance(s.owner, s.A),
    cancelled: !!s.owner.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [pay])!.c,
    rejects: rejectedTables(s.owner),
  };
  expect(out).toEqual({ bankA: 0, cancelled: true, rejects: [] });
  s.owner.close(); s.m.close();
});

test('ضابط: جهازٌ جديد للمالك يسحب الحساب كله وفيه سدادٌ من البنك كتبه عضو بعد تحصيله فيه: يُقبل كما قبله الجهاز الأول', async () => {
  const s = await setup({ owner: false, uid: 'M-R12-BS6', perms: { collect: 3, purchases: 3 }, allProps: true, props: [] } as Access, 0);
  s.owner.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['SUP-R12-BS6', 'مورد مصطنع', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  const cid = confirmContract(s.owner, contractInput(s.u, { tenant: 'مستأجر مصطنع', idNumber: '1000001297', phone: '0555551297' }));
  await s.osync();
  await s.msync();
  // العضو يحصّل ١٬٢٠٠ بشيكٍ في بنك أ ثم يسدّد منه فاتورة شراء ١٬٠٠٠
  const inst = s.m.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  recordRentPayment(s.m, cid, { installmentId: inst, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cheque', bankId: s.A, amountHalalas: 120_000 }], discountHalalas: 0, notes: '' });
  const pid = savePurchase(s.m, {
    supplier: 'مورد مصطنع', date: '2026-02-02', due: '2026-03-02', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: null, propertyId: null, meterId: null, meterReading: null,
    subtotalHalalas: 100_000, taxHalalas: 0, totalHalalas: 100_000,
  } as PurchaseInput);
  payPurchase(s.m, pid, 'bank', s.A, '2026-02-03');
  await s.msync();
  await s.osync();
  // جهاز المالك الثاني يسحب الحساب كله: القيود قبل حركات البنك في ترتيب التطبيق
  const owner2 = memDb();
  enableSync(owner2, ORG);
  await syncOnce(owner2, s.r, dev(owner2));
  await syncOnce(owner2, s.r, dev(owner2));
  // بنك أ: ٠ + ١٢٠٬٠٠٠ − ١٠٠٬٠٠٠ = ٢٠٬٠٠٠ على الجهازين، ولا رفض لقيدٍ أو حركة بنكٍ أو فاتورة شراء
  // (والجهاز الجديد يرفض اليوم نسخة العضو لقسطٍ مسّه تحصيله «قسطٌ جديد لعقدٍ لم يكتبه»، وهو كذلك قبل هذا الإصلاح: حارس B-1 للأقساط
  // لا حدّ البنك، فيُستثنى هنا ويُبلَّغ وحده)
  const bankRejects = (db: DB) => rejectedTables(db).filter((t) => t !== 'contract_installments');
  expect({ one: bankBalance(s.owner, s.A), two: bankBalance(owner2, s.A), rejects1: bankRejects(s.owner), rejects2: bankRejects(owner2) })
    .toEqual({ one: 20_000, two: 20_000, rejects1: [], rejects2: [] });
  owner2.close(); s.owner.close(); s.m.close();
});
