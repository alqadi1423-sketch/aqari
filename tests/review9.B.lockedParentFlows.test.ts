/**
 * المراجعة الشاملة 2026-11-13 · B-1 وB-3 · ما يكتبه التطبيق نفسه من جهاز عضوٍ حقيقي (مستنداته بكاتبه وقسمه كما يبنيها annotate) يبقى
 * مقبولاً على جهاز المالك بعد قفل الأب، ولو وصل على دفعات (دفعة العضو ثمانية صفوف، فيسحب المالك بين دفعتين): فاتورةٌ صادرة بسطورها،
 * ومسودةٌ عُدّلت وصدرت في حفظٍ واحد، وإشعارٌ دائن، وتحصيل، وعقدٌ جديد للعضو، ومسودة عقدٍ أكّدها «كامل» العقود، وتعديل اسم المنشأة ·
 * وما ليس منه يُرفض وتُعاد نسخة المالك: مبالغ الصادرة وعودتها مسودة، وسطرٌ مزوَّر (شاهد حذفٍ له في الطابور)، وحذف صفّ المنشأة ·
 * وجهاز العضو يأخذ تسجيل الضريبة من الوارد ولو غلب تعديله (adoptOwnerCols) فلا يُرفض تعديله المشروع · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { holdBack } from './helpers/rederive';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce, setSyncState, buildDoc } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { saveInvoice, saveCreditNote, payInvoice, setInvoiceStatus, type InvoiceInput } from '@/domain/invoices';
import { saveDraft, confirmContract } from '@/domain/contracts/service';
import { savePurchase } from '@/domain/purchases';
import { vatReturnData } from '@/domain/vatReturn';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteDoc, RemoteStore } from '@/sync/types';

const OWNER = 'OWNER-LPF';
const ISSUED = 'مستحقة'; // i18n-exempt: حالة مخزّنة
const dev = (db: DB) => getMeta(db, 'device_id')!;

/** جهاز المالك بعقارٍ ووحدتين وتسجيل الضريبة · مزامَن */
async function ownerSetup() {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, OWNER);
  owner.run(`UPDATE company SET vat_enabled = 1, name = 'منشأة مصطنعة', vatno = '300000000000003' WHERE id = 1`);
  const p = addProperty(owner, { name: 'عقار مصطنع' });
  const u1 = addUnit(owner, p, { unit_no: 'LPF-1' });
  const u2 = addUnit(owner, p, { unit_no: 'LPF-2' });
  await syncOnce(owner, r, dev(owner));
  return { r, owner, p, u1, u2 };
}

/** جهاز عضوٍ منضمّ: طابوره فارغ (الانضمام لا يرفع ما عنده)، ومستنداته بقسمه وكاتبه، وما لا قسم له لا يُرفع */
async function joinMember(r: MemoryRemote, a: Access) {
  const db = memDb();
  enableSync(db, a.uid!);
  db.run(`DELETE FROM sync_outbox`);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: OWNER, profile: { name: 'عضو مصطنع' } })]);
  setSyncState(db, 'org', OWNER);
  const remote: RemoteStore = {
    pull: (c, l) => r.pull(c, l),
    write: (d) => r.write(d),
    clockSample: () => r.clockSample(),
    reserveBlocks: (q) => r.reserveBlocks(q),
    takeInvoiceSeq: (f) => r.takeInvoiceSeq(f),
    memberMode: true,
    annotate: (d, doc) => annotate(d, doc, a).doc,
  };
  await syncOnce(db, remote, dev(db));
  return { db, sync: () => syncOnce(db, remote, dev(db)) };
}

/** يسحب المالك مرتين (ما ينتظر أباه يُعاد في المرور التالي) */
async function ownerPulls(owner: DB, r: MemoryRemote) {
  await syncOnce(owner, r, dev(owner));
  await syncOnce(owner, r, dev(owner));
}
const rejectsOf = (db: DB, tbl: string) => db.all<{ pk: string; reason: string }>(`SELECT pk, reason FROM sync_rejects WHERE tbl = ?`, [tbl]);
const linesOf = (db: DB, id: string) => db.all<{ id: string; price_halalas: number }>(`SELECT id, price_halalas FROM invoice_lines WHERE invoice_id = ? ORDER BY sort`, [id]);
const inv = (unitId: string | null, lines: InvoiceInput['lines']): InvoiceInput =>
  ({ customer: 'عميل مصطنع', customerVat: '', issue: '2026-04-10', due: '2026-04-30', notes: '', unitId, propertyId: null, lines });
const item1 = (db: DB) => vatReturnData(db, 2026, 2).items.find((x) => x.no === '1')!;

describe('B-1 · ما يكتبه التطبيق من جهاز العضو يُقبل بعد قفل الفاتورة الصادرة', () => {
  test('فاتورةٌ صادرة بثلاثة سطور من «كامل»، ويسحب المالك بين دفعتين: تصل سطورها كلها بلا رفض', async () => {
    const s = await ownerSetup();
    const m = await joinMember(s.r, { owner: false, uid: 'M-INV3', perms: { invoices: 3 }, allProps: true, props: [] });
    const id = saveInvoice(m.db, inv(s.u1, [
      { descr: 'خاضع مصطنع', qty: 1, priceHalalas: 60_000, taxPct: 15, taxCode: 'S' },
      { descr: 'معفى مصطنع', qty: 1, priceHalalas: 30_000, taxPct: 0, taxCode: 'E' },
      { descr: 'خاضع ثانٍ مصطنع', qty: 2, priceHalalas: 5_000, taxPct: 15, taxCode: 'S' },
    ]), ISSUED);
    await m.sync();
    // سطران في دفعةٍ لاحقة: قيد إصدارها ينتظر سطورها كلها (deriveSources: linesShort) ورأسها ينتظر قيده، فلا يُرفض شيءٌ وهي في الطريق
    const ids = linesOf(m.db, id).map((l) => l.id);
    const late = holdBack(s.r, (d) => d.t === 'invoice_lines' && ids.slice(1).includes(d.k));
    expect(late.count).toBe(2);
    await ownerPulls(s.owner, s.r);
    expect(rejectsOf(s.owner, 'invoice_lines')).toEqual([]);
    expect(linesOf(s.owner, id).length).toBeLessThan(3);
    late.release();
    await ownerPulls(s.owner, s.r);
    expect(rejectsOf(s.owner, 'invoice_lines')).toEqual([]);
    expect(rejectsOf(s.owner, 'invoices')).toEqual([]);
    expect(linesOf(s.owner, id).length).toBe(3);
    // والإقرار عند المالك كما عند العضو: الخاضع ٧٠٠ ريال وضريبته ١٠٥
    expect(item1(s.owner)).toMatchObject({ amountHalalas: 70_000, taxHalalas: 10_500 });
    s.owner.close(); m.db.close();
  });

  test('مسودةٌ عُدّلت سطورها وصدرت في حفظٍ واحد، ووصل حذف سطورها القديمة بعد رأسها الصادر: يُقبل كله', async () => {
    const s = await ownerSetup();
    const m = await joinMember(s.r, { owner: false, uid: 'M-INV3B', perms: { invoices: 3 }, allProps: true, props: [] });
    const draft = saveInvoice(m.db, inv(s.u1, [
      { descr: 'سطر أول مصطنع', qty: 1, priceHalalas: 10_000, taxPct: 15, taxCode: 'S' },
      { descr: 'سطر ثانٍ مصطنع', qty: 1, priceHalalas: 20_000, taxPct: 15, taxCode: 'S' },
    ]), 'مسودة');
    await m.sync();
    await ownerPulls(s.owner, s.r);
    expect(linesOf(s.owner, draft).length).toBe(2);
    saveInvoice(m.db, inv(s.u1, [{ descr: 'سطر معدَّل مصطنع', qty: 1, priceHalalas: 50_000, taxPct: 15, taxCode: 'S' }]), ISSUED, draft);
    await m.sync();
    const late = holdBack(s.r, (d) => d.t === 'invoice_lines' && !!d.del);
    expect(late.count).toBe(2);
    await ownerPulls(s.owner, s.r);
    late.release();
    await ownerPulls(s.owner, s.r);
    expect(rejectsOf(s.owner, 'invoice_lines')).toEqual([]);
    expect(linesOf(s.owner, draft).map((l) => Number(l.price_halalas))).toEqual([50_000]);
    s.owner.close(); m.db.close();
  });

  test('إشعارٌ دائن على الصادرة ثم تحصيل باقيها من «كامل»: يُقبلان، والإقرار ينقص بالإشعار', async () => {
    const s = await ownerSetup();
    const m = await joinMember(s.r, { owner: false, uid: 'M-INV3C', perms: { invoices: 3 }, allProps: true, props: [] });
    const id = saveInvoice(m.db, inv(s.u1, [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100_000, taxPct: 15, taxCode: 'S' }]), ISSUED);
    await m.sync();
    await ownerPulls(s.owner, s.r);
    const cn = saveCreditNote(m.db, id, { date: '2026-04-15', reason: 'تصحيح مصطنع', subtotalHalalas: 20_000 });
    payInvoice(m.db, id, { method: 'cash', bankId: null, date: '2026-04-20' });
    await m.sync();
    await ownerPulls(s.owner, s.r);
    expect(rejectsOf(s.owner, 'invoices')).toEqual([]);
    expect(rejectsOf(s.owner, 'invoice_lines')).toEqual([]);
    expect(linesOf(s.owner, cn).length).toBe(1);
    expect(s.owner.get<{ s: string }>(`SELECT status AS s FROM invoices WHERE id = ?`, [id])!.s).toBe('مدفوعة');
    expect(item1(s.owner)).toMatchObject({ amountHalalas: 80_000, taxHalalas: 12_000 });
    s.owner.close(); m.db.close();
  });
});

describe('B-1 · ما ليس من التطبيق على الفاتورة الصادرة يُرفض على جهاز المالك وتُعاد نسخته', () => {
  test('(ب) «كامل» يغيّر مبالغ الصادرة أو يعيدها مسودة: يُرفض، وتبقى كما صدرت، وتُرفع نسخة المالك', async () => {
    const s = await ownerSetup();
    const id = saveInvoice(s.owner, inv(s.u1, [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100_000, taxPct: 15, taxCode: 'S' }]), ISSUED);
    await syncOnce(s.owner, s.r, dev(s.owner));
    const before = item1(s.owner);
    const a: Access = { owner: false, uid: 'M-FULL', perms: { invoices: 3 }, allProps: true, props: [] };
    const cur = buildDoc(s.owner, 'invoices', id, 'upsert', new Date().toISOString(), 'DEV-M');
    s.r.inject(annotate(s.owner, { ...cur, dev: 'DEV-M', d: { ...cur.d!, subtotal_halalas: 1_000, tax_halalas: 150, total_halalas: 1_150 } }, a).doc);
    await syncOnce(s.owner, s.r, dev(s.owner));
    expect(rejectsOf(s.owner, 'invoices').map((x) => x.reason)).toEqual([expect.stringMatching(/مقفلة/)]);
    expect(item1(s.owner)).toEqual(before);
    // نسخة المالك عادت إلى السحابة
    expect(Number(s.r.docs.get('invoices__' + id)!.d!.subtotal_halalas)).toBe(100_000);
    const cur2 = buildDoc(s.owner, 'invoices', id, 'upsert', new Date().toISOString(), 'DEV-M');
    s.r.inject(annotate(s.owner, { ...cur2, dev: 'DEV-M', d: { ...cur2.d!, status: 'مسودة' } }, a).doc);
    await syncOnce(s.owner, s.r, dev(s.owner));
    expect(s.owner.get<{ s: string }>(`SELECT status AS s FROM invoices WHERE id = ?`, [id])!.s).toBe(ISSUED);
    expect(item1(s.owner)).toEqual(before);
    s.owner.close();
  });

  test('سطرٌ مزوَّر من «كامل» على صادرةٍ اكتملت سطورها: يُرفض ويُرفع شاهد حذفه فيزول من السحابة', async () => {
    const s = await ownerSetup();
    const id = saveInvoice(s.owner, inv(s.u1, [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100_000, taxPct: 15, taxCode: 'S' }]), ISSUED);
    await syncOnce(s.owner, s.r, dev(s.owner));
    const a: Access = { owner: false, uid: 'M-FULL2', perms: { invoices: 3 }, allProps: true, props: [] };
    const k = 'LPF-FORGED';
    s.r.inject(annotate(s.owner, { id: 'invoice_lines__' + k, t: 'invoice_lines', k, u: new Date().toISOString(), dev: 'DEV-M', del: false,
      d: { id: k, invoice_id: id, descr: 'سطر مضاف', qty: 1, price_halalas: 1_000, tax_pct: 0, sort: 9, tax_code: 'E' } } as RemoteDoc, a).doc);
    await syncOnce(s.owner, s.r, dev(s.owner));
    expect(rejectsOf(s.owner, 'invoice_lines').map((x) => x.pk)).toEqual([k]);
    expect(linesOf(s.owner, id).length).toBe(1);
    // شاهد حذف المالك رُفع في الدورة نفسها (أو التالية)
    await syncOnce(s.owner, s.r, dev(s.owner));
    expect(s.r.docs.get('invoice_lines__' + k)!.del).toBe(true);
    s.owner.close();
  });
});

describe('B-1 (ب) · أقساط العقد المؤكَّد', () => {
  test('عقدٌ جديد يؤكّده عضو «إدخال» العقود، وتصل أقساطه على دفعتين: تُقبل كلها', async () => {
    const s = await ownerSetup();
    const m = await joinMember(s.r, { owner: false, uid: 'M-CON2', perms: { contracts: 2, tenants: 2, props: 1 }, allProps: false, props: [s.p] });
    const c = confirmContract(m.db, contractInput(s.u2, { tenant: 'مستأجر مصطنع لب', idNumber: '1000000201', phone: '0555550201' }) as never);
    await m.sync();
    const all = m.db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY sort`, [c]).map((x) => x.id);
    expect(all.length).toBe(12);
    const late = holdBack(s.r, (d) => d.t === 'contract_installments' && all.slice(5).includes(d.k));
    await ownerPulls(s.owner, s.r);
    late.release();
    await ownerPulls(s.owner, s.r);
    expect(rejectsOf(s.owner, 'contract_installments')).toEqual([]);
    expect(s.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_installments WHERE contract_id = ?`, [c])!.n).toBe(12);
    s.owner.close(); m.db.close();
  });

  test('مسودة عقدٍ كتبها المالك يؤكّدها عضو «كامل» العقود، وتصل أقساطه على دفعتين: تُقبل كلها', async () => {
    const s = await ownerSetup();
    const draft = saveDraft(s.owner, contractInput(s.u2, { tenant: 'مستأجر مصطنع لج', idNumber: '1000000202', phone: '0555550202' }) as never);
    await syncOnce(s.owner, s.r, dev(s.owner));
    const m = await joinMember(s.r, { owner: false, uid: 'M-CON3', perms: { contracts: 3, tenants: 2, props: 1 }, allProps: true, props: [] });
    confirmContract(m.db, contractInput(s.u2, { tenant: 'مستأجر مصطنع لج', idNumber: '1000000202', phone: '0555550202' }) as never, draft);
    await m.sync();
    const all = m.db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY sort`, [draft]).map((x) => x.id);
    expect(all.length).toBe(12);
    const late = holdBack(s.r, (d) => d.t === 'contract_installments' && all.slice(4).includes(d.k));
    await ownerPulls(s.owner, s.r);
    late.release();
    await ownerPulls(s.owner, s.r);
    expect(rejectsOf(s.owner, 'contract_installments')).toEqual([]);
    expect(s.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_installments WHERE contract_id = ?`, [draft])!.n).toBe(12);
    s.owner.close(); m.db.close();
  });
});

// المراجعة الشاملة 2026-11-13 · المدقق المستقل R11 (B-1): ما شدّده إصلاح نتائجه يُبقي ما يكتبه التطبيق مقبولاً
describe('B-1 · ما يكتبه التطبيق بعد تشديد R11', () => {
  test('مسودة عقدٍ لعضو «إدخال» يؤكّدها «كامل» العقود، وتصل أقساطه على دفعتين: تُقبل كلها (R11-B1-4)', async () => {
    const s = await ownerSetup();
    const n = await joinMember(s.r, { owner: false, uid: 'M-CONN', perms: { contracts: 2, tenants: 2, props: 1 }, allProps: false, props: [s.p] });
    const input = contractInput(s.u2, { tenant: 'مستأجر مصطنع لد', idNumber: '1000000203', phone: '0555550203' });
    const draft = saveDraft(n.db, input as never);
    await n.sync();
    await ownerPulls(s.owner, s.r);
    expect(s.owner.get<{ s: string }>(`SELECT status AS s FROM contracts WHERE id = ?`, [draft])!.s).toBe('مسودة');
    const k = await joinMember(s.r, { owner: false, uid: 'M-CONK', perms: { contracts: 3, tenants: 2, props: 1 }, allProps: true, props: [] });
    confirmContract(k.db, input as never, draft);
    await k.sync();
    const all = k.db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY sort`, [draft]).map((x) => x.id);
    expect(all.length).toBe(12);
    const late = holdBack(s.r, (d) => d.t === 'contract_installments' && all.slice(3).includes(d.k));
    await ownerPulls(s.owner, s.r);
    late.release();
    await ownerPulls(s.owner, s.r);
    expect(rejectsOf(s.owner, 'contract_installments')).toEqual([]);
    expect(s.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_installments WHERE contract_id = ?`, [draft])!.n).toBe(12);
    s.owner.close(); n.db.close(); k.db.close();
  });

  test('ومسودته يؤكّدها «كامل» وجهاز المالك لم يرها مسودة: أقساط المؤكِّد تنتظر بلا رفض، ثم تُقبل بعد ساعةٍ بلا أقساطٍ من كاتبه', async () => {
    const s = await ownerSetup();
    const n = await joinMember(s.r, { owner: false, uid: 'M-CONN2', perms: { contracts: 2, tenants: 2, props: 1 }, allProps: false, props: [s.p] });
    const input = contractInput(s.u2, { tenant: 'مستأجر مصطنع له', idNumber: '1000000204', phone: '0555550204' });
    const draft = saveDraft(n.db, input as never);
    await n.sync();
    const k = await joinMember(s.r, { owner: false, uid: 'M-CONK2', perms: { contracts: 3, tenants: 2, props: 1 }, allProps: true, props: [] });
    confirmContract(k.db, input as never, draft);
    await k.sync();
    // المالك يسحب بعد التأكيد: العقد يصله مؤكَّداً بكاتبه N وأقساطه من K
    await ownerPulls(s.owner, s.r);
    const count = () => s.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_installments WHERE contract_id = ?`, [draft])!.n;
    expect(rejectsOf(s.owner, 'contract_installments')).toEqual([]);
    expect(count()).toBe(0);
    // مضت ساعةٌ على نسخة رأسه في السحابة ولم يصل من كاتبه قسط
    s.owner.run(`UPDATE sync_rowtime SET u = ? WHERE tbl = 'contracts' AND pk = ?`, [new Date(Date.now() - 2 * 3600_000).toISOString(), draft]);
    await ownerPulls(s.owner, s.r);
    expect(rejectsOf(s.owner, 'contract_installments')).toEqual([]);
    expect(count()).toBe(12);
    s.owner.close(); n.db.close(); k.db.close();
  });

  test('مسودة فاتورةٍ كتبها المالك يعدّل سطورها «كامل» الفواتير ويصدرها: تُقبل سطوره الجديدة وحذف القديمة (R11-B1-5)', async () => {
    const s = await ownerSetup();
    const draft = saveInvoice(s.owner, inv(s.u1, [{ descr: 'سطر المالك مصطنع', qty: 1, priceHalalas: 10_000, taxPct: 15, taxCode: 'S' }]), 'مسودة');
    await syncOnce(s.owner, s.r, dev(s.owner));
    const m = await joinMember(s.r, { owner: false, uid: 'M-INV3D', perms: { invoices: 3 }, allProps: true, props: [] });
    saveInvoice(m.db, inv(s.u1, [
      { descr: 'سطر العضو مصطنع', qty: 2, priceHalalas: 30_000, taxPct: 15, taxCode: 'S' },
      { descr: 'سطر معفى مصطنع', qty: 1, priceHalalas: 5_000, taxPct: 0, taxCode: 'E' },
    ]), ISSUED, draft);
    await m.sync();
    await ownerPulls(s.owner, s.r);
    expect(rejectsOf(s.owner, 'invoice_lines')).toEqual([]);
    expect(rejectsOf(s.owner, 'invoices')).toEqual([]);
    expect(linesOf(s.owner, draft).map((l) => Number(l.price_halalas)).sort((a, b) => a - b)).toEqual([5_000, 30_000]);
    expect(item1(s.owner)).toMatchObject({ amountHalalas: 60_000, taxHalalas: 9_000 });
    s.owner.close(); m.db.close();
  });

  test('«كامل» يعلّم صادرة المالك «متأخرة» ويحصّلها: يُقبلان (قائمة السماح · R11-B1-2)', async () => {
    const s = await ownerSetup();
    const id = saveInvoice(s.owner, inv(s.u1, [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100_000, taxPct: 15, taxCode: 'S' }]), ISSUED);
    await syncOnce(s.owner, s.r, dev(s.owner));
    const m = await joinMember(s.r, { owner: false, uid: 'M-INV3E', perms: { invoices: 3 }, allProps: true, props: [] });
    setInvoiceStatus(m.db, id, 'متأخرة');
    await m.sync();
    await ownerPulls(s.owner, s.r);
    expect(s.owner.get<{ s: string }>(`SELECT status AS s FROM invoices WHERE id = ?`, [id])!.s).toBe('متأخرة');
    payInvoice(m.db, id, { method: 'cash', bankId: null, date: '2026-04-20' });
    await m.sync();
    await ownerPulls(s.owner, s.r);
    expect(rejectsOf(s.owner, 'invoices')).toEqual([]);
    expect(s.owner.get<{ s: string }>(`SELECT status AS s FROM invoices WHERE id = ?`, [id])!.s).toBe('مدفوعة');
    s.owner.close(); m.db.close();
  });

  test('«كامل» المشتريات يعدّل فاتورة شراءٍ مرحّلة في التطبيق، ويسحب المالك بين قيودها ورأسها: يُقبل، والبند ٧ بقيمها الجديدة (R11-B1-3)', async () => {
    const s = await ownerSetup();
    s.owner.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
      ['LPF-S', 'مورد مصطنع', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
    const base = {
      date: '2026-04-10', due: '2026-05-10', incorpItem: '', amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false,
      unitId: null, propertyId: null, meterId: null, meterReading: null, supplier: 'مورد مصطنع', category: 'صيانة',
      taxStatus: 'فاتورة ضريبية · قابلة للخصم', subtotalHalalas: 100_000, taxHalalas: 15_000, totalHalalas: 115_000,
    };
    const id = savePurchase(s.owner, base as never);
    await syncOnce(s.owner, s.r, dev(s.owner));
    const m = await joinMember(s.r, { owner: false, uid: 'M-PUR3', perms: { purchases: 3 }, allProps: true, props: [] });
    savePurchase(m.db, { ...base, subtotalHalalas: 200_000, taxHalalas: 30_000, totalHalalas: 230_000 } as never, id);
    await m.sync();
    // رأسها في دفعةٍ لاحقة: قيودها تصل أولاً
    const late = holdBack(s.r, (d) => d.t === 'purchases' && d.k === id);
    expect(late.count).toBe(1);
    await ownerPulls(s.owner, s.r);
    late.release();
    await ownerPulls(s.owner, s.r);
    expect(rejectsOf(s.owner, 'purchases')).toEqual([]);
    expect(rejectsOf(s.owner, 'journal_entries')).toEqual([]);
    expect(vatReturnData(s.owner, 2026, 2).items.find((x) => x.no === '7')).toMatchObject({ amountHalalas: 200_000, taxHalalas: 30_000 });
    const in1270 = Number(s.owner.get<{ n: number }>(`SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas), 0) AS n FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id WHERE e.status = 'مرحّل' AND l.account_code = '1270'`)!.n);
    expect(in1270).toBe(30_000);
    s.owner.close(); m.db.close();
  });
});

describe('B-3 · صفّ المنشأة', () => {
  test('«كامل» المنشأة يعدّل اسمها بعد أن فعّل المالك الضريبة وقبل أن يسحب: يُقبل الاسم ويبقى التسجيل، وحذف الصف يُرفض', async () => {
    const s = await ownerSetup();
    s.owner.run(`UPDATE company SET vat_enabled = 0 WHERE id = 1`);
    await syncOnce(s.owner, s.r, dev(s.owner));
    const a: Access = { owner: false, uid: 'M-CO', perms: { company: 3 }, allProps: true, props: [] };
    const m = await joinMember(s.r, a);
    expect(m.db.get<{ v: number }>(`SELECT vat_enabled AS v FROM company WHERE id = 1`)!.v).toBe(0);
    // المالك يفعّل التسجيل ويزامن، والعضو يعدّل الاسم بعده وقبل أن يسحب: تعديله أحدث فيغلب الصف عنده
    s.owner.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
    await syncOnce(s.owner, s.r, dev(s.owner));
    await new Promise((res) => setTimeout(res, 5));
    m.db.run(`UPDATE company SET name = 'منشأة مصطنعة معدّلة' WHERE id = 1`);
    await m.sync();
    // جهاز العضو أخذ التسجيل من الوارد فرفع الصف به
    expect(Number(s.r.docs.get('company__1')!.d!.vat_enabled)).toBe(1);
    await ownerPulls(s.owner, s.r);
    expect(rejectsOf(s.owner, 'company')).toEqual([]);
    expect(s.owner.get<{ n: string; v: number }>(`SELECT name AS n, vat_enabled AS v FROM company WHERE id = 1`)).toEqual({ n: 'منشأة مصطنعة معدّلة', v: 1 });
    // شاهد حذفٍ لصفّ المنشأة من العضو
    s.r.inject({ ...annotate(m.db, { id: 'company__1', t: 'company', k: '1', u: new Date().toISOString(), dev: 'DEV-M', del: true, d: null } as RemoteDoc, a).doc, dby: 'M-CO' });
    await ownerPulls(s.owner, s.r);
    expect(rejectsOf(s.owner, 'company').length).toBe(1);
    expect(s.owner.get<{ v: number }>(`SELECT vat_enabled AS v FROM company WHERE id = 1`)!.v).toBe(1);
    expect(s.r.docs.get('company__1')!.del).toBe(false);
    s.owner.close(); m.db.close();
  });
});
