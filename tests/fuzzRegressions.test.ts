/**
 * كل تسلسل عشوائي فشل يوماً يُعاد هنا ببذرته · فلا يرجع عيبٌ أُصلح.
 */
import * as fs from 'node:fs';
import { tempDir, rmrf } from './helpers/testDb';
import { runSequence, FAILURES_FILE } from './helpers/fuzz';

const saved: Array<{ seed: number; failure: string }> =
  fs.existsSync(FAILURES_FILE) ? JSON.parse(fs.readFileSync(FAILURES_FILE, 'utf8')) : [];

let dir: string;
beforeAll(() => { dir = tempDir('aqari-fuzzreg-'); });
afterAll(() => rmrf(dir));

if (!saved.length) test('لا تسلسلات محفوظة بعد', () => expect(saved).toEqual([]));

if (saved.length) {
  test.each(saved.map((s) => [s.seed, s.failure] as const))('البذرة %i (فشلت يوماً: %s)', async (seed) => {
    const res = await runSequence(dir, seed);
    expect(res.failure ?? null).toBeNull();
  });
}
