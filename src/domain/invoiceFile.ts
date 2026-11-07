/**
 * قيمة رمز QR من ملف الفاتورة الإلكترونية (التوجيه الرابع ٦ · ١ · «صورة أو PDF، ورمز QR أولاً»): فاتورة المرحلة الثانية XML بصيغة
 * UBL تحمل قيمة رمزها في AdditionalDocumentReference برقم «QR» (EmbeddedDocumentBinaryObject)، وتُرسل غالباً PDF/A-3 يضمّنه ·
 * دالةٌ خالصة تعيد القيم، ويختار منها pickZatcaQr ويفكّها decodeZatcaQr · وPDF بلا ملفٍ مضمّن لا قيمة فيه (رمزه صورةٌ تُصوَّر) ·
 * والإشعار الدائن (InvoiceTypeCode 381 أو جذر CreditNote) ليس فاتورة شراء فلا قيم له (المدقق الخارجي J٦: كان يُعبَّأ بمبالغ موجبة
 * فيزيد المصروف بدل أن ينقص) · invoiceFileKind يقوله للواجهة.
 */
import { strFromU8 } from 'fflate';
import { pdfEmbeddedFiles } from './pdf/miniPdfText';

/** سقف نص الملف المفحوص (فواتير XML صغيرة، والمسح خطّي فالسقف حدٌّ للذاكرة لا للزمن)، والمضمّن في PDF مقيَّد بسقوف المستخرج */
const MAX_XML_CHARS = 8 * 1024 * 1024;
/** ما يُفحص من مراجع «QR» في ملفٍ واحد · والفاتورة فيها واحد */
const MAX_QR_REFS = 16;

/**
 * كل قيمة رمزٍ في XML الفاتورة: مرجعٌ إضافي رقمه QR يليه كائنٌ ثنائي مضمّن · بأي بادئةٍ للنطاق · بمسحٍ خطّي بحدودٍ لكل خطوة (المدقق
 * الخارجي J٨: التعبير النمطي الواحد كان تربيعياً، فملفٌ مصنوع يحبس الواجهة)
 */
export function qrFromInvoiceXml(xml: string): string[] {
  const text = xml.length > MAX_XML_CHARS ? xml.slice(0, MAX_XML_CHARS) : xml;
  const out: string[] = [];
  const idTag = /<(?:[\w-]{1,40}:)?ID\b[^<>]{0,200}>/g;
  const openObj = /<(?:[\w-]{1,40}:)?EmbeddedDocumentBinaryObject\b[^<>]{0,500}>/;
  let refs = 0;
  for (let m = idTag.exec(text); m && refs < MAX_QR_REFS; m = idTag.exec(text)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 2400);
    const close = /^\s*QR\s*<\/(?:[\w-]{1,40}:)?ID>/.exec(after);
    if (!close) continue;
    refs++;
    const rest = after.slice(close[0].length);
    const o = openObj.exec(rest.slice(0, 2000));
    if (!o) continue;
    const start = m.index + m[0].length + close[0].length + o.index + o[0].length;
    const end = text.indexOf('<', start);
    if (end < 0 || end - start > 20000) continue;
    const v = text.slice(start, end).replace(/\s+/g, '');
    if (v && /^<\/(?:[\w-]{1,40}:)?EmbeddedDocumentBinaryObject>/.test(text.slice(end, end + 80))) out.push(v);
    idTag.lastIndex = Math.max(idTag.lastIndex, end);
  }
  return out;
}

/** نوع مستند UBL: فاتورة، أو إشعار دائن (381 أو جذر CreditNote)، أو ليس مستند UBL */
export function invoiceXmlKind(xml: string): 'invoice' | 'credit' | 'other' {
  const head = xml.slice(0, 200000);
  if (/<(?:[\w-]{1,40}:)?CreditNote\b/.test(head)) return 'credit';
  const code = /<(?:[\w-]{1,40}:)?InvoiceTypeCode\b[^<>]{0,200}>\s*(\d{3})\s*</.exec(head);
  if (code?.[1] === '381') return 'credit';
  return /<(?:[\w-]{1,40}:)?Invoice\b/.test(head) || code ? 'invoice' : 'other';
}

const utf8 = (b: Uint8Array): string => { try { return strFromU8(b); } catch { return ''; } };
const isPdf = (bytes: Uint8Array, name: string, mime: string) =>
  /\.pdf$/i.test(name) || /pdf/i.test(mime) || utf8(bytes.subarray(0, 5)) === '%PDF-';
const xmlTexts = (bytes: Uint8Array, name: string, mime: string): string[] =>
  isPdf(bytes, name, mime) ? pdfEmbeddedFiles(bytes).map(utf8)
    : [utf8(bytes.length > MAX_XML_CHARS ? bytes.subarray(0, MAX_XML_CHARS) : bytes)];

/** نوع ملف الفاتورة: إشعار دائن إن كان فيه (أو في ما يضمّنه) إشعارٌ دائن، وإلا فاتورة */
export function invoiceFileKind(bytes: Uint8Array, name: string, mime: string): 'invoice' | 'credit' {
  return xmlTexts(bytes, name, mime).some((x) => invoiceXmlKind(x) === 'credit') ? 'credit' : 'invoice';
}

/** قيم الرموز في ملف فاتورة: XML مباشرة، أو ما يضمّنه PDF · ولا قيم لغيرهما ولا للإشعار الدائن */
export function qrValuesFromInvoiceFile(bytes: Uint8Array, name: string, mime: string): string[] {
  return xmlTexts(bytes, name, mime).flatMap((x) => (invoiceXmlKind(x) === 'credit' ? [] : qrFromInvoiceXml(x)));
}
