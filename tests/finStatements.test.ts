/**
 * القوائم المالية بالصيغ الثلاث: الكتلة النقية تحمل نفس أرقام الشاشة،
 * وملفا الإكسل والوورد يُبنيان منها فعلاً · وعيناتها تُكتب عند طلبها بمتغير بيئة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { memDb } from './helpers/testDb';
import { financialStatementBlock, FIN_TITLES } from '@/domain/finStatements';
import { buildXlsx, buildDocx } from '@/domain/officeBuild';
import { postEntry } from '@/domain/accounting/post';
import type { DB } from '@/db/adapter';

const seed = (db: DB) => {
  postEntry(db, {
    date: '2026-05-10', memo: 'إيجار محصّل', auto: false,
    lines: [
      { account: '1100', debit: 150000, credit: 0 },
      { account: '4200', debit: 0, credit: 150000 },
    ],
  });
  postEntry(db, {
    date: '2026-05-20', memo: 'صيانة', auto: false,
    lines: [
      { account: '5300', debit: 40000, credit: 0 },
      { account: '1100', debit: 0, credit: 40000 },
    ],
  });
};

describe('القوائم المالية الأربع بالصيغ الثلاث', () => {
  test('قائمة الدخل: الإجماليات صحيحة والكتلة تحمل البنود', () => {
    const db = memDb();
    seed(db);
    const b = financialStatementBlock(db, 'income', '2026-01-01', '2026-12-31');
    expect(b.heading).toBe('قائمة الدخل');
    const tot = Object.fromEntries(b.totals.map((t) => [t[0], t[1]]));
    expect(tot['إجمالي الإيرادات']).toEqual({ money: 150000 });
    expect(tot['إجمالي المصروفات']).toEqual({ money: 40000 });
    expect(tot['صافي الربح']).toEqual({ money: 110000 });
    db.close();
  });

  test('المركز المالي متوازن: أرباح الفترات حتى تاريخه سطرٌ في حقوق الملكية (مراجعة التثبيت #13)', () => {
    const db = memDb();
    seed(db);
    const b = financialStatementBlock(db, 'balance', null, '2026-12-31');
    const last = b.totals[b.totals.length - 1];
    expect(last[0]).toBe('الأصول = الخصوم + حقوق الملكية');
    expect(last[1]).toEqual({ money: 0 });
    db.close();
  });

  test('الصيغ الثلاث تُبنى فعلاً: إكسل ووورد ملفان صالحان بحجم حقيقي', () => {
    const db = memDb();
    seed(db);
    const tabs = ['income', 'balance', 'cash', 'equity'] as const;
    for (const t of tabs) {
      const block = financialStatementBlock(db, t, '2026-01-01', '2026-12-31');
      const xlsx = buildXlsx([{ name: FIN_TITLES[t].slice(0, 20), blocks: [block] }]);
      const docx = buildDocx(FIN_TITLES[t], 'من 2026-01-01 إلى 2026-12-31', [block], 'عقاري');
      expect(xlsx.length).toBeGreaterThan(1500);
      expect(docx.length).toBeGreaterThan(1500);
      // ملف zip صالح: يبدأ بتوقيع PK
      expect(xlsx[0]).toBe(0x50); expect(xlsx[1]).toBe(0x4b);
      expect(docx[0]).toBe(0x50); expect(docx[1]).toBe(0x4b);
      const dir = process.env.FIN_SAMPLES_DIR;
      if (dir) {
        fs.writeFileSync(path.join(dir, `قائمة-${t}.xlsx`), xlsx);
        fs.writeFileSync(path.join(dir, `قائمة-${t}.docx`), docx);
        const rowsHtml = block.sections.map((sec) =>
          `<h2>${sec.title}</h2><table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%">` +
          `<tr>${sec.header.map((h) => `<th>${h}</th>`).join('')}</tr>` +
          sec.rows.map((r) => `<tr>${r.map((c) => `<td>${typeof c === 'object' ? (c.money / 100).toFixed(2) : c}</td>`).join('')}</tr>`).join('') +
          '</table>').join('');
        const totHtml = '<h2>الإجماليات</h2>' + block.totals.map((tt) =>
          `<p><b>${tt[0]}</b>: ${typeof tt[1] === 'object' ? (tt[1].money / 100).toFixed(2) : tt[1]}</p>`).join('');
        fs.writeFileSync(path.join(dir, `قائمة-${t}.html`),
          `<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8"><body style="font-family:Tahoma;padding:30px">` +
          `<h1>${FIN_TITLES[t]}</h1>${rowsHtml}${totHtml}</body></html>`);
      }
    }
    db.close();
  });
});
