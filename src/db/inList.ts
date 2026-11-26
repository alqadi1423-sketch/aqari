/**
 * قوائم `IN (…)` بالتقطيع (التوجيه الرابع ٣ · ٢ · دراسة التوسع المرحلة ٠): حدّ المتغيرات في عبارة SQLite الواحدة 32,766
 * (expo-sqlite وnode:sqlite)، فقائمةٌ يكبر طولها بالبيانات (أقساطٌ مسّها الوارد، وعناصر السلة، والمحادثات) كانت تُسقط العبارة كلها بـ
 * `too many SQL variables` · وأول مزامنة لجهاز جديد تمسّ أكثر من 32,766 قسطاً من نحو 2,700 عقد سنوي.
 * فالعبارة تُنفَّذ قطعةً قطعة بـ IN_CHUNK معرّفاً، في المعاملة التي تنادي منها. والعبارة التي تُقطَّع أثرها على كل صفٍّ وحده
 * (لا تجميع عبر القائمة كلها)، فنتيجة القطع مجتمعةً نتيجة العبارة الواحدة · وترتيب النتائج بين القطع ليس ترتيب العبارة الواحدة،
 * فمن احتاج ترتيباً رتّب بعدها.
 * موضع القائمة في النص `:list` (داخل الأقواس: `IN (:list)`)، ومعاملات قبلها وبعدها إن لزم.
 */
import type { DB, SqlValue } from './adapter';

/** طول القطعة · أقل بكثير من الحد (32,766) ومن الحد القديم (999) لسعة المعاملات الأخرى في العبارة */
export const IN_CHUNK = 500;
const TOKEN = ':list';

/** القائمة قطعاً بطول size فأقل */
export function chunks<T>(xs: readonly T[], size = IN_CHUNK): T[][] {
  if (!(size > 0)) throw new Error('chunk size');
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

function expand(sql: string, n: number): string {
  const parts = sql.split(TOKEN);
  if (parts.length !== 2) throw new Error('inList: one :list per statement');
  return parts[0] + marks(n) + parts[1];
}

/** صفوف العبارة لكل القائمة · بلا تكرار في القائمة، وبلا ترتيبٍ عبر القطع */
export function allIn<T>(db: DB, sql: string, list: readonly SqlValue[], before: SqlValue[] = [], after: SqlValue[] = []): T[] {
  const out: T[] = [];
  for (const c of chunks([...new Set(list)])) out.push(...db.all<T>(expand(sql, c.length), [...before, ...c, ...after]));
  return out;
}

/** تنفيذ العبارة لكل القائمة · لا شيء لقائمةٍ فارغة */
export function runIn(db: DB, sql: string, list: readonly SqlValue[], before: SqlValue[] = [], after: SqlValue[] = []): void {
  for (const c of chunks([...new Set(list)])) db.run(expand(sql, c.length), [...before, ...c, ...after]);
}
