/**
 * المراجعة الشاملة 2026-11-13 · B-7 · منخفض · firestore.rules (memberCountersOk)
 *
 * السيناريو (بيانات مصطنعة): عضو «كامل الفواتير» يرفع INV في meta/counters واحداً في كل كتابة بلا فاتورةٍ تصدر، فيصنع فجواتٍ في تسلسل
 * الفاتورة الضريبية الذي قرّره المالك بلا فجوات (2026-10-05).
 *
 * المطلوب الآن (README §٤ المرحلة ٣ «تقرير الفجوات الآن، وجذره في الخادم»): تقريرٌ في «فحص المطابقة» يكشف أرقام الفاتورة الضريبية
 * المحجوزة بلا فاتورة. والجذر (الإصدار في الخادم بمعاملة واحدة) يُبنى مع الخادم.
 *  - الرقم مشغولٌ بأي صفٍّ في invoices: فاتورة أو إشعار دائن، صادرة أو محذوفة، وبحرف جهازٍ قديم أو بلا حرف.
 *  - رقم هذا الجهاز المحجوز (inv_reserved) ليس فجوة: تأخذه فاتورته التالية.
 *  - والتقرير للمالك وحده: جهاز العضو لا يرى كل الفواتير فيظن ما لا يراه فجوة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { memDb } from './helpers/testDb';
import { saveInvoiceIssued, INV_RESERVED_KEY } from '@/domain/invoiceIssue';
import { invoiceSeqGaps } from '@/domain/invoiceGaps';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';

const input = (issue: string) => ({ customer: 'عميل مصطنع', customerVat: '', issue, due: issue, notes: '',
  lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 1000, taxPct: 15, taxCode: 'S' as const }] });

/** مصدرٌ يعطي الأرقام المعطاة بترتيبها: ما تخطّاه هو ما رفعه العضو بلا فاتورة */
const seqs = (ns: number[]) => ({ takeInvoiceSeq: async () => { const n = ns.shift(); if (!n) throw new Error('لا رقم'); return n; } });

test('B-7 · أرقام الفاتورة الضريبية المحجوزة بلا فاتورة تظهر في التقرير، والمشغولة لا تظهر', async () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
  // العضو رفع العدّاد عند ٣ و٥ و٦ بلا فواتير · وفاتورة ٨ في سنةٍ أخرى
  const src = seqs([1, 2, 4, 7, 8]);
  for (const d of ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05', '2027-01-05']) await saveInvoiceIssued(db, src, input(d), 'مستحقة');
  expect(db.all<{ no: string }>(`SELECT no FROM invoices ORDER BY no`).map((r) => r.no))
    .toEqual(['INV-2026-0001', 'INV-2026-0002', 'INV-2026-0004', 'INV-2026-0007', 'INV-2027-0008']);
  expect(invoiceSeqGaps(db)).toEqual([3, 5, 6]);
  // رقمٌ بحرف جهازٍ قديم يشغل رقمه · وصفٌّ محذوف يشغل رقمه (الرقم الذي ظهر لا يُعاد)
  db.run(`UPDATE invoices SET no = 'INV-2026-0003-A' WHERE no = 'INV-2026-0002'`);
  db.run(`UPDATE invoices SET no = 'INV-2026-0005', deleted_at = '2026-05-01T00:00:00Z' WHERE no = 'INV-2026-0001'`);
  expect(invoiceSeqGaps(db)).toEqual([1, 2, 6]);
  // رقم هذا الجهاز المحجوز تأخذه فاتورته التالية: ليس فجوة
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, '6')`, [INV_RESERVED_KEY]);
  expect(invoiceSeqGaps(db)).toEqual([1, 2]);
  db.close();
});

test('B-7 · بلا فواتير صادرة أو بتسلسلٍ متصل: لا فجوات', async () => {
  const db = memDb();
  expect(invoiceSeqGaps(db)).toEqual([]);
  db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
  const src = seqs([1, 2, 3]);
  for (let i = 0; i < 3; i++) await saveInvoiceIssued(db, src, input('2026-01-05'), 'مستحقة');
  // المسودة برقمها المؤقت لا تدخل التسلسل
  await saveInvoiceIssued(db, src, input('2026-01-06'), 'مسودة');
  expect(invoiceSeqGaps(db)).toEqual([]);
  db.close();
});

test('B-7 · التقرير في «فحص المطابقة» للمالك وحده، ونصّه باللغتين', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'integrity.tsx'), 'utf8');
  expect(src).toMatch(/access\.owner\s*\?\s*invoiceSeqGaps\(db\)/);
  for (const k of ['title', 'detail']) {
    expect((ar as unknown as Record<string, Record<string, string>>).invoiceGaps?.[k]).toBeTruthy();
    expect((en as unknown as Record<string, Record<string, string>>).invoiceGaps?.[k]).toBeTruthy();
  }
});
