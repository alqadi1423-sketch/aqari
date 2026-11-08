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

/** عدد حركات القاعدة (اليوم والمبلغ) في أكبر كشفٍ حيٍّ من هذه الكشوف (بصماته shared_keys) */
export function statementsNeed(db: DB, statementIds: string[], key: string): number {
  const base = lineKeyBase(key);
  let n = 0;
  for (const id of new Set(statementIds.filter(Boolean))) {
    n = Math.max(n, Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bank_statements s, json_each(s.shared_keys) k WHERE s.id = ? AND s.deleted_at IS NULL AND k.value BETWEEN ? AND ?`,
      [id, base, base + '~'])?.n ?? 0));
  }
  return n;
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
 * سطور الملف الجديدة أمام المحفوظ حيّاً للبنك: ذو الرصيد مكرَّرٌ إن حُفظ برصيده، أو بقي للقاعدة سطرٌ بلا رصيدٍ لم يُطابَق · وما بلا رصيد
 * مكرَّرٌ ما دام رقم تكراره لا يتجاوز عدد المحفوظ بقاعدته
 */
export function freshLines(keys: string[], have: string[]): boolean[] {
  const byBase = new Map<string, { bal: Set<string>; noBal: number; all: number; claimed: number }>();
  for (const k of have) {
    const b = lineKeyBase(k);
    const e = byBase.get(b) ?? { bal: new Set<string>(), noBal: 0, all: 0, claimed: 0 };
    if (k.includes('#')) e.noBal++; else e.bal.add(k);
    e.all++;
    byBase.set(b, e);
  }
  return keys.map((k) => {
    const e = byBase.get(lineKeyBase(k));
    if (!e) return true;
    if (k.includes('@')) {
      if (e.bal.has(k)) return false;
      if (e.claimed < e.noBal) { e.claimed++; return false; }
      return true;
    }
    return Number(k.split('#')[1]) > e.all;
  });
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
