/**
 * B-1 · حرج · src/sync/engine.ts:2244-2263 (applyOne يكتب سطر الفاتورة والقسط الواردين بلا حارسٍ لحالة أبيهما) · firestore.rules:492-516
 * (memberCreates: opCreates('invoices','invoice_lines') بـ«إدخال» وعقار السطر «*») و:627 (memberUpdates: «كامل» بلا شرط حالة) ·
 * src/domain/invoices.ts:127 (القفل في saveInvoice وحده)
 *
 * السيناريو (بيانات مصطنعة): المالك أصدر فاتورة بيع خاضعة بـ ١٬٠٠٠ ريال وضريبتها ١٥٠ وزامنها. عضوٌ له «إدخال» وحده في الفواتير
 * (أدنى مستوى كتابة) يكتب في السحابة مستنداً واحداً بمفتاحه ورموزه كما يبنيها جهازه (annotate): سطرٌ جديد في invoice_lines يحمل
 * invoice_id الفاتورة الصادرة، خاضعٌ بـ ١٠٠٬٠٠٠ ريال، ومعه سطرٌ معفى بهللة واحدة. القواعد تقبله (إنشاء جدولٍ ينشئه القسم، وعقاره «*»
 * لأن سطر الفاتورة بلا عمود عقار)، وجهاز المالك يطبّقه كما هو.
 *
 * لماذا يهم: «الفاتورة الصادرة مقفلة: لا تُعدَّل ولا تعود مسودة ولا تُحذف» (قرار المالك 2026-10-07 على #30 · DESIGN §١٣.١٣)، والقفل
 * في saveInvoice وحده. فالفاتورة المطبوعة تتغيّر بعد إصدارها، والإقرار الضريبي يحسبها سطراً سطراً حين تختلط رموزها
 * (vatReturn.ts:invoiceSales) فيرتفع البند ١ وضريبته ويختلف عن حساب 2200 في الدفتر الذي لم يتغيّر · وعضوٌ بأدنى مستوى يفعله.
 *
 * السلوك الصحيح: جهاز المالك يرفض أي سطرٍ يُنشأ أو يُعدَّل أو يُحذف لفاتورةٍ غير مسودة (ويعيد نسخته)، فتبقى سطورها وإقرارها كما
 * صدرت · والقاعدة في الخادم (حين يُبنى) تشترط أن تكون فاتورة السطر مسودةً لكاتبها.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { saveInvoice } from '@/domain/invoices';
import { vatReturnData } from '@/domain/vatReturn';
import type { Access } from '@/domain/access/access';
import type { RemoteDoc } from '@/sync/types';

test.failing('B-1 · سطرٌ مزوَّر من عضو «إدخال» على فاتورةٍ صادرة لا يدخل دفاتر المالك ولا إقراره', async () => {
  const db = memDb();
  const r = new MemoryRemote();
  enableSync(db, 'OWNER-B1');
  const dev = getMeta(db, 'device_id')!;
  db.run(`UPDATE company SET vat_enabled = 1, name = 'منشأة مصطنعة', vatno = '300000000000003' WHERE id = 1`);
  const inv = saveInvoice(db, {
    customer: 'عميل مصطنع', customerVat: '', issue: '2026-04-10', due: '2026-04-30', notes: '',
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100_000, taxPct: 15 }],
  }, 'مستحقة');
  await syncOnce(db, r, dev);
  const before = vatReturnData(db, 2026, 2).items.find((x) => x.no === '1')!;
  expect(before).toMatchObject({ amountHalalas: 100_000, taxHalalas: 15_000 });

  // عضوٌ بـ«إدخال» الفواتير في عقارٍ واحد · مستنداته كما يبنيها جهازه (op وby وpids وg)
  const m: Access = { owner: false, uid: 'MEMBER-B1', perms: { invoices: 2 }, allProps: false, props: ['P-B1'] };
  const forged = (k: string, price: number, pct: number, code: string): RemoteDoc => annotate(db, {
    id: 'invoice_lines__' + k, t: 'invoice_lines', k, u: new Date().toISOString(), dev: 'DEV-MEMBER', del: false,
    d: { id: k, invoice_id: inv, descr: 'سطر مضاف', qty: 1, price_halalas: price, tax_pct: pct, sort: 9, tax_code: code },
  }, m).doc;
  const a = forged('FORGED-S', 10_000_000, 15, 'S');
  const b = forged('FORGED-E', 1, 0, 'E');
  // ما تفحصه القواعد في الإنشاء: قسمٌ ينشئ الجدول، وكاتبه هو، وعقاره «*» ورموزه عامة
  expect(a).toMatchObject({ op: 'invoices', by: 'MEMBER-B1', pids: ['*'] });
  await r.write([a, b]);

  await syncOnce(db, r, dev);
  const lines = db.all<{ id: string }>(`SELECT id FROM invoice_lines WHERE invoice_id = ?`, [inv]);
  const after = vatReturnData(db, 2026, 2).items.find((x) => x.no === '1')!;
  // eslint-disable-next-line no-console
  console.log('B-1 · سطور الفاتورة الصادرة بعد المزامنة:', lines.length, '· البند ١ قبل:', before, '· بعد:', after);
  expect(lines.length).toBe(1);
  expect(after).toEqual(before);
  db.close();
});

test.failing('B-1 (ب) · قسطٌ يضيفه عضو «إدخال» العقود إلى عقدٍ مؤكَّد لغيره لا يدخل جدول أقساطه', async () => {
  const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
  const { confirmContract } = await import('@/domain/contracts/service');
  const db = memDb();
  const r = new MemoryRemote();
  enableSync(db, 'OWNER-B1B');
  const dev = getMeta(db, 'device_id')!;
  const p = addProperty(db, { name: 'عقار مصطنع' });
  const u = addUnit(db, p);
  const c = confirmContract(db, contractInput(u, { tenant: 'مستأجر مصطنع ب١', idNumber: '1000000091', phone: '0555550091' }) as never);
  await syncOnce(db, r, dev);
  const n0 = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_installments WHERE contract_id = ?`, [c])!.n;
  const m: Access = { owner: false, uid: 'MEMBER-B1B', perms: { contracts: 2 }, allProps: false, props: [p] };
  const k = 'FORGED-INST';
  const doc = annotate(db, {
    id: 'contract_installments__' + k, t: 'contract_installments', k, u: new Date().toISOString(), dev: 'DEV-M', del: false,
    d: { id: k, contract_id: c, due_date: '2026-12-01', amount_halalas: 5_000_000, status: 'مستحقة' },
  }, m).doc;
  expect(doc.op).toBe('contracts');
  await r.write([doc]);
  await syncOnce(db, r, dev);
  const n1 = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_installments WHERE contract_id = ?`, [c])!.n;
  // eslint-disable-next-line no-console
  console.log('B-1 (ب) · أقساط العقد المؤكَّد قبل:', n0, '· بعد:', n1);
  expect(n1).toBe(n0);
  db.close();
});

/**
 * B-3 · عالٍ · firestore.rules:627 (memberUpdates: opOwns('company','company') بـ«كامل» يجيز أي حقلٍ في صفّها) و:600-603 (شاهد حذفٍ لصفٍّ
 * ليس في MEMBER_NO_HARD_DELETE: company ليس فيها) · src/sync/engine.ts:2244-2263 · app/settings.tsx:751-757 (تسجيل الضريبة للمالك وحده)
 * السيناريو: عضوٌ له «كامل» في «المنشأة والقوالب» (يعدّل الاسم والسجل والشعار) يكتب صفّ المنشأة نفسه بـ vat_enabled = 0، أو شاهد حذفٍ له ·
 * لماذا يهم: إعدادٌ للمالك وحده في الشاشة يغيّره عضوٌ من السحابة، فيسقط البند ١ من الإقرار إلى صفر وتخرج الفواتير بلا ضريبة على كل الأجهزة ·
 * السلوك الصحيح: جهاز المالك (والقاعدة) لا يقبلان من عضوٍ تغيير vat_enabled ولا حذف صفّ المنشأة، ويعيد المالك نسخته.
 */
test.failing('B-3 · عضو «كامل المنشأة» لا يطفئ تسجيل الضريبة ولا يحذف صفّ المنشأة', async () => {
  const db = memDb();
  const r = new MemoryRemote();
  enableSync(db, 'OWNER-B4');
  const dev = getMeta(db, 'device_id')!;
  db.run(`UPDATE company SET vat_enabled = 1, name = 'منشأة مصطنعة', vatno = '300000000000003' WHERE id = 1`);
  saveInvoice(db, {
    customer: 'عميل مصطنع', customerVat: '', issue: '2026-04-10', due: '2026-04-30', notes: '',
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100_000, taxPct: 15 }],
  }, 'مستحقة');
  await syncOnce(db, r, dev);
  const before = vatReturnData(db, 2026, 2).items.find((x) => x.no === '1')!;
  const m: Access = { owner: false, uid: 'MEMBER-B4', perms: { company: 3 }, allProps: true, props: [] };
  const row = db.get<Record<string, unknown>>(`SELECT * FROM company WHERE id = 1`)!;
  const doc = annotate(db, { id: 'company__1', t: 'company', k: '1', u: new Date().toISOString(), dev: 'DEV-M4', del: false,
    d: { ...row, vat_enabled: 0 } as never }, m).doc;
  expect(doc.op).toBe('company');
  await r.write([doc]);
  await syncOnce(db, r, dev);
  const after = vatReturnData(db, 2026, 2).items.find((x) => x.no === '1')!;
  const vat = db.get<{ v: number }>(`SELECT vat_enabled AS v FROM company WHERE id = 1`)?.v;
  // eslint-disable-next-line no-console
  console.log('B-3 · تسجيل الضريبة على جهاز المالك بعد كتابة العضو:', vat, '· البند ١ قبل:', before.taxHalalas, '· بعد:', after.taxHalalas);
  expect(vat).toBe(1);
  expect(after).toEqual(before);
  db.close();
});
