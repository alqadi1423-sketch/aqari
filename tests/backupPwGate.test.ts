/**
 * المراجعات الخارجية «ثالثاً أ ٩» (قرار المالك 2026-10-09): نسخةٌ بلا تشفير بصمت إن تعذّرت قراءة كلمة المرور · ثبت أن قراءتها
 * تعيد null عند تعذّر المخزن الآمن فيُصدَّر ويُرفع بلا تشفير · فالعلامة توقفهما، ومعها الإيجابي: بلا كلمة يُصدَّر كما كان، وبكلمةٍ تُختم
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { passwordForSealing, passwordState, BackupPasswordLostError, type PasswordStore } from '@/domain/backup/passwordGate';

function mem(o: { pw?: string | null; broken?: boolean; flag?: boolean }): PasswordStore & { flag: boolean } {
  const s = {
    flag: !!o.flag,
    get: async () => { if (o.broken) throw new Error('keystore'); return o.pw ?? null; },
    flagged: () => s.flag,
    setFlag: (on: boolean) => { s.flag = on; },
  };
  return s;
}

test('سلبي: وُضعت كلمةٌ وتعذّرت قراءتها (المخزن تالف أو بلا مفتاح) · لا تصدير ولا رفع بلا تشفير', async () => {
  await expect(passwordForSealing(mem({ broken: true, flag: true }))).rejects.toBeInstanceOf(BackupPasswordLostError);
  await expect(passwordForSealing(mem({ pw: null, flag: true }))).rejects.toBeInstanceOf(BackupPasswordLostError);
  expect(await passwordState(mem({ broken: true, flag: true }))).toBe('lost');
});

test('إيجابي: بلا كلمة يُصدَّر كما كان · وبكلمةٍ تُختم · وكلمةٌ وُضعت قبل العلامة تُعلَّم', async () => {
  expect(await passwordForSealing(mem({}))).toBeNull();
  expect(await passwordForSealing(mem({ pw: 'كلمة-مصطنعة-1', flag: true }))).toBe('كلمة-مصطنعة-1');
  const old = mem({ pw: 'كلمة-مصطنعة-2' });
  expect(await passwordForSealing(old)).toBe('كلمة-مصطنعة-2');
  expect(old.flag).toBe(true);
});

test('التصدير والرفع إلى Drive يأخذان الكلمة من البوابة لا من القراءة الصامتة', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  for (const f of ['src/services/backupService.ts', 'src/services/cloud.ts']) {
    const s = read(f);
    expect(s).toMatch(/backupPasswordForSealing\(\)/);
    expect(s).not.toMatch(/getBackupPassword\(\)/);
  }
});
