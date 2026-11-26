/**
 * ق٠-٤ · قراءة النص من الصور بلا قوقل (قرار المالك على س٣٤ 2026-11-13: «(أ) مكتبةٌ مفتوحة تقرأ العربية، و(ج) مؤقتاً إن تأخرت»).
 * الخيار (ج) الآن: لا قارئ نص من قوقل (ML Kit) في التطبيق، وصورة العقد أو الكشف تعرض رسالة «موقوفة الآن، فاختر PDF أو Excel»
 * بلا انهيار، وملفات PDF وExcel وCSV تُقرأ كما كانت · بياناتٌ مصطنعة كلها.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ML_KIT_TEXT = '@react-native-ml-kit/text-recognition';

// لا محاكاة لوحدة قوقل: الحزمة أُزيلت من الاعتمادات، فغيابها من كل ملفٍ في src/ وapp/ (أدناه) هو الدليل أن المسار لا يلمسها

// قارئ العقد يستورد خدمات السحابة والملفات · لا تلزم هنا
jest.mock('../src/services/cloud', () => ({ openFileNow: jest.fn() }));
jest.mock('../src/services/filesEnv', () => ({ appFilesEnv: jest.fn() }));

let fileBytes = new Uint8Array();
jest.mock('expo-file-system', () => ({
  File: class { constructor(public uri: string) {} bytesSync() { return fileBytes; } },
}));

import { scanContractFile } from '../src/services/contractScan';
import { statementSource } from '../src/services/bankStatement';
import { OCR_STOPPED, isOcrStopped } from '../src/services/imageText';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const walk = (d: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|json)$/.test(e.name)) out.push(p);
  }
  return out;
};
const enc = (s: string) => new TextEncoder().encode(s);
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

describe('لا قارئ نص من قوقل', () => {
  test('لا ملف في src/ ولا app/ يذكر وحدة ML Kit للنص', () => {
    const hits = [...walk('src'), ...walk('app')].filter((f) => read(f).includes(ML_KIT_TEXT));
    expect(hits).toEqual([]);
  });

  test('الحزمة ليست في الاعتمادات ولا في ملف القفل', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain(ML_KIT_TEXT);
    expect(read('package-lock.json')).not.toContain(ML_KIT_TEXT);
  });
});

describe('صورة العقد: رسالة الإيقاف بلا انهيار', () => {
  test('الصورة ترمي OCR_STOPPED بلا قارئٍ أصلي', async () => {
    const p = scanContractFile({ uri: 'file:///tmp/عقد.jpg', mimeType: 'image/jpeg', name: 'عقد.jpg' });
    await expect(p).rejects.toThrow(OCR_STOPPED);
    await p.catch((e) => expect(isOcrStopped(e)).toBe(true));
  });

  test('شاشة العقد تعرض رسالة الإيقاف بمفتاحها، وزرها لا يعد بقراءة الصورة', () => {
    const src = read('src/ui/contractForm.tsx');
    expect(src).toMatch(/isOcrStopped\(e\) \? t\('contractScan\.ocrStopped'\)/);
    expect(src).toMatch(/code === 'pdf-empty' \? t\('contractScan\.pdfEmpty'\)/);
    expect(src).toContain("title={t('contractScan.pick')}");
    expect(src).not.toContain('PDF أو صورة');
    expect(src).not.toContain('فالتقطه كصورة');
  });

  test('PDF العقد يُقرأ كما كان', async () => {
    const content = 'BT\n/F1 12 Tf\n1 0 0 1 50 700 Tm\n(Ejar Contract) Tj\n0 -20 Td\n(Contract No. 20240012345 / 10-2024) Tj\nET';
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
    const { text } = await scanContractFile({ uri: 'file:///tmp/c.pdf', mimeType: 'application/pdf', name: 'c.pdf', bytes: latin1(pdf) });
    expect(text).toContain('Contract No. 20240012345');
  });
});

describe('صورة كشف البنك: رسالة الإيقاف بلا انهيار', () => {
  test.each([['PNG', 'كشف.png', PNG], ['JPEG', 'scan.jpg', JPEG], ['صورة باسمٍ بلا امتداد معروف', 'statement', JPEG]])(
    '%s ترمي OCR_STOPPED بلا قارئٍ أصلي', async (_k, name, bytes) => {
      fileBytes = bytes;
      const p = statementSource({ uri: 'file:///tmp/x', name });
      await expect(p).rejects.toThrow(OCR_STOPPED);
      });

  test('شاشة الكشف تعرض رسالة الإيقاف بمفتاحها', () => {
    const src = read('app/bankStatement.tsx');
    expect(src).toMatch(/if \(isOcrStopped\(e\)\) toast\(t\('bankStatement\.err\.ocr'\)\)/);
    expect(src).not.toMatch(/e\.message === 'ocr'/);
  });

  test('ملف الكشف (CSV) يُقرأ عبر الخدمة كما كان', async () => {
    fileBytes = enc('Date,Description,Amount,Balance\n2026-10-01,In,100.00,100.00\n2026-10-02,Out,-40.00,60.00\n');
    const src = await statementSource({ uri: 'file:///tmp/s.csv', name: 's.csv' });
    expect(src.photo).toBe(false);
    const { result, hash } = src.read({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lines).toHaveLength(2);
    expect(hash).not.toBe('');
  });
});

describe('الرسائل باللغتين', () => {
  const ar = JSON.parse(read('src/i18n/locales/ar.json'));
  const en = JSON.parse(read('src/i18n/locales/en.json'));

  test('العربية: موقوفة الآن، وتطلب PDF (وExcel للكشف)', () => {
    expect(ar.bankStatement.err.ocr).toContain('قراءة النص من الصور موقوفة الآن');
    expect(ar.bankStatement.err.ocr).toMatch(/PDF/);
    expect(ar.bankStatement.err.ocr).toMatch(/Excel/);
    expect(ar.contractScan.ocrStopped).toContain('قراءة النص من الصور موقوفة الآن');
    expect(ar.contractScan.ocrStopped).toMatch(/PDF/);
    expect(ar.contractScan.pdfEmpty).toContain('موقوفة الآن');
    expect(ar.contractScan.pick).not.toContain('صورة');
  });

  test('الإنجليزية توأمها', () => {
    expect(en.bankStatement.err.ocr).toMatch(/stopped for now/);
    expect(en.bankStatement.err.ocr).toMatch(/PDF or Excel/);
    expect(en.contractScan.ocrStopped).toMatch(/stopped for now/);
    expect(en.contractScan.pdfEmpty).toMatch(/stopped for now/);
    expect(Object.keys(en.contractScan).sort()).toEqual(Object.keys(ar.contractScan).sort());
  });
});
