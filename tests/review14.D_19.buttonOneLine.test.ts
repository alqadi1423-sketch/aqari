/**
 * المراجعة الشاملة 2026-11-13 · D-19 · منخفض · نص الأزرار ينكسر لسطرين.
 * قرار المالك 2026-08-24: «numberOfLines={1} على نصّ كل زر · ولا كسر داخل الكلمة أبداً» و«الزر يتّسع لنصّه».
 * السيناريو: «+ إضافة طريقة سداد أخرى (دفع بأكثر من طريقة)» في نافذة السداد ينكسر لسطرين.
 * الصحيح: نص BtnPrimary وBtnGhost سطرٌ واحد، والعنوان الطويل يُختصر فلا يُقصّ («الحقل يشرح نفسه بتسميته»).
 */
import fs from 'fs';
import path from 'path';

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');

test('D-19 نص BtnPrimary وBtnGhost بسطرٍ واحد', () => {
  const src = read('src', 'ui', 'components.tsx');
  for (const b of ['BtnPrimary', 'BtnGhost']) {
    const start = src.indexOf(`export function ${b}(`);
    const body = src.slice(start, src.indexOf('</Pressable>', start));
    const texts = body.match(/<Text\b[^>]*>/g) ?? [];
    expect(texts.length).toBeGreaterThan(0);
    texts.forEach((t) => expect(t).toMatch(/numberOfLines=\{1\}/));
  }
});

test('D-19 لا عنوان زرٍّ يشرح نفسه بين قوسين', () => {
  for (const f of [['app', '(tabs)', 'collect.tsx'], ['app', 'purchases.tsx']]) {
    expect(read(...f)).not.toMatch(/title="\+ إضافة طريقة سداد أخرى \(دفع بأكثر من طريقة\)"/);
  }
});
