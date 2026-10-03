/**
 * الثوابت تحت آلاف التسلسلات العشوائية · العدد من FUZZ_SEQS (الافتراضي ٢٠٠ في كل تشغيل فلا يزاحم اختبارات الزمن، وفي جولة الإقفال ٥٠٠٠: FUZZ_SEQS=5000)
 * والبذرة الأولى من FUZZ_FROM. أي تسلسل يفشل يُحفظ بذرته في tests/fuzz-failures.json فيصير
 * اختباراً دائماً يعاد في كل تشغيل.
 */
import { tempDir, rmrf } from './helpers/testDb';
import { runSequence, saveFailure, type FuzzResult } from './helpers/fuzz';

const N = Number(process.env.FUZZ_SEQS ?? 200);
const FROM = Number(process.env.FUZZ_FROM ?? 1);

let dir: string;
beforeAll(() => { dir = tempDir('aqari-fuzz-'); });
afterAll(() => rmrf(dir));

test(`${N} تسلسلاً عشوائياً · الثوابت تصمد بعد كل عملية والجهازان يتطابقان`, async () => {
  const failed: FuzzResult[] = [];
  let ops = 0;
  for (let s = FROM; s < FROM + N; s++) {
    const res = await runSequence(dir, s);
    ops += res.log.length;
    if (!res.ok) { failed.push(res); saveFailure(res); }
  }
  // عدد العمليات المنفّذة فعلاً · ليُرى أن التسلسلات لم تكن فارغة
  console.log(`fuzz: ${N} تسلسل · ${ops} عملية · ${failed.length} فشل`);
  expect(failed.map((f) => `بذرة ${f.seed}: ${f.failure}\n  ${f.log.join('\n  ')}`)).toEqual([]);
}, 3_600_000);
