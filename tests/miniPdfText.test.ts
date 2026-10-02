/**
 * اختبارات المستخرج المصغّر لنصوص PDF — ملفات مركَّبة داخل الاختبار:
 * مجرى صريح، مجرى مضغوط Flate مع خريطة ToUnicode لرموز CID عربية،
 * مجرى كائنات ObjStm، ثم تكامل كامل مع محلّل عقد إيجار.
 */
import { zlibSync } from 'fflate';
import { extractPdfText } from '@/domain/pdf/miniPdfText';
import { parseEjarContract } from '@/domain/pdf/parseEjar';

/** سلسلة latin1 → بايتات (كل محارف بنية PDF ضمن 0–255) */
const toBytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
/** بايتات → سلسلة latin1 للدمج داخل نص الملف */
const bin = (u: Uint8Array) => String.fromCharCode(...u);

describe('المستخرج المصغّر لنصوص PDF', () => {
  test('مجرى صريح: أوامر Tj/TJ مع Tm وTd تُجمَّع أسطراً بالفارق العمودي', () => {
    const content = [
      'BT',
      '/F1 12 Tf',
      '1 0 0 1 50 700 Tm',
      '(Ejar Contract) Tj',
      '0 -20 Td',
      '(Contract No. 20240012345 / 10-2024) Tj',
      '0 -20 Td',
      '[(Tenancy Start Date ) (2024-10-01)] TJ',
      'ET',
    ].join('\n');
    const pdf = [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
      `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
      '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
      'trailer << /Root 1 0 R >>',
      '%%EOF',
    ].join('\n');
    const text = extractPdfText(toBytes(pdf));
    const lines = text.split('\n').filter((l) => l.trim());
    expect(lines[0]).toBe('Ejar Contract');
    expect(lines[1]).toBe('Contract No. 20240012345 / 10-2024');
    expect(lines[2]).toBe('Tenancy Start Date 2024-10-01');
  });

  test('مجرى مضغوط Flate + خريطة ToUnicode: رموز CID تُفكّ إلى العربية (bfchar وbfrange)', () => {
    // 0x0041 → «محمد» (bfchar متعدد المحارف)، 0x0050..0x0052 → ا ب ة (bfrange)
    const cmap = [
      '/CIDInit /ProcSet findresource begin',
      'begincmap',
      '1 beginbfchar',
      '<0041> <0645062D0645062F>',
      'endbfchar',
      '1 beginbfrange',
      '<0050> <0052> <0627>',
      'endbfrange',
      'endcmap end',
    ].join('\n');
    const content = [
      'BT',
      '/F2 11 Tf',
      '1 0 0 1 40 720 Tm',
      '(Name ) Tj',
      '<0041> Tj',
      '0 -18 Td',
      '<005000510052> Tj',
      'ET',
    ].join('\n');
    const zContent = zlibSync(toBytes(content));
    const pdf = [
      '%PDF-1.5',
      '3 0 obj << /Type /Page /Contents 8 0 R /Resources << /Font << /F2 6 0 R >> >> >> endobj',
      '6 0 obj << /Type /Font /Subtype /Type0 /BaseFont /Custom /ToUnicode 7 0 R >> endobj',
      `7 0 obj << /Length ${cmap.length} >> stream\n${cmap}\nendstream endobj`,
      `8 0 obj << /Length ${zContent.length} /Filter /FlateDecode >> stream\n${bin(zContent)}\nendstream endobj`,
      '%%EOF',
    ].join('\n');
    const text = extractPdfText(toBytes(pdf));
    const lines = text.split('\n').filter((l) => l.trim());
    expect(lines[0]).toBe('Name محمد');
    expect(lines[1]).toBe('ابة'); // ا ب ة من bfrange
  });

  test('مجرى كائنات ObjStm: قاموس الخط داخله يُوسَّع وتُقرأ خريطته', () => {
    // قاموس الخط (الكائن 6) محشور داخل ObjStm مضغوط — كما تفعل ملفات PDF 1.5 الحقيقية
    const inner = '<< /Type /Font /Subtype /Type0 /ToUnicode 7 0 R >>';
    const objStmData = `6 0\n${inner}`;
    const first = objStmData.indexOf(inner);
    const zObjStm = zlibSync(toBytes(objStmData));
    const cmap = '1 beginbfchar\n<0060> <0639>\nendbfchar'; // 0x60 → ع
    const content = 'BT /F9 10 Tf 1 0 0 1 10 500 Tm <0060> Tj ET';
    const pdf = [
      '%PDF-1.5',
      '3 0 obj << /Type /Page /Contents 8 0 R /Resources << /Font << /F9 6 0 R >> >> >> endobj',
      `5 0 obj << /Type /ObjStm /N 1 /First ${first} /Filter /FlateDecode /Length ${zObjStm.length} >> stream\n${bin(zObjStm)}\nendstream endobj`,
      `7 0 obj << /Length ${cmap.length} >> stream\n${cmap}\nendstream endobj`,
      `8 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
      '%%EOF',
    ].join('\n');
    const text = extractPdfText(toBytes(pdf));
    expect(text.trim()).toBe('ع'); // ع
  });

  test('تكامل: استخراج ثم تحليل عقد إيجار يجد الحقول', () => {
    const lines = [
      'Ejar Contract',
      'Contract No. 20240012345 / 10-2024',
      'Tenant Data',
      'ID No. 1055555555',
      'Mobile No. +966547777777',
      'Tenant Representative Data',
      'Tenancy Start Date 2024-10-01',
      'Tenancy End Date 2025-09-30',
      'Total Contract value 36,000.00',
      'Rent payment cycle Yearly',
    ];
    const content = 'BT\n/F1 10 Tf\n1 0 0 1 40 760 Tm\n'
      + lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj\n0 -16 Td`).join('\n')
      + '\nET';
    const pdf = [
      '%PDF-1.4',
      '3 0 obj << /Type /Page /Contents 4 0 R >> endobj',
      `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
      '%%EOF',
    ].join('\n');
    const text = extractPdfText(toBytes(pdf));
    const r = parseEjarContract(text);
    expect(r.contractNo).toBe('20240012345/10-2024');
    expect(r.idNumber).toBe('1055555555');
    expect(r.phone).toBe('0547777777');
    expect(r.start).toBe('2024-10-01');
    expect(r.end).toBe('2025-09-30');
    expect(r.valueHalalas).toBe(3600000);
  });
});
