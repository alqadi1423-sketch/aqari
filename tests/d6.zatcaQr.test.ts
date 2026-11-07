/**
 * التوجيه الرابع ٦ · ١ · قراءة QR فاتورة الشراء (هيئة الزكاة والضريبة والجمارك): الحمولة Base64 لسلسلة TLV (وسمٌ ثم طولٌ ثم قيمة) ·
 * المرحلة الأولى خمسة وسوم: ١ اسم البائع، ٢ رقمه الضريبي، ٣ وقت الفاتورة، ٤ الإجمالي شاملاً الضريبة، ٥ الضريبة · والمرحلة الثانية
 * تزيد ٦ إلى ٩ (البصمة والتوقيع والمفتاح العام وتوقيع الشهادة) فتُقرأ الخمسة ويُعلَم أنها من المرحلة الثانية · بيانات مصطنعة، والعيّنة
 * العامة المنشورة في وثائق المرحلة الأولى.
 */
import { decodeZatcaQr, type ZatcaQr } from '@/domain/zatcaQr';
import { zatcaTlvBase64 } from '@/domain/printDocs';

const tlv = (pairs: Array<[number, string | Uint8Array]>) => {
  const out: number[] = [];
  for (const [t, v] of pairs) {
    const b = typeof v === 'string' ? Array.from(new TextEncoder().encode(v)) : Array.from(v);
    out.push(t, b.length, ...b);
  }
  return Buffer.from(Uint8Array.from(out)).toString('base64');
};
const ok = (r: ReturnType<typeof decodeZatcaQr>): ZatcaQr => { if (!r.ok) throw new Error(r.error); return r.qr; };

describe('قراءة QR فاتورة هيئة الزكاة', () => {
  test('العيّنة العامة للمرحلة الأولى', () => {
    const q = ok(decodeZatcaQr('AQVTYWxsYQIKMTIzNDU2Nzg5MQMUMjAyMS0wNy0xMlQxNDoyNTowOVoEBjEwMC4wMAUFMTUuMDA='));
    expect(q).toMatchObject({ sellerName: 'Salla', vatNo: '1234567891', issuedAt: '2021-07-12T14:25:09Z',
      totalHalalas: 10000, vatHalalas: 1500, subtotalHalalas: 8500, phase: 1 });
    // الرقم الضريبي في العيّنة ليس بصيغة الهيئة (١٥ رقماً يبدأ وينتهي بـ٣)
    expect(q.warnings).toContain('vatNo');
  });

  test('ما يطبعه التطبيق نفسه يُقرأ كما هو · باسمٍ عربي وأطوالٍ بالبايت', () => {
    const s = zatcaTlvBase64('مؤسسة مصطنعة للصيانة', '300000000000003', '2026-11-07T10:00:00Z', 115000, 15000);
    const q = ok(decodeZatcaQr(s));
    expect(q).toMatchObject({ sellerName: 'مؤسسة مصطنعة للصيانة', vatNo: '300000000000003', issuedAt: '2026-11-07T10:00:00Z',
      totalHalalas: 115000, vatHalalas: 15000, subtotalHalalas: 100000, phase: 1, warnings: [] });
  });

  test('المرحلة الثانية: الوسوم ٦ إلى ٩ تُتخطّى ويُعلَم بها', () => {
    const s = tlv([[1, 'مورد مصطنع'], [2, '310000000000003'], [3, '2026-10-01T08:30:00'], [4, '230.00'], [5, '30.00'],
      [6, 'aGFzaA=='], [7, new Uint8Array(70).fill(7)], [8, new Uint8Array(88).fill(8)], [9, new Uint8Array(72).fill(9)]]);
    const q = ok(decodeZatcaQr(s));
    expect(q).toMatchObject({ vatNo: '310000000000003', totalHalalas: 23000, vatHalalas: 3000, subtotalHalalas: 20000, phase: 2, warnings: [] });
  });

  test('مبالغ بلا كسور أو بفاصل آلاف، ومسافاتٌ حول الحمولة', () => {
    const q = ok(decodeZatcaQr('  ' + tlv([[1, 'م'], [2, '300000000000003'], [3, '2026-01-01T00:00:00Z'], [4, '1,150'], [5, '150']]) + '\n'));
    expect([q.totalHalalas, q.vatHalalas, q.subtotalHalalas]).toEqual([115000, 15000, 100000]);
  });

  test('تنبيهات لا تمنع القراءة: ضريبةٌ فوق الإجمالي، أو نسبتها غير ١٥٪، أو وقتٌ لا يُقرأ', () => {
    const over = ok(decodeZatcaQr(tlv([[1, 'م'], [2, '300000000000003'], [3, 'أمس'], [4, '100.00'], [5, '200.00']])));
    expect(over.warnings).toEqual(expect.arrayContaining(['vatOverTotal', 'issuedAt']));
    const rate = ok(decodeZatcaQr(tlv([[1, 'م'], [2, '300000000000003'], [3, '2026-01-01T00:00:00Z'], [4, '100.00'], [5, '5.00']])));
    expect(rate.warnings).toContain('rate');
  });

  test('ما ليس QR هيئة الزكاة يُرفض بسببه: رابط، أو نصٌّ ليس Base64، أو سلسلةٌ مبتورة، أو بلا وسومها الخمسة', () => {
    expect(decodeZatcaQr('https://example.test/invoice/1')).toEqual({ ok: false, error: 'url' });
    expect(decodeZatcaQr('ليس رمزاً')).toEqual({ ok: false, error: 'format' });
    const cut = tlv([[1, 'مورد'], [2, '300000000000003']]);
    expect(decodeZatcaQr(Buffer.from(Buffer.from(cut, 'base64').subarray(0, 8)).toString('base64'))).toEqual({ ok: false, error: 'format' });
    expect(decodeZatcaQr(tlv([[1, 'مورد'], [2, '300000000000003']]))).toEqual({ ok: false, error: 'missing' });
    expect(decodeZatcaQr('')).toEqual({ ok: false, error: 'empty' });
  });
});

import { purchaseDraftFromQr } from '@/domain/purchaseQr';
import { memDb } from './helpers/testDb';

describe('مسودة فاتورة الشراء من QR', () => {
  test('المورد بالرقم الضريبي إن عُرف، والتاريخ يوم الإصدار بتوقيت الرياض، والمبالغ كما في الرمز', () => {
    const db = memDb();
    db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S-1', 'مورد معروف مصطنع', '300000000000003', '2026-01-01T00:00:00.000Z')`);
    const qr = ok(decodeZatcaQr(zatcaTlvBase64('اسمٌ آخر في الرمز', '300000000000003', '2026-11-06T22:30:00Z', 115000, 15000)));
    // 22:30 بتوقيت غرينتش = 01:30 من 7 نوفمبر بتوقيت الرياض
    expect(purchaseDraftFromQr(db, qr)).toEqual({ supplier: 'مورد معروف مصطنع', supplierId: 'S-1', newSupplierVat: null, date: '2026-11-07',
      subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000, warnings: [] });
  });

  test('موردٌ جديد برقمه إن صحّ، وبلا رقمٍ إن لم يصح · ووقتٌ لا يُقرأ يأخذ اليوم', () => {
    const db = memDb();
    const fresh = ok(decodeZatcaQr(zatcaTlvBase64('مورد جديد مصطنع', '311111111111113', '2026-11-01T09:00:00Z', 23000, 3000)));
    expect(purchaseDraftFromQr(db, fresh)).toMatchObject({ supplier: 'مورد جديد مصطنع', supplierId: null, newSupplierVat: '311111111111113', date: '2026-11-01' });
    const odd = ok(decodeZatcaQr('AQVTYWxsYQIKMTIzNDU2Nzg5MQMUMjAyMS0wNy0xMlQxNDoyNTowOVoEBjEwMC4wMAUFMTUuMDA='));
    expect(purchaseDraftFromQr(db, odd)).toMatchObject({ supplier: 'Salla', newSupplierVat: null, date: '2021-07-12' });
    const noDate = { ...fresh, issuedAt: 'أمس', warnings: ['issuedAt' as const] };
    expect(purchaseDraftFromQr(db, noDate, () => '2026-11-07').date).toBe('2026-11-07');
  });
});

import { pickZatcaQr } from '@/domain/zatcaQr';
import fs from 'fs';
import path from 'path';

describe('صورةٌ فيها أكثر من رمز', () => {
  const good = zatcaTlvBase64('مورد مصطنع', '300000000000003', '2026-11-01T09:00:00Z', 115000, 15000);
  test('يُختار رمز هيئة الزكاة ولو سبقه رابط المتجر أو رمزٌ آخر', () => {
    const r = pickZatcaQr(['https://example.test/store', 'ليس رمزاً', good]);
    expect(r.ok && r.qr.totalHalalas).toBe(115000);
  });
  test('بلا رمزٍ صالح: السبب الأقرب إلى رمز الهيئة · وبلا رموزٍ أصلاً «empty»', () => {
    expect(pickZatcaQr([])).toEqual({ ok: false, error: 'empty' });
    expect(pickZatcaQr(['https://example.test/x'])).toEqual({ ok: false, error: 'url' });
    expect(pickZatcaQr(['https://example.test/x', 'ليس رمزاً'])).toEqual({ ok: false, error: 'format' });
    const partial = Buffer.from(Uint8Array.from([1, 1, 65, 2, 1, 66])).toString('base64');
    expect(pickZatcaQr(['ليس رمزاً', partial, 'https://example.test/x'])).toEqual({ ok: false, error: 'missing' });
  });
});

describe('المورد في المسودة', () => {
  test('بالاسم إن لم يُعرف رقمه الضريبي، فلا يُقترح موردٌ مكرَّر', () => {
    const db = memDb();
    db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S-2', 'مورد مصطنع بلا رقم', '', '2026-01-01T00:00:00.000Z')`);
    const qr = ok(decodeZatcaQr(zatcaTlvBase64(' مورد مصطنع بلا رقم ', '311111111111113', '2026-11-01T09:00:00Z', 23000, 3000)));
    expect(purchaseDraftFromQr(db, qr)).toMatchObject({ supplier: 'مورد مصطنع بلا رقم', supplierId: 'S-2', newSupplierVat: null });
  });
  test('والمحذوف لا يُطابَق', () => {
    const db = memDb();
    db.run(`INSERT INTO suppliers (id, name, vat, created_at, deleted_at) VALUES ('S-3', 'مورد محذوف', '311111111111113', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`);
    const qr = ok(decodeZatcaQr(zatcaTlvBase64('مورد محذوف', '311111111111113', '2026-11-01T09:00:00Z', 23000, 3000)));
    expect(purchaseDraftFromQr(db, qr)).toMatchObject({ supplierId: null, newSupplierVat: '311111111111113' });
  });
});

describe('الربط بشاشة المشتريات (لا تعمل الواجهة على Node · فحصٌ للمصدر)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'purchases.tsx'), 'utf8');
  const svc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'invoiceQr.ts'), 'utf8');
  test('زرّ القراءة في الفاتورة الجديدة وحدها، والصورة تُرفق أصلاً للفاتورة', () => {
    expect(src).toMatch(/!editingId[\s\S]{0,200}purchaseQr\.read/);
    expect(src).toMatch(/readQrFromImage\(/);
    expect(src).toMatch(/pickZatcaQr\(/);
    expect(src).toMatch(/purchaseDraftFromQr\(/);
    expect(src).toMatch(/setPendingFile\(img\)/);
  });
  test('الخدمة تقرأ بوحدة ML Kit للرموز وتفشل برسالةٍ مفهومة إن غابت', () => {
    expect(svc).toMatch(/import\('@react-native-ml-kit\/barcode-scanning'\)/);
    expect(svc).toMatch(/qr-unavailable/);
  });
});

describe('صورة الجوال الافتراضي (e2e/qrInvoice.js)', () => {
  test('حمولتها تُقرأ فاتورةً: ١١٥٠٫٠٠ شاملةً ١٥٠٫٠٠ ضريبة، فالصافي ١٠٠٠٫٠٠ (١١٥٠ − ١٥٠)، بلا تنبيه', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { payload } = require('../e2e/qrInvoice.js');
    const q = ok(decodeZatcaQr(payload));
    expect(q).toMatchObject({ sellerName: 'E2E QR Supplier', vatNo: '300000000000003',
      totalHalalas: 115000, vatHalalas: 15000, subtotalHalalas: 100000, warnings: [] });
  });
  test('والصورة PNG صالحة البنية', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { payload, qrPng } = require('../e2e/qrInvoice.js');
    const png: Buffer = qrPng(payload);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBeGreaterThan(200);
  });
});

describe('المكررة في الشاشة', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'purchases.tsx'), 'utf8');
  test('تُفحص عند القراءة، ويُحفظ المفتاح مع الفاتورة الجديدة وحدها، ويُفرَّغ عند فتح فاتورةٍ جديدة', () => {
    expect(src).toMatch(/purchaseByQrKey\(db, key\)/);
    expect(src).toMatch(/qrKey: editingId \? undefined : qrKey \|\| undefined/);
    expect(src).toMatch(/setPendingFile\(null\);\n\s*setQrKey\(''\);/);
  });
});
