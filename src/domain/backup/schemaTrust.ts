/**
 * مخطط النسخة المستعادة (مراجعة التثبيت #48): المحفّزات والعروض لا تؤخذ من الملف · تُطابَق بمرجعٍ يُبنى من الهجرات نفسها،
 * فيُحذف ما ليس فيه أو يخالفه (محفّزٌ مزروع يحذف القيود مثلاً) ويُعاد ما نقص منه (حماية القيد المرحّل)
 */
import type { DB } from '../../db/adapter';

interface SchemaObject { type: string; name: string; sql: string }

const objects = (db: DB): Map<string, SchemaObject> => new Map(
  db.all<SchemaObject>(`SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') AND sql IS NOT NULL`)
    .map((o) => [o.name, o]));

/** النص بلا فروق الكتابة: المسافات وحالة الحروف و«IF NOT EXISTS» */
const norm = (sql: string) => sql.replace(/\s+/g, ' ').replace(/\bIF NOT EXISTS\b/gi, '').trim().toLowerCase();

const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"';

/** يجعل محفّزات probe وعروضه كمرجعها · يعيد ما حُذف وما أُنشئ */
export function enforceReferenceSchema(probe: DB, ref: DB): { dropped: string[]; created: string[] } {
  const want = objects(ref);
  const have = objects(probe);
  const dropped: string[] = [];
  const created: string[] = [];
  for (const [name, o] of have) {
    const w = want.get(name);
    if (!w || w.type !== o.type || norm(w.sql) !== norm(o.sql)) {
      probe.exec(`DROP ${o.type === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS ${quote(name)}`);
      dropped.push(name);
    }
  }
  for (const [name, w] of want) {
    if (!have.has(name) || dropped.includes(name)) {
      probe.exec(w.sql);
      created.push(name);
    }
  }
  return { dropped, created };
}
