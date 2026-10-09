/**
 * مراجعة التثبيت #44 (أهداف الأداء): لا تصفية بـ substr على التاريخ، فيُستعمل فهرسه · والحدود كما كانت · بيانات مصطنعة.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { postEntry } from '@/domain/accounting/post';
import { monthlyRevenue, monthlyRevenueExpense } from '@/domain/accounting/ledger';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('لا تصفية بـ substr على عمود التاريخ في الدفتر والرئيسية والتحصيل', () => {
  for (const f of ['src/domain/accounting/ledger.ts', 'app/(tabs)/index.tsx', 'app/(tabs)/collect.tsx']) {
    const where = read(f).split('WHERE').slice(1).map((w) => w.split(/GROUP BY|ORDER BY|`/)[0]);
    expect(where.filter((w) => /substr\(\s*\w+\.date/.test(w))).toEqual([]);
  }
});

test('حدود الشهر كما كانت: آخر يومٍ داخل وأول الشهر التالي خارج', () => {
  const db = memDb();
  const rent = (date: string, amount: number) => postEntry(db, { date, memo: 'إيراد مصطنع',
    lines: [{ account: '1100', debit: amount, credit: 0 }, { account: '4100', debit: 0, credit: amount }] });
  rent('2026-02-28', 100);
  rent('2026-03-01', 200);
  rent('2026-03-31', 300);
  rent('2026-04-01', 400);
  expect(Object.fromEntries(monthlyRevenue(db, '2026-03', '2026-03'))).toEqual({ '2026-03': 500 });
  expect(Object.fromEntries(monthlyRevenue(db, '2026-02', '2026-03'))).toEqual({ '2026-02': 100, '2026-03': 500 });
  expect(monthlyRevenueExpense(db, '2026-03', '2026-03').get('2026-03')?.revenue).toBe(500);
  db.close();
});
