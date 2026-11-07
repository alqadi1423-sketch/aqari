/**
 * قيمة رمز QR من ملف الفاتورة الإلكترونية (التوجيه الرابع ٦ · ١ · «صورة أو PDF، ورمز QR أولاً»): فاتورة المرحلة الثانية XML بصيغة
 * UBL تحمل قيمة رمزها في AdditionalDocumentReference برقم «QR» (EmbeddedDocumentBinaryObject)، وتُرسل غالباً PDF/A-3 يضمّنه ·
 * دالةٌ خالصة تعيد القيم، ويختار منها pickZatcaQr ويفكّها decodeZatcaQr · وPDF بلا ملفٍ مضمّن لا قيمة فيه (رمزه صورةٌ تُصوَّر).
 */
import { strFromU8 } from 'fflate';
import { pdfEmbeddedFiles } from './pdf/miniPdfText';

/** سقف نص الملف المفحوص (فواتير XML صغيرة، والمضمّن في PDF مقيَّد بسقوف المستخرج) */
const MAX_XML_CHARS = 8 * 1024 * 1024;

/** كل قيمة رمزٍ في XML الفاتورة: مرجعٌ إضافي رقمه QR يحمل كائناً ثنائياً مضمّناً · بأي بادئةٍ للنطاق */
export function qrFromInvoiceXml(xml: string): string[] {
  const text = xml.length > MAX_XML_CHARS ? xml.slice(0, MAX_XML_CHARS) : xml;
  const out: string[] = [];
  const re = /<(?:[\w-]+:)?ID\b[^>]*>\s*QR\s*<\/(?:[\w-]+:)?ID>[\s\S]{0,2000}?<(?:[\w-]+:)?EmbeddedDocumentBinaryObject\b[^>]*>([^<]{1,20000})<\/(?:[\w-]+:)?EmbeddedDocumentBinaryObject>/g;
  for (const m of text.matchAll(re)) {
    const v = m[1].replace(/\s+/g, '');
    if (v) out.push(v);
  }
  return out;
}

const utf8 = (b: Uint8Array): string => { try { return strFromU8(b); } catch { return ''; } };
const isPdf = (bytes: Uint8Array, name: string, mime: string) =>
  /\.pdf$/i.test(name) || /pdf/i.test(mime) || utf8(bytes.subarray(0, 5)) === '%PDF-';

/** قيم الرموز في ملف فاتورة: XML مباشرة، أو ما يضمّنه PDF · ولا قيم لغيرهما */
export function qrValuesFromInvoiceFile(bytes: Uint8Array, name: string, mime: string): string[] {
  if (isPdf(bytes, name, mime)) return pdfEmbeddedFiles(bytes).flatMap((f) => qrFromInvoiceXml(utf8(f)));
  return qrFromInvoiceXml(utf8(bytes.length > MAX_XML_CHARS ? bytes.subarray(0, MAX_XML_CHARS) : bytes));
}
