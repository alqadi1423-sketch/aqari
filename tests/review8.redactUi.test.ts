/**
 * المراجعة الشاملة (الالتزام ac76adc) · البندان ١٧ و١٨: حاجز الأخطاء كان يكتب نص الخطأ خاماً في سجل العمليات المزامَن، وزر «مشاركة
 * السبب» في بوابة الترقية يشارك نصاً غير منقّح · الواجهة لا تُحمَّل على Node فيُفحص موضع الاستدعاء كما في review7Low · بيانات مصطنعة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { failureAuditDetail, redactForReport } from '@/domain/redact';

const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

test('١٧ حاجز الأخطاء يكتب في السجل نص الخطأ محجوباً لا خاماً', () => {
  const eb = src('src/ui/ErrorBoundary.tsx');
  const did = eb.slice(eb.indexOf('componentDidCatch'), eb.indexOf('render()'));
  expect(did).not.toMatch(/error\.message/);
  expect(did).toMatch(/failureAuditDetail\(error\)/);
  const d = failureAuditDetail(new Error('تعذّر عرض عقد المستأجر سالم المصطنع بمبلغ ٤٥٠٠'));
  for (const bit of ['سالم', '٤٥٠٠']) expect(d).not.toContain(bit);
});

test('١٧ ونظيره: رفض الوارد في سجل العمليات المزامَن بسببٍ محجوب · وسببه كاملاً في سجل المرفوض على الجهاز', async () => {
  const { memDb } = await import('./helpers/testDb');
  const { enableSync, stageInbox, applyInbox, docId } = await import('@/sync/engine');
  const db = memDb();
  enableSync(db, 'user-1');
  // مفتاحٌ داخل المستند لا يطابق مفتاحه فيُرفض · وسببٌ مصطنع باسمٍ ومبلغ يُكتب كما هو في المرفوض
  stageInbox(db, [{ id: docId('tenants', 'T17'), t: 'tenants', k: 'T17', u: '2026-01-01T00:00:00.000Z', dev: 'other', del: false,
    d: { id: 'غيره', name: 'مستأجر مصطنع', created_at: '2026-01-01T00:00:00.000Z' } }]);
  applyInbox(db, 'this-device');
  const audit = db.get<{ n: string }>(`SELECT entity_name AS n FROM audit_log WHERE entity_type = 'رفض وارد' ORDER BY rowid DESC LIMIT 1`)!.n;
  expect(audit).toMatch(/^tenants · T17 · /);
  expect(audit).not.toMatch(/مفتاح الصف/);
  expect(db.get<{ r: string }>(`SELECT reason AS r FROM sync_rejects WHERE pk = 'T17'`)!.r).toMatch(/مفتاح الصف/);
  db.close();
});
