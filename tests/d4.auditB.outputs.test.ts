/**
 * اختبارات المدقق الخارجي أُبقيت حارساً بعد إصلاح ما أثبتته (التوجيه الرابع ٣ · الجولة الأولى) ·
 * مدقق خارجي B · d7b6f14 البند ٤ «خانة خالية بدل «لا يوجد» في التصدير والمطبوعات والرسائل» و35d35ab البند ١٨ «الرقم الضريبي فيما
 * يخرج للمسجّلة وحدها (shownVatNo): المسجّلة بلا رقمٍ خانةٌ خالية» · المسار الحقيقي للطباعة (src/services/print.ts) بمحاكاة expo-print
 * لالتقاط الـ HTML · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { letterhead } from '@/domain/printDocs';
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
import { printHandoverDoc, companyHeader, companyInfo } from '@/services/print';
// eslint-disable-next-line import/first
import { exportVatReturn } from '@/services/reportExport';

beforeEach(() => { mockOut.html = []; mockOut.files = []; });

test('محضر الاستلام لعقدٍ بلا رقم هوية للمستأجر: لا «لا يوجد» في المطبوع (جدول الساكنين)', async () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار محضر مصطنع' });
  const u = addUnit(db, p, { unit_no: 'H-1' });
  const c = confirmContract(db, contractInput(u, { idNumber: '' }));
  await printHandoverDoc(db, {
    type: 'استلام', tenantName: 'مستأجر اختبار', idNumber: '', phone: '0555555555', address: 'عقار محضر مصطنع',
    unitFloor: 'H-1', contractPeriod: '', date: '2026-01-01', tenantSign: '', companySign: '', sections: [], contractId: c,
  }, 'office');
  expect(mockOut.html.length).toBe(1);
  const stored = db.get<{ n: string }>(`SELECT national_id AS n FROM occupants WHERE contract_id = ?`, [c])?.n;
  // eslint-disable-next-line no-console
  console.log('occupants.national_id المخزَّن:', JSON.stringify(stored), '· في المطبوع:', /لا يوجد/.test(mockOut.html[0]));
  const hits = mockOut.html[0].match(/<td[^>]*>[^<]*لا يوجد[^<]*<\/td>/g) ?? [];
  expect(hits).toEqual([]);
});

test('منشأة مسجّلة بلا رقمٍ ضريبي: ترويسة التقارير وترويسة المستندات تتفقان (shownVatNo: «خانة خالية»)', () => {
  const db = memDb();
  db.run(`UPDATE company SET name = 'منشأة مصطنعة', vat_enabled = 1, vatno = '' WHERE id = 1`);
  const report = companyHeader(db);                       // رأس تقارير PDF (reportExport)
  const doc = letterhead(companyInfo(db), 'سند قبض');      // رأس السند والفاتورة والكشف والعقد
  // eslint-disable-next-line no-console
  console.log('report header has VAT line:', /الرقم الضريبي/.test(report), '· document letterhead has VAT line:', /الرقم الضريبي/.test(doc));
  expect(/الرقم الضريبي/.test(doc)).toBe(/الرقم الضريبي/.test(report));
});

test('ن١ (القاعدة ٩٩): إقرارٌ قُدِّم والمنشأة مسجّلة، يُصدَّر إكسلاً بعد إلغاء التسجيل: يحمل رقمها الضريبي', async () => {
  const db = memDb();
  db.run(`UPDATE company SET name = 'منشأة مصطنعة', vat_enabled = 1, vatno = '300000000000003' WHERE id = 1`);
  await exportVatReturn(db, 2026, 1, 'xlsx', true);
  db.run(`UPDATE company SET vat_enabled = 0 WHERE id = 1`);
  await exportVatReturn(db, 2026, 1, 'xlsx', true);
  const text = (b: Uint8Array) => Object.entries(unzipSync(b)).filter(([n]) => n.endsWith('.xml')).map(([, v]) => strFromU8(v)).join('\n');
  const [registered, after] = mockOut.files.map((f) => text(f.bytes));
  expect(registered).toMatch(/300000000000003/);
  // eslint-disable-next-line no-console
  console.log('VAT return xlsx after de-registration contains VAT no:', /300000000000003/.test(after));
  expect(/300000000000003/.test(after)).toBe(true);
});

test('B6 · ما خُزّن قبل الإصلاح للهوية الغائبة يُطبع خانةً خالية، والرقم الحقيقي كما هو', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { shownNationalId } = require('@/domain/occupants');
  expect(shownNationalId('لا يوجد')).toBe('');
  expect(shownNationalId(null)).toBe('');
  expect(shownNationalId('1000000001')).toBe('1000000001');
});
