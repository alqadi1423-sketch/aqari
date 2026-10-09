/**
 * التحقق المستقل من 6162e3e (القاعدة ٣٥) · ما وجده يُصلح (القاعدة ٩٦) · بيانات مصطنعة:
 *  ١. دمج مستأجرٍ له هوية في مستأجرٍ بلا هوية لا ينهار بالفهرس الفريد، ولا يكتب مدموجٌ ثانٍ فوق الأول
 *  ٢. فاتورة معلّقة بلا اتصال يقع تاريخها في ربعٍ قُدِّم بعدها لا تعطّل طابور الإصدار
 *  ٣. الإشعار الدائن يأخذ رمز ضريبة فاتورته (الصفري صفري، والخاضع خاضع ولو قرّبت ضريبته إلى صفر)
 *  ٤. المستأجر الذي أنشأته المسودة لا يُحذف يتيماً وله مرفقات
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import type { DB } from '@/db/adapter';
import { saveInvoice, saveCreditNote, type InvoiceInput } from '@/domain/invoices';
import { saveInvoiceIssued, issuePendingInvoices } from '@/domain/invoiceIssue';
import { vatReturnData } from '@/domain/vatReturn';
import { fileVatReturn } from '@/domain/vatFilings';
import { saveDraft } from '@/domain/contracts/service';
import { mergeTenants } from '@/domain/tenants';

const item = (d: ReturnType<typeof vatReturnData>, no: string) => d.items.find((x) => x.no === no)!;
const register = (db: DB) => db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
const inv = (lines: InvoiceInput['lines'], issue = '2026-02-10'): InvoiceInput =>
  ({ customer: 'عميل مصطنع', customerVat: '', issue, due: issue, notes: '', lines });
const tid = (db: DB, c: string) => db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [c])!.t;
const tenant = (db: DB, id: string, name: string, nat: string) =>
  db.run(`INSERT INTO tenants (id, name, national_id, phone, created_at) VALUES (?,?,?,?,?)`, [id, name, nat, '', '2025-01-01']);

test('١ الدمج في وجهةٍ بلا هوية: تأخذ هوية المدموج · والثاني لا يكتب فوق الأول', () => {
  const db = memDb();
  tenant(db, 'K', 'مستأجر دمج مصطنع', '');
  tenant(db, 'D1', 'مستأجر دمج مصطنع', '1000000601');
  mergeTenants(db, 'K', ['D1']);
  expect(db.get(`SELECT national_id AS n FROM tenants WHERE id = 'K'`)).toEqual({ n: '1000000601' });
  tenant(db, 'K2', 'مستأجر ثانٍ مصطنع', '');
  tenant(db, 'D2', 'مستأجر ثانٍ مصطنع', '1000000619');
  tenant(db, 'D3', 'مستأجر ثانٍ مصطنع', '1000000627');
  mergeTenants(db, 'K2', ['D2', 'D3'], { allowDifferentIds: true });
  expect(db.get(`SELECT national_id AS n FROM tenants WHERE id = 'K2'`)).toEqual({ n: '1000000619' });
  db.close();
});

test('٢ فاتورة معلّقة في ربعٍ قُدِّم بعدها تبقى معلّقة · وما بعدها يصدر', async () => {
  const db = memDb(); register(db);
  const off = { takeInvoiceSeq: async (): Promise<number> => { throw new Error('offline'); } };
  const line = [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 1000, taxPct: 15, taxCode: 'S' as const }];
  const r1 = await saveInvoiceIssued(db, off, inv(line, '2026-03-30'), 'مستحقة');
  const r2 = await saveInvoiceIssued(db, off, inv(line, '2026-04-02'), 'مستحقة');
  expect([r1.pending, r2.pending]).toEqual([true, true]);
  fileVatReturn(db, 2026, 1, '2026-04-05');
  let n = 0;
  const on = { takeInvoiceSeq: async () => ++n };
  await expect(issuePendingInvoices(db, on)).resolves.toBe(1);
  expect(db.get(`SELECT status AS s FROM invoices WHERE id = ?`, [r2.id])).not.toEqual({ s: 'مسودة' });
  expect(db.get(`SELECT status AS s FROM invoices WHERE id = ?`, [r1.id])).toEqual({ s: 'مسودة' });
  db.close();
});

test('٣ الإشعار الدائن برمز فاتورته', () => {
  const db = memDb(); register(db);
  const z = saveInvoice(db, inv([{ descr: 'صفري مصطنع', qty: 1, priceHalalas: 20000, taxPct: 0, taxCode: 'Z' }]), 'مستحقة');
  saveCreditNote(db, z, { date: '2026-02-20', reason: 'خصم مصطنع', subtotalHalalas: 5000 });
  const s = saveInvoice(db, inv([{ descr: 'خاضع مصطنع', qty: 1, priceHalalas: 10000, taxPct: 15, taxCode: 'S' }]), 'مستحقة');
  saveCreditNote(db, s, { date: '2026-02-20', reason: 'خصم صغير مصطنع', subtotalHalalas: 3 });
  const d = vatReturnData(db, 2026, 1);
  expect({ i1: item(d, '1').amountHalalas, i3: item(d, '3').amountHalalas, i5: item(d, '5').amountHalalas })
    .toEqual({ i1: 9997, i3: 15000, i5: 0 });
  db.close();
});

test('٤ مستأجر المسودة لا يُحذف يتيماً وله مرفقات', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مرفق مصطنع' }));
  const id = saveDraft(db, contractInput(u, { tenant: 'مستأجر مرفق مصطنع', idNumber: '1000000635', phone: '0500000651', depositHalalas: 0 }) as never);
  const t1 = tid(db, id);
  db.run(`INSERT INTO blobs (sha256, ext, size_bytes, created_at) VALUES ('h1', 'jpg', 1, '2026-01-01')`);
  db.run(`INSERT INTO attachments (id, sha256, entity_type, entity_id, kind, created_at) VALUES ('A1', 'h1', 'tenant', ?, 'tenant_id', '2026-01-01')`, [t1]);
  saveDraft(db, contractInput(u, { tenant: 'مستأجر مرفق مصطنع', idNumber: '1000000643', phone: '0500000651', depositHalalas: 0 }) as never, id);
  expect(db.get(`SELECT deleted_at AS d FROM tenants WHERE id = ?`, [t1])).toEqual({ d: null });
  db.close();
});
