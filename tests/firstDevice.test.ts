/** «هذا جهازي الأول» · الحرف الفارغ ينتقل إلى هذا الجهاز وصاحبه السابق يأخذ حرفاً جديداً · معرّفات مصطنعة */
import { claimFirstLetter } from '@/domain/numbering';

test('الجهاز ذو الحرف B يرث الفراغ · والأول القديم يأخذ حرفاً غير مأخوذ', () => {
  const r = claimFirstLetter({ old: '', b: 'B', c: 'C' }, 'b');
  expect(r.letters.b).toBe('');
  expect(r.previous).toBe('old');
  expect(['', 'C']).not.toContain(r.letters.old);
  expect(new Set(Object.values(r.letters)).size).toBe(3);
});

test('جهاز جديد لم يُسجَّل بعد يأخذ الفراغ كذلك', () => {
  const r = claimFirstLetter({ old: '' }, 'new');
  expect(r.letters).toEqual({ old: 'B', new: '' });
});

test('هو الأول أصلاً: لا تغيير', () => {
  expect(claimFirstLetter({ me: '', b: 'B' }, 'me')).toEqual({ letters: { me: '', b: 'B' }, previous: null });
});
