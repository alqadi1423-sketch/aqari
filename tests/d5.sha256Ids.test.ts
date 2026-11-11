/**
 * التوجيه الرابع · ٥ · م٠: المعرّفات الحتمية بـSHA-256 (سدّ الثغرة الثانية · docs/التقارير/دراسة-البنية-السحابية/و-سدّ-الثغرتين-2026-11-10.md)
 * الأرقام الذهبية من crypto في Node، ومتجهات FIPS 180-4.
 */
import { createHash } from 'node:crypto';
import { sha256Hex, deterministicId, withDeterministicIds, rowId } from '@/domain/ids';

const ref = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

test('متجهات المعيار: الفارغ و«abc» والرسالة ذات الكتلتين', () => {
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('يطابق crypto لنصوصٍ عربية ورموزٍ خارج المستوى الأساسي وأطوالٍ عند حدود الكتلة', () => {
  const samples = ['قيد مصطنع · عقد 12', 'stmt:sl1:i:a,b:1', '😀 مصطنع', ...[55, 56, 57, 63, 64, 65, 119, 120, 1000].map((n) => 'ب'.repeat(n) + 'x'.repeat(n % 7))];
  for (const s of samples) expect(sha256Hex(s)).toBe(ref(s));
});

test('المعرّف الحتمي: أول ١٢٨ بتاً ببادئة s، والبذرة نفسها تعطي المعرّفات نفسها بترتيبها', () => {
  expect(deterministicId('seed', 1)).toBe('s' + ref('seed#1').slice(0, 32));
  const run = () => withDeterministicIds('cancel:p1:2026-10-31', () => [rowId(), rowId(), rowId()]);
  expect(run()).toEqual(run());
  expect(new Set(run()).size).toBe(3);
  expect(run()[1]).toBe(deterministicId('cancel:p1:2026-10-31', 2));
});
