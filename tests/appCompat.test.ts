/**
 * #36 · قرار المالك 2026-10-09: «حد أدنى لإصدار التطبيق، والإصدار الأقدم يطلب التحديث قبل الانضمام أو المزامنة».
 * الإصدار رقم المخطط: الصف المرفوع إلى المنشأة يحمل sv حين تكون قواعد الحد منشورة (يُقرأ meta/compat)، فلا يُرسل
 * مفتاحاً لا تعرفه قواعدٌ أقدم فتُرفض كل الكتابات.
 */
import { docToFields, decodeFields } from '@/cloud/firestore';
import { SCHEMA_VERSION } from '@/db/schema';
import { appTooOld } from '@/services/org';

const doc = { id: 'units__U1', t: 'units', k: 'U1', d: { id: 'U1' }, u: '2026-01-01T00:00:00Z', dev: 'D1', del: false };

test('الصف يحمل رقم الإصدار حين يُطلب وحده · وفي المنشأة وحدها', () => {
  expect(decodeFields(docToFields({ ...doc, g: ['units|P1'], pids: ['P1'] } as never, SCHEMA_VERSION)).sv).toBe(SCHEMA_VERSION);
  expect('sv' in decodeFields(docToFields({ ...doc, g: ['units|P1'], pids: ['P1'] } as never, null))).toBe(false);
  expect('sv' in decodeFields(docToFields(doc as never, SCHEMA_VERSION))).toBe(false);
});

test('الإصدار الأقدم من الحد يطلب التحديث', () => {
  expect(appTooOld(SCHEMA_VERSION + 1)).toBe(true);
  expect(appTooOld(SCHEMA_VERSION)).toBe(false);
  expect(appTooOld(0)).toBe(false);
});
