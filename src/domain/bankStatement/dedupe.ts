/**
 * بصمة سطر الكشف (التوجيه الرابع ٦ · ٢ · «منع التكرار»): البنك والتاريخ والمبلغ الموقَّع، ومعها رقم تكرارها في
 * الكشف نفسه (أسلوب ofxstatement) · فإعادة قراءة الكشف تعطي البصمات نفسها، والكشفان المتداخلان يتشاركانها في منطقة التداخل، وسطران
 * متطابقان حقاً (رسمان في اليوم نفسه) يبقيان اثنين · ومرجع البنك وحده لا يكفي (الحوالة ورسمها قد يشتركان فيه).
 */
import type { StatementLine } from './read';
import type { DB } from '../../db/adapter';

/** FNV-1a بـ64 بتاً (قطعتان من ٣٢) ستّ عشري · ثابتٌ بين الأجهزة */
export function fnv64(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c ^ (h1 >>> 7), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function statementLineKeys(bankId: string, lines: Array<Pick<StatementLine, 'date' | 'amount' | 'balance' | 'descr'>>): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    // بلا البيان: الحركة نفسها بتصديرٍ ببيانٍ أطول بصمتها نفسها (المدقق الخارجي U١٨) · والرصيد المطبوع يعرّفها بلا رقم تكرار، فحوالةٌ في
    // كشف الشهر وفي صورة صفحته بصمتها واحدة (Z١-٢ وA٢-٥) · وما بلا رصيد (MT940) برقم تكراره في ملفه
    const base = fnv64([bankId, l.date, l.amount].join('|'));
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (l.balance == null) return base + '#' + n;
    // (وسطران بالرصيد نفسه في الملف نفسه يُميَّزان بتكرارهما)
    const withBal = base + '@' + l.balance;
    const m = (seen.get(withBal) ?? 0) + 1;
    seen.set(withBal, m);
    return m === 1 ? withBal : withBal + '^' + m;
  });
}

/** بصمة السطر بلا رصيده ولا رقم تكراره (البنك واليوم والمبلغ) */
export const lineKeyBase = (key: string): string => key.split(/[@#]/)[0];
/**
 * قد يكونان السطر نفسه: البصمة نفسها، أو القاعدة نفسها وأحدهما وحده بلا رصيد (صورة الصفحة وكشف MT940) · وبصمتان بلا رصيد «#1» و«#2»
 * حركتان، وبرصيدين حركتان (المدقق الخارجي C٢-١: كانتا «السطر نفسه» فتُحذف حوالاتٌ حقيقية بالمزامنة)
 */
export function sameLineKey(a: string, b: string): boolean {
  return a === b || (lineKeyBase(a) === lineKeyBase(b) && a.includes('#') !== b.includes('#'));
}
/**
 * شرط SQL للبصمة نفسها بمعيار sameLineKey · بمدى البادئة فيستعمل فهرس (bank_id, line_key) (المدقق الخارجي A٢-٧: كان يمسح سطور البنك
 * كلها) · ومعاملاته sameKeyParams(key)
 */
export const SAME_KEY_SQL = (col: string) => `(${col} BETWEEN ? AND ? AND (${col} = ? OR (instr(${col}, '#') > 0) != (instr(?, '#') > 0)))`;
export const sameKeyParams = (key: string): string[] => [lineKeyBase(key), lineKeyBase(key) + '~', key, key];

/**
 * سطورٌ حيّة بترتيب أولويتها (الأَولى أولاً): ما يبقى منها (true) وما هو تكرار، بقاعدةٍ لا يغيّرها ترتيب الوصول فتُبقي الأجهزة كلها
 * السطور نفسها (المدقق الخارجي C٢-١) · في كل قاعدة (اليوم والمبلغ): البصمة نفسها مرةً، وكل بصمةٍ برصيدٍ حركة (عددها K)، و«#n» بلا رصيد
 * حركةٌ أخرى إن جاوز n عددَ ذوات الرصيد · وما سواها («#n» وn لا يجاوزه) قد يكون إحدى ذوات الرصيد، فيبقى منه ما يكمل عددَ حركات القاعدة
 * في أكبر كشفٍ حيٍّ يحملها (need · E٢-١: كشفٌ رصيده آخر اليوم وحده فيه «#1» و«@6000» حوالتان) بالأولوية
 */
export function keepInOrder(keys: string[], need: (base: string) => number = () => 0): boolean[] {
  const keep = keys.map(() => false);
  const firstOf = new Map<string, number>();
  keys.forEach((k, i) => { if (!firstOf.has(k)) firstOf.set(k, i); });
  const byBase = new Map<string, number[]>();
  for (const i of firstOf.values()) {
    const b = lineKeyBase(keys[i]);
    byBase.set(b, [...(byBase.get(b) ?? []), i]);
  }
  for (const [b, idx] of byBase) {
    const occ = (i: number) => Number(keys[i].split('#')[1]);
    const bal = idx.filter((i) => !keys[i].includes('#'));
    const k = bal.length;
    const hi = idx.filter((i) => keys[i].includes('#') && occ(i) > k);
    const low = idx.filter((i) => keys[i].includes('#') && occ(i) <= k).sort((x, y) => x - y);
    for (const i of [...bal, ...hi]) keep[i] = true;
    let room = Math.max(k + hi.length, need(b)) - k - hi.length;
    for (const i of low) { if (room <= 0) break; keep[i] = true; room--; }
  }
  return keep;
}

/**
 * عدد بصمات كل قاعدةٍ في كشف، محسوبٌ مرةً للكشف (المدقق الخارجي G٢-٦: كان json_each لكل سطرٍ وارد فيكبر بمربع الكشف) · يُبطله تغيّر
 * بصماته (resetStatementCounts)
 */
type Counts = Map<string, number> & { bal?: Map<string, Set<string>> };
const countCache = new WeakMap<DB, Map<string, Counts | null>>();
export function resetStatementCounts(db: DB, statementId?: string): void {
  const m = countCache.get(db);
  if (!m) return;
  if (statementId) m.delete(statementId); else m.clear();
}
export function statementCounts(db: DB, id: string): Counts | null {
  let m = countCache.get(db);
  if (!m) { m = new Map(); countCache.set(db, m); }
  if (m.has(id)) return m.get(id)!;
  const row = db.get<{ k: string; del: string | null }>(`SELECT shared_keys AS k, deleted_at AS del FROM bank_statements WHERE id = ?`, [id]);
  let out: Counts | null = null;
  if (row && row.del == null) {
    out = new Map() as Counts;
    const bal = new Map<string, Set<string>>();
    out.bal = bal;
    let keys: unknown = [];
    try { keys = JSON.parse(String(row.k ?? '[]')); } catch { keys = []; }
    for (const k0 of Array.isArray(keys) ? keys : []) {
      const k = String(k0);
      const b = lineKeyBase(k);
      out.set(b, (out.get(b) ?? 0) + 1);
      if (!k.includes('#')) { const set = bal.get(b) ?? new Set<string>(); set.add(k); bal.set(b, set); }
    }
  }
  m.set(id, out);
  return out;
}
/**
 * عدد حركات القاعدة (اليوم والمبلغ) في هذه الكشوف: أكبر عددٍ لها في كشفٍ واحد، أو عدد بصماتها برصيدٍ المختلفة فيها كلها (صفحتان
 * مصوّرتان بحوالتين مختلفتين وكشفٌ بلا رصيد بينهما · المدقق الخارجي I٢-٢ وI٢-٣) · والبصمات برصيدٍ معها
 */
export function statementsKnown(db: DB, statementIds: string[], key: string): { need: number; bal: Set<string> } {
  const base = lineKeyBase(key);
  let need = 0;
  const bal = new Set<string>();
  for (const id of new Set(statementIds.filter(Boolean))) {
    const c = statementCounts(db, id);
    need = Math.max(need, c?.get(base) ?? 0);
    for (const k of c?.bal?.get(base) ?? []) bal.add(k);
  }
  return { need: Math.max(need, bal.size), bal };
}
export function statementsNeed(db: DB, statementIds: string[], key: string): number {
  return statementsKnown(db, statementIds, key).need;
}

/**
 * كشفٌ حيٌّ آخر تخطّى عند حفظه سطراً بهذه البصمة وما زال ينقصه (عدد بصماته في القاعدة أكثر من سطوره الحيّة فيها)، أو null · فحذف كشفٍ
 * ينقل إليه ما تخطّاه وحده لا كل ما في قاعدته (المدقق الخارجي E٢-٣)
 */
export function statementWithRoom(db: DB, bankId: string, lineKey: string, exceptStatementId: string, exceptLineId = ''): string | null {
  const base = lineKeyBase(lineKey);
  const cands = db.all<{ id: string }>(
    `SELECT DISTINCT s.id, s.created_at FROM bank_statements s, json_each(s.shared_keys) k
     WHERE s.bank_id = ? AND s.id != ? AND s.deleted_at IS NULL AND ${SAME_KEY_SQL('k.value')} ORDER BY s.created_at, s.id`,
    [bankId, exceptStatementId, ...sameKeyParams(lineKey)]);
  for (const c of cands) {
    const has = Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bank_statement_lines WHERE statement_id = ? AND id != ? AND deleted_at IS NULL AND line_key BETWEEN ? AND ?`,
      [c.id, exceptLineId, base, base + '~'])?.n ?? 0);
    if (has < statementsNeed(db, [c.id], lineKey)) return c.id;
  }
  return null;
}

/**
 * سطور الملف الجديدة أمام المحفوظ حيّاً للبنك، في كل قاعدة (اليوم والمبلغ): البصمة نفسها مكرَّرة (كل محفوظٍ يقابل سطراً واحداً) · وعدد
 * الحركات بعد الحفظ أكبرُ: المحفوظ، وما في هذا الكشف، وذوات الرصيد المختلفة فيهما معاً · فيُضاف الفرق من آخر ما بقي في الملف (المدقق
 * الخارجي G٢-١: محفوظٌ واحدٌ بلا رصيد كان يقابل سطرين من كشفٍ رصيده آخر اليوم فتضيع حوالة)
 */
export function freshLines(keys: string[], have: string[], known: (base: string) => { need: number; bal: Set<string> } = () => ({ need: 0, bal: new Set() })): boolean[] {
  const fresh = keys.map(() => false);
  const haveBy = new Map<string, string[]>();
  for (const k of have) { const b = lineKeyBase(k); haveBy.set(b, [...(haveBy.get(b) ?? []), k]); }
  const newBy = new Map<string, number[]>();
  keys.forEach((k, i) => { const b = lineKeyBase(k); newBy.set(b, [...(newBy.get(b) ?? []), i]); });
  for (const [b, idx] of newBy) {
    const saved = haveBy.get(b) ?? [];
    const left = [...saved];
    const rest: number[] = [];
    for (const i of idx) {
      const j = left.indexOf(keys[i]);
      if (j >= 0) left.splice(j, 1); else rest.push(i);
    }
    const kn = known(b);
    const balanced = new Set([...saved, ...idx.map((i) => keys[i]), ...kn.bal].filter((k) => !k.includes('#'))).size;
    const add = Math.max(saved.length, idx.length, balanced, kn.need) - saved.length;
    for (const i of rest.slice(Math.max(0, rest.length - add))) fresh[i] = true;
  }
  return fresh;
}

/** بصمة بايتات الملف (منع قراءة الملف نفسه مرتين) */
export function bytesHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[i] ^ (h1 >>> 7), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') + '-' + bytes.length;
}
