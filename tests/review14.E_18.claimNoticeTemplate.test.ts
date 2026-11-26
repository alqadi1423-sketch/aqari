/**
 * المراجعة الشاملة 2026-11-13 · E-18 · منخفض · نص إشعار المطالبة ومهلة «سبعة أيام» مكتوبان في الكود.
 * القاعدة ١٢ · ٩: «صفر نص مرسَل في الكود: كل رسالة قالب من قاعدة البيانات» · وس٣١ («موافق»): يُنقلان إلى «قوالب الرسائل».
 * السيناريو: المالك يريد مهلة عشرة أيام أو صيغةً أخرى للإشعار ← لا يستطيع، فالنص ثابت في printDocs.ts.
 * الصحيح: قالبٌ بتصنيف «مطالبة» في «قوالب الرسائل» يُملأ برموز المبلغ والمبلغ بالحروف والسبب ورموز العقد، والمهلة جزءٌ من نصه ·
 * وبلا قالبٍ: النص الافتراضي من ملف الترجمة لا من الكود. بيانات مصطنعة.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { initI18n } from '@/i18n';
import { SCRIPT_CATEGORIES, TEMPLATE_TOKENS, claimNoticeBody } from '@/domain/templates';
import { buildClaimDoc } from '@/domain/printDocs';

beforeAll(() => { initI18n('ar'); });

test('E-18 «مطالبة» تصنيفٌ في القوالب، ورموزها معروضة', () => {
  expect(SCRIPT_CATEGORIES).toContain('مطالبة');
  const keys = TEMPLATE_TOKENS.map((x) => x.k);
  expect(keys).toEqual(expect.arrayContaining(['{المبلغ_بالحروف}', '{سبب_المطالبة}']));
});

test('E-18 بلا قالب: النص الافتراضي بمهلته، مملوءاً بالمطالبة', () => {
  const db = memDb();
  const body = claimNoticeBody(db, null, { amountHalalas: 150_000, reason: 'إصلاح مصطنع' });
  expect(body).toContain('1,500.00');
  expect(body).toContain('ألف وخمسمئة ريال');
  expect(body).toContain('إصلاح مصطنع');
  expect(body).toContain('سبعة أيام');
  expect(body).not.toMatch(/\{|\}/);
  db.close();
});

test('E-18 قالب المالك بتصنيف «مطالبة» يحلّ محل الافتراضي، ومهلته منه', () => {
  const db = memDb();
  db.run(`INSERT INTO message_scripts (id, audience, category, title, body, created_at) VALUES (?,?,?,?,?,?)`,
    ['ms-claim-test', 'مستأجرون', 'مطالبة', 'إشعار مطالبة', 'المبلغ {المبلغ} عن {سبب_المطالبة} خلال عشرة أيام', '2026-11-01T00:00:00Z']);
  const body = claimNoticeBody(db, null, { amountHalalas: 20_000, reason: 'تنظيف' });
  expect(body).toBe('المبلغ 200.00 عن تنظيف خلال عشرة أيام');
  db.close();
});

test('E-18 المستند يطبع النص الممرَّر، ولا نص إشعارٍ ثابت في الكود', () => {
  const doc = buildClaimDoc({ name: 'منشأة مصطنعة', vatno: '', cr: '', phone: '', address: '', vatEnabled: false },
    { contractNo: 'C-1', tenantName: 'مستأجر مصطنع', unitLabel: 'A-1', amountHalalas: 20_000, reason: 'تنظيف', date: '2026-11-01',
      body: 'نصٌّ مصطنع\nبسطرين' }, '01/11/2026 10:00');
  expect(doc).toContain('نصٌّ مصطنع<br>بسطرين');
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'domain', 'printDocs.ts'), 'utf8');
  expect(src).not.toMatch(/سبعة أيام/);
});
