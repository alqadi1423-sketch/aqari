/**
 * المدقق الخارجي D · الجولة الثانية · رقم المنشأة في الإقرار الضريبي (ن١ في 825f162: vatReturnVatNo).
 *  ١) الإقرار بصيغة Word (docx) لا يحمل رقم المنشأة الضريبي أصلاً، ولا اسمها، ولو كانت مسجّلة · وPDF وExcel يحملانه.
 *  ٢) vatReturnVatNo لا يفرّق بين منشأةٍ أُلغي تسجيلها ومنشأةٍ لم تُسجَّل قط: رقمٌ مكتوبٌ في «شهادة الرقم الضريبي» ومفتاح الضريبة
 *     لم يُفعَّل يوماً يُطبع في إقرارها، وسائر ما يخرج (shownVatNo) يحجبه.
 * المسار الحقيقي للتصدير (src/services/reportExport.ts) بمحاكاة expo-print وshareOfficeFile · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { unzipSync, strFromU8 } from 'fflate';

const mockOut = { html: [] as string[], files: [] as Array<{ name: string; bytes: Uint8Array }> };
jest.mock('expo-print', () => ({
  printToFileAsync: async ({ html }: { html: string }) => { mockOut.html.push(html); return { uri: 'file:///tmp/x.pdf' }; },
  printAsync: async () => undefined,
}), { virtual: true });
jest.mock('expo-sharing', () => ({ isAvailableAsync: async () => false, shareAsync: async () => undefined }), { virtual: true });
jest.mock('expo-file-system', () => {
  class F { uri: string; constructor(u: string) { this.uri = u; } get exists() { return false; } delete() {} moveSync() {} create() {} write() {} bytesSync() { return new Uint8Array(); } }
  return { File: F, Directory: F, Paths: { cache: { uri: 'file:///cache/' } } };
}, { virtual: true });
jest.mock('@/ui/AppDialog', () => ({ showDialog: () => undefined }));
jest.mock('@/ui/failureDialog', () => ({ reportFailure: () => undefined }));
jest.mock('@/services/appLockService', () => ({ whilePrompting: (f: () => unknown) => f() }));
jest.mock('@/files/store', () => ({ putAttachment: async () => undefined }));
jest.mock('@/services/filesEnv', () => ({ appFilesEnv: () => ({}) }));
jest.mock('@/services/officeFiles', () => ({
  shareOfficeFile: async (name: string, bytes: Uint8Array) => { mockOut.files.push({ name, bytes }); },
}));
// eslint-disable-next-line import/first
import { exportVatReturn } from '@/services/reportExport';
// eslint-disable-next-line import/first
import { letterhead } from '@/domain/printDocs';
// eslint-disable-next-line import/first
import { companyInfo } from '@/services/print';

const VAT = '300000000000003';
const xmlText = (b: Uint8Array) => Object.entries(unzipSync(b)).filter(([n]) => n.endsWith('.xml')).map(([, v]) => strFromU8(v)).join('\n');

beforeEach(() => { mockOut.html = []; mockOut.files = []; });

test('١ · الإقرار بصيغة Word لمنشأةٍ مسجّلة يحمل رقمها الضريبي كما يحمله PDF وExcel', async () => {
  const db = memDb();
  db.run(`UPDATE company SET name = 'منشأة مصطنعة', vat_enabled = 1, vatno = ? WHERE id = 1`, [VAT]);
  await exportVatReturn(db, 2026, 1, 'pdf', true);
  await exportVatReturn(db, 2026, 1, 'xlsx', true);
  await exportVatReturn(db, 2026, 1, 'docx', true);
  const pdf = mockOut.html.join('\n');
  const [xlsx, docx] = mockOut.files.map((f) => xmlText(f.bytes));
  // eslint-disable-next-line no-console
  console.log('رقم المنشأة في الإقرار · PDF:', pdf.includes(VAT), '· Excel:', xlsx.includes(VAT), '· Word:', docx.includes(VAT),
    '· اسم المنشأة في Word:', docx.includes('منشأة مصطنعة'));
  expect(pdf.includes(VAT)).toBe(true);
  expect(xlsx.includes(VAT)).toBe(true);
  expect(docx.includes(VAT)).toBe(true);
});

test('٢ · منشأةٌ لم تُفعّل الضريبة قط ورقمٌ مكتوبٌ في ملفها: الإقرار لا يقول عنها ما يحجبه سائر ما يخرج', async () => {
  const db = memDb();
  // مفتاح الضريبة لم يُفعَّل يوماً · ولا إقرار مقدَّم · والرقم مكتوبٌ في «شهادة الرقم الضريبي» (app/company.tsx يعرض الحقل دائماً)
  db.run(`UPDATE company SET name = 'منشأة غير مسجّلة مصطنعة', vat_enabled = 0, vatno = ? WHERE id = 1`, [VAT]);
  const receipt = letterhead(companyInfo(db), 'سند قبض');
  await exportVatReturn(db, 2026, 1, 'pdf', false);
  // eslint-disable-next-line no-console
  console.log('الرقم في ترويسة السند:', receipt.includes(VAT), '· في الإقرار:', mockOut.html[0].includes(VAT));
  expect(receipt.includes(VAT)).toBe(false);
  expect(mockOut.html[0].includes(VAT)).toBe(false);
});
