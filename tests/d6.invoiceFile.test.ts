/**
 * التوجيه الرابع ٦ · ١ · «صورة أو PDF، ورمز QR أولاً»: الفاتورة الإلكترونية في المرحلة الثانية ملف XML بصيغة UBL يحمل قيمة رمزها في
 * «AdditionalDocumentReference» برقم «QR»، وتُرسل غالباً PDF/A-3 يضمّن ذلك الملف · فتُقرأ القيمة من ملف XML أو من PDF يضمّنه، بلا
 * صورة · وPDF بلا ملفٍ مضمّن لا رمز فيه يُقرأ (الرمز فيه صورة) · بيانات مصطنعة.
 */
import { deflateSync } from 'fflate';
import { qrFromInvoiceXml, qrValuesFromInvoiceFile } from '@/domain/invoiceFile';
import { pickZatcaQr } from '@/domain/zatcaQr';
import { zatcaTlvBase64 } from '@/domain/printDocs';

const QR = zatcaTlvBase64('مورد مصطنع', '300000000000003', '2026-11-02T10:15:30Z', 230000, 30000);
const xml = (qr: string, prefix = 'cbc') => `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
  <cac:AdditionalDocumentReference><${prefix}:ID>ICV</${prefix}:ID><${prefix}:UUID>7</${prefix}:UUID></cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <${prefix}:ID>QR</${prefix}:ID>
    <cac:Attachment>
      <${prefix}:EmbeddedDocumentBinaryObject mimeCode="text/plain">
        ${qr}
      </${prefix}:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
</Invoice>`;
const enc = (s: string) => new TextEncoder().encode(s);
const latin = (b: Uint8Array) => Array.from(b, (x) => String.fromCharCode(x)).join('');
/** PDF مصغّر: صفحة نصٍّ عادي، ومجرى EmbeddedFile مضغوط يحمل الملف */
const pdfWith = (embedded: Uint8Array | null) => {
  const parts: string[] = ['%PDF-1.7\n'];
  parts.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  parts.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  parts.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n');
  if (embedded) {
    const z = deflateSync(embedded);
    parts.push(`4 0 obj\n<< /Type /EmbeddedFile /Subtype /text#2Fxml /Filter /FlateDecode /Length ${z.length} >>\nstream\n` + latin(z) + '\nendstream\nendobj\n');
  }
  parts.push('trailer\n<< /Root 1 0 R >>\n%%EOF\n');
  return Uint8Array.from(parts.join(''), (c) => c.charCodeAt(0));
};

describe('قيمة الرمز من ملف الفاتورة الإلكترونية', () => {
  test('من XML بصيغة UBL، وبأي بادئةٍ للنطاق، والمسافات حول القيمة لا تضر', () => {
    expect(qrFromInvoiceXml(xml(QR))).toEqual([QR]);
    expect(qrFromInvoiceXml(xml(QR, 'x'))).toEqual([QR]);
    expect(qrFromInvoiceXml('<Invoice><cbc:ID>ICV</cbc:ID></Invoice>')).toEqual([]);
  });
  test('ملف XML يُقرأ فاتورةً: ٢٣٠٠٫٠٠ شاملةً ٣٠٠٫٠٠ ضريبة، فالصافي ٢٠٠٠٫٠٠', () => {
    const r = pickZatcaQr(qrValuesFromInvoiceFile(enc(xml(QR)), 'invoice.xml', 'text/xml'));
    expect(r.ok && [r.qr.totalHalalas, r.qr.vatHalalas, r.qr.subtotalHalalas]).toEqual([230000, 30000, 200000]);
  });
  test('PDF/A-3 يضمّن الملف: تُقرأ القيمة منه', () => {
    const r = pickZatcaQr(qrValuesFromInvoiceFile(pdfWith(enc(xml(QR))), 'invoice.pdf', 'application/pdf'));
    expect(r.ok && r.qr.issuedAt).toBe('2026-11-02T10:15:30Z');
  });
  test('PDF بلا ملفٍ مضمّن، أو ملفٌ تالف: لا قيم، فيقول التطبيق «لا رمز»', () => {
    expect(qrValuesFromInvoiceFile(pdfWith(null), 'invoice.pdf', 'application/pdf')).toEqual([]);
    expect(qrValuesFromInvoiceFile(enc('ليس ملفاً'), 'x.pdf', 'application/pdf')).toEqual([]);
    expect(pickZatcaQr([])).toEqual({ ok: false, error: 'empty' });
  });
});
