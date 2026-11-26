/**
 * المراجعة الشاملة 2026-11-13 · E-17 · منخفض · رموز القوالب.
 * السيناريو أ: «قوالب الرسائل» بلا أي عقدٍ غير مسودة ← المعاينة تُبقي {المبلغ} و{الوحدة} و[المبلغ] حرفية، فالسياق بلا عقد ثلاثة رموز.
 * السيناريو ب: وصف {قيمة_العقد} «القيمة السنوية للعقد» وهو كامل قيمة الإيجار للمدة (قرار المالك 2026-10-07)، فقالبٌ يقول
 * «الإيجار السنوي {قيمة_العقد}» يُرسل لمستأجر عقد سنتين ضعف السنوي.
 * السيناريو ج: رسائل التحصيل ترشّح الجمهور بـ IN ('مستأجرون','عام')، و«عام» تصنيفٌ لا جمهور.
 * الصحيح: كل رمزٍ لا قيمة له في السياق يُفرغ (خانةٌ خالية لا «لا يوجد»)، ووصف الرمز «قيمة الإيجار لكامل المدة»، والجمهور «مستأجرون».
 * بيانات مصطنعة.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { TEMPLATE_TOKENS, resolveTemplateTokens, templateContext } from '@/domain/templates';

test('E-17 المعاينة بلا عقد: لا رمز يبقى حرفياً بأي صيغة', () => {
  const db = memDb();
  const body = TEMPLATE_TOKENS.map((x) => x.k + ' ' + x.k.replace('{', '[').replace('}', ']')).join(' | ');
  const out = resolveTemplateTokens(body, templateContext(db, null, 'مستأجر مصطنع'));
  for (const x of TEMPLATE_TOKENS) {
    expect(out).not.toContain(x.k);
    expect(out).not.toContain(x.k.replace('{', '[').replace('}', ']'));
  }
  expect(out).toContain('مستأجر مصطنع');
  db.close();
});

test('E-17 وصف {قيمة_العقد} لكامل المدة لا سنوي', () => {
  const d = TEMPLATE_TOKENS.find((x) => x.k === '{قيمة_العقد}')!.d;
  expect(d).not.toMatch(/سنوي/);
  expect(d).toBe('قيمة الإيجار لكامل المدة');
});

test('E-17 قوالب رسائل التحصيل لجمهور المستأجرين وحده', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', '(tabs)', 'collect.tsx'), 'utf8');
  expect(src).not.toMatch(/audience IN \('مستأجرون','عام'\)/);
  expect(src).toMatch(/audience = 'مستأجرون'/);
});
