/**
 * عناوين حوار الفشل المكتوبة في الكود (المدقق الخارجي N١٠): تُحفظ في src/domain/failureTitles.json فيبقى موضع تقرير العطل مقروءاً ومميِّزاً
 * حين يطابق أحدها حرفاً بحرف (ولا بيانات فيه) · وما سواها يمرّ بالحجب · والقائمة تُحدَّث بـ UPDATE_TITLES=1
 * وحارس: لا عنوان فشلٍ يُبنى من بيانات المستخدم (جمعٌ أو قالبٌ أو متغيّر) إلا ومعه موضعٌ ثابت (where)
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const files: string[] = [];
const walk = (d: string) => {
  for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name)) files.push(p);
  }
};
walk('app');
walk('src');

/** نداءات حوار الفشل: من «reportFailure({» أو «recordFailure({» إلى قوس الكائن المقابل */
function calls(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\b(?:reportFailure|recordFailure)\(\{/g)) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    out.push(src.slice(m.index!, i + 1));
  }
  return out;
}

/** مساعدٌ يمرّر عنوانه متغيّراً وكل نداءاته بنصٍّ ثابت يبدأ «تعذّر» (يجمعه المسح أدناه) */
const ALLOWED_HELPERS = new Set([path.join('app', '(tabs)', 'contracts.tsx')]);
const titles = new Set<string>();
const dynamic: string[] = [];
for (const f of files) {
  if (f.endsWith('failureDialog.ts')) continue;
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const c of calls(src)) {
    const lit = /\btitle:\s*'([^'\n\\]+)'\s*[,}\n]/.exec(c);
    if (lit) { titles.add(lit[1]); continue; }
    const tr = /\btitle:\s*t\('[^']+'(?:,\s*\{\s*lng:\s*'ar'\s*\})?\)\s*[,}\n]/.test(c);
    if (tr) continue;
    if (/\btitle\b/.test(c) && !/\bwhere\b/.test(c) && !ALLOWED_HELPERS.has(f)) dynamic.push(f + ': ' + c.slice(0, 120).replace(/\s+/g, ' '));
  }
  // وعناوين الفشل التي تمرّ بمساعدٍ بمتغيّر (showContractError وrun في AuthGate): كل نصٍّ في الكود يبدأ «تعذّر» عنوان فشلٍ بالعرف
  for (const m of src.matchAll(/'(تعذّر[^'\n\\]*)'/g)) titles.add(m[1]);
}

test('قائمة عناوين الفشل في الكود محدَّثة', () => {
  const file = path.join(ROOT, 'src/domain/failureTitles.json');
  const want = JSON.stringify([...titles].sort(), null, 1) + '\n';
  if (process.env.UPDATE_TITLES) fs.writeFileSync(file, want);
  expect(fs.readFileSync(file, 'utf8')).toBe(want);
});

test('لا عنوان فشلٍ من بيانات المستخدم بلا موضعٍ ثابت', () => {
  expect(dynamic).toEqual([]);
});
