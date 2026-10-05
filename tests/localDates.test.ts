/**
 * المراجعة ٤.٧ و٤.١٤ · التواريخ محلية لا UTC. التوقيت مثبَّت على الرياض (UTC+3) فيظهر الخلل على أي جهاز،
 * وعلى خادم بتوقيت UTC لا يظهر فلا يُكتشف. بيانات مصطنعة.
 */
process.env.TZ = 'Asia/Riyadh';

describe('التواريخ المحلية بتوقيت الرياض', () => {
  test('التوقيت مثبَّت فعلاً', () => {
    expect(new Date(2026, 9, 1).getTimezoneOffset()).toBe(-180);
  });

  test('dfmt لطابعٍ زمني يعرض اليوم المحلي لا يوم UTC', async () => {
    const { dfmt } = await import('@/domain/dates');
    // ١:٣٠ فجراً بالرياض = ٢٢:٣٠ من اليوم السابق بـ UTC
    expect(dfmt('2026-10-04T22:30:00.000Z')).toBe('05/10/2026');
    expect(dfmt('2026-10-05')).toBe('05/10/2026');
  });

  test('طابع سجل العمليات (UTC بلا علامة) يُعرض بالتاريخ والساعة المحليين', async () => {
    const { localDateOf, localTimeOf } = await import('@/domain/dates');
    expect(localDateOf('2026-10-04T22:30:00')).toBe('2026-10-05');
    expect(localTimeOf('2026-10-04T22:30:00')).toBe('01:30');
  });

  test('حدود «هذا الشهر» و«هذا الربع» محلية', async () => {
    const { periodBounds } = await import('@/domain/dates');
    const now = new Date(2026, 9, 15, 1, 0); // ١٥ أكتوبر ١ فجراً
    expect(periodBounds('month', now)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodBounds('quarter', now)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(periodBounds('year', now)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  test('لا يوم يُشتق من toISOString في الكود · المخزَّن لحظةً وحده يبقى UTC', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const root = path.join(__dirname, '..');
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const bad: string[] = [];
    for (const f of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'app'))]) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/toISOString\(\)\.(slice|substring|substr)\(0, ?10\)|getUTC(Date|Month|FullYear)\(|\.slice\(11, ?16\)/.test(line))
          bad.push(path.relative(root, f) + ':' + (i + 1));
      });
    }
    expect(bad).toEqual([]);
  });

  test('٤.٧ حقوق الملكية أول المدة تشمل قيد آخر يوم قبلها', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { postEntry } = await import('@/domain/accounting/post');
    const { financialStatementBlock } = await import('@/domain/finStatements');
    const db = memDb();
    postEntry(db, { date: '2025-12-31', memo: 'إضافة مالك تجريبية', lines: [{ account: '1100', debit: 500000, credit: 0 }, { account: '3100', debit: 0, credit: 500000 }] });
    const b = financialStatementBlock(db, 'equity', '2026-01-01', '2026-12-31');
    const open = b.sections[0].rows.find((r) => r[0] === 'حقوق الملكية أول المدة')!;
    expect(open[1]).toEqual({ money: 500000 });
  });
});
