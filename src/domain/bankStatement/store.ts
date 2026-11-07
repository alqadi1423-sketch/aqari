/**
 * كشف البنك على الجهاز (التوجيه الرابع ٦ · ٢ · الهجرة ٥٥ · DESIGN §١٣.٢٢): حفظ الكشف المقروء بلا تكرار، وربط أعمدته لكل بنك، والمطابقة
 * المقترحة بدرجة ثقة واعتمادها بموافقة، والاستبعاد بسبب، وتقرير المطابقة لكل بنكٍ وشهر بالفروق · والكشف لا يمسّ رصيداً: المطابقة ربطٌ
 * بحركاتٍ قائمة، وغير المطابق فرقٌ يُسجَّل من نموذج التطبيق المعتاد (سجل القرارات ٥٦).
 */
import type { DB } from '../../db/adapter';
import { uid } from '../ids';
import { logAudit } from '../audit';
import { t } from '../../i18n';
import { RuleViolation } from '../contracts/service';
import { statementLineKeys, fnv64 } from './dedupe';
import { foldText } from './normalize';
import type { ColumnMapping, StatementResult } from './read';

type Ok = Extract<StatementResult, { ok: true }>;

export class StatementDuplicate extends RuleViolation {}

const audit = (db: DB, action: 'create' | 'update', name: string) =>
  logAudit(db, t('bankStatement.auditModule', { lng: 'ar' }), action, t('bankStatement.auditEntity', { lng: 'ar' }), name);

/** يحفظ الكشف وسطوره الجديدة · وما سبق حفظه لهذا البنك (كشفٌ متداخل) يُتخطّى · والملف نفسه أو كشفٌ بلا جديد يُرفض */
export function saveStatement(db: DB, bankId: string, r: Ok, file: { name: string; hash: string }): { statementId: string; added: number; skipped: number } {
  if (file.hash && db.get(`SELECT 1 FROM bank_statements WHERE bank_id = ? AND file_hash = ? AND deleted_at IS NULL`, [bankId, file.hash])) {
    throw new StatementDuplicate(t('bankStatement.duplicateFile'));
  }
  // وكشف حسابٍ آخر لا يُحفظ في هذا البنك: رقم الحساب في الكشف يخالف آيبانه (المدقق الخارجي U٢١)
  const iban = (db.get<{ i: string | null }>(`SELECT iban AS i FROM banks WHERE id = ?`, [bankId])?.i ?? '').replace(/\s+/g, '').toUpperCase();
  const acct = (r.account ?? '').replace(/\s+/g, '').toUpperCase();
  if (iban && acct) {
    const d1 = iban.replace(/\D/g, '');
    const d2 = acct.replace(/\D/g, '');
    const same = iban === acct || (d2.length >= 8 && d1.endsWith(d2)) || (d1.length >= 8 && d2.endsWith(d1));
    if (!same) throw new RuleViolation(t('bankStatement.otherAccount', { account: r.account ?? '' }));
  }
  const keys = statementLineKeys(bankId, r.lines);
  const have = new Set(db.all<{ k: string }>(`SELECT line_key AS k FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL`, [bankId]).map((x) => x.k));
  const fresh = r.lines.map((l, i) => ({ l, key: keys[i] })).filter((x) => !have.has(x.key));
  // وبصمات سطوره كلها معه (الهجرة ٥٨): حذف كشفٍ آخر فيه سطرٌ منها ينقله إلى هذا، على هذا الجهاز أو حين يصل إلى غيره
  if (!fresh.length) throw new StatementDuplicate(t('bankStatement.nothingNew'));
  // ومعرّفا الكشف والسطر حتميان من البنك وبصمة الملف وبصمة السطر (المدقق الخارجي Y٣): الملف نفسه يُقرأ على جهازين بلا اتصال فيلتقي
  // كشفاً واحداً وسطوراً واحدة، فاعتماد الإيداع نفسه عليهما بذرته واحدة (W١) · وصفٌّ محذوفٌ بالمعرّف نفسه يُحيى ولا يُكرَّر
  const id = file.hash ? 'st' + fnv64(bankId + '|' + file.hash) : uid();
  const lineId = (key: string) => 'sl' + fnv64(bankId + '|' + key);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.run(`DELETE FROM bank_statements WHERE id = ? AND deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bank_statement_lines WHERE statement_id = ?)`, [id, id]);
    if (db.get(`SELECT 1 FROM bank_statements WHERE id = ?`, [id])) {
      db.run(`UPDATE bank_statements SET deleted_at = NULL, period_from = ?, period_to = ?, opening_halalas = ?, closing_halalas = ?, file_name = ?, line_count = ?,
        mapping = ?, verified = ?, shared_keys = ?, created_at = ? WHERE id = ?`, [r.from ?? r.lines[0].date, r.to ?? r.lines[r.lines.length - 1].date, r.opening, r.closing,
        file.name, fresh.length, r.warnings.includes('photo') ? '' : JSON.stringify(r.mapping), r.warnings.includes('unverified') ? 0 : 1, JSON.stringify(keys), now, id]);
    } else {
    // وربط الصورة مصنوعٌ لا من الكشف فلا يُحفظ ربطاً للبنك · والكشف غير المتحقَّق بتأكيده (الهجرة ٥٧)
    db.run(`INSERT INTO bank_statements (id, bank_id, period_from, period_to, opening_halalas, closing_halalas, file_name, file_hash, line_count, mapping, verified, shared_keys, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, bankId, r.from ?? r.lines[0].date, r.to ?? r.lines[r.lines.length - 1].date, r.opening, r.closing,
      file.name, file.hash, fresh.length, r.warnings.includes('photo') ? '' : JSON.stringify(r.mapping), r.warnings.includes('unverified') ? 0 : 1,
      JSON.stringify(keys), now]);
    }
    for (const { l, key } of fresh) {
      const lid = lineId(key);
      if (db.get(`SELECT 1 FROM bank_statement_lines WHERE id = ?`, [lid])) {
        db.run(`UPDATE bank_statement_lines SET statement_id = ?, deleted_at = NULL, status = 'open', bank_tx_id = NULL, matched_at = NULL, note = '',
          date = ?, value_date = ?, descr = ?, ref = ?, amount_halalas = ?, balance_halalas = ? WHERE id = ?`,
          [id, l.date, l.valueDate, l.descr, l.ref, l.amount, l.balance, lid]);
      } else {
        db.run(`INSERT INTO bank_statement_lines (id, statement_id, bank_id, line_key, date, value_date, descr, ref, amount_halalas, balance_halalas, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [lid, id, bankId, key, l.date, l.valueDate, l.descr, l.ref, l.amount, l.balance, now]);
      }
    }
    audit(db, 'create', file.name || id);
  });
  return { statementId: id, added: fresh.length, skipped: r.lines.length - fresh.length };
}

/** ربط أعمدة آخر كشفٍ حيٍّ حُفظ لهذا البنك (الهجرة ٥٦: مع الكشف لا في صفّ البنك · S٥)، أو null */
export function statementMapping(db: DB, bankId: string): ColumnMapping | null {
  const raw = db.get<{ m: string }>(
    `SELECT mapping AS m FROM bank_statements WHERE bank_id = ? AND deleted_at IS NULL AND mapping != '' ORDER BY created_at DESC, rowid DESC LIMIT 1`, [bankId])?.m;
  if (!raw) return null;
  try { return JSON.parse(raw) as ColumnMapping; } catch { return null; }
}

export interface LineView { id: string; date: string; descr: string; amount: number }
export interface TxView { id: string; date: string; descr: string; amount: number; no: string }
export interface Suggestion { line: LineView; tx: TxView; score: number; level: 'ready' | 'review'; reasons: string[] }

const dayNo = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;
const DATE_SCORE: Array<[number, number]> = [[0, 30], [1, 26], [3, 20], [7, 12], [14, 5]];
// والسنة وحدها (19xx و20xx) ليست رقماً مشتركاً: في البيانات والتواريخ وأرقام الفواتير كلها (نظير المدقق الخارجي W٤)
const digitsOf = (s: string) => new Set((s.match(/\d{4,}/g) ?? []).filter((d) => !/^(19|20)\d\d$/.test(d)));
const wordsOf = (s: string) => new Set(foldText(s).split(' ').filter((w) => w.length >= 4 && !/^\d+$/.test(w)));

/**
 * اقتراحات المطابقة لسطور الكشف المفتوحة (الدراسة · «إشارات المطابقة»): المبلغ والاتجاه شرط (٥٠)، وقرب التاريخ (٣٠ في اليوم نفسه، إلى ٥
 * في أسبوعين وما بعدهما لا يُقترح)، ورقمٌ مشترك (رقم القيد أو المرجع · ١٥)، وكلمةٌ مشتركة (٣)، والمرشح الوحيد (+٥) أو المتعادل (−١٥) ·
 * «جاهزة للاعتماد» من ٨٥، و«تحتاج مراجعة» من ٥٠ · والحركة لا تُقترح لسطرين
 */
export function matchSuggestions(db: DB, bankId: string): Suggestion[] {
  const lines = db.all<{ id: string; date: string; descr: string; ref: string | null; amount: number }>(
    `SELECT id, date, descr, ref, amount_halalas AS amount FROM bank_statement_lines
     WHERE bank_id = ? AND status = 'open' AND deleted_at IS NULL ORDER BY date, rowid`, [bankId]);
  const txs = db.all<{ id: string; date: string; descr: string; amount: number; no: string; source: string }>(
    `SELECT t.id, t.date, t.descr, t.amount_halalas AS amount, t.journal_no AS no, t.source FROM bank_tx t
     WHERE t.bank_id = ? AND t.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM bank_statement_lines l WHERE l.bank_tx_id = t.id AND l.status = 'matched' AND l.deleted_at IS NULL)`, [bankId]);
  // فهرسٌ بالمبلغ مرتبٌ باليوم، ويوم كل سطرٍ وحركةٍ ورموزهما تُحسب مرةً واحدة (المدقق الخارجي V١٠: كان تربيعياً بالتاريخ في أعمق الحلقة)
  type X = (typeof txs)[number] & { day: number; digits: Set<string>; words: Set<string> };
  const byAmount = new Map<number, X[]>();
  for (const x of txs) {
    const v: X = { ...x, day: dayNo(String(x.date)), digits: digitsOf(String(x.descr) + ' ' + String(x.no) + ' ' + String(x.source)), words: wordsOf(String(x.descr) + ' ' + String(x.source)) };
    const k = Number(x.amount);
    const a = byAmount.get(k);
    if (a) a.push(v); else byAmount.set(k, [v]);
  }
  for (const list of byAmount.values()) list.sort((p, q) => p.day - q.day);
  const firstFrom = (list: X[], day: number) => { let lo = 0; let hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].day < day) lo = m + 1; else hi = m; } return lo; };
  // كل زوجٍ ممكن بدرجته، ثم التوزيع بالأعلى أولاً (المدقق الخارجي U٢٢: سطرٌ أخذ غيرُه أفضلَ مرشحيه يُقترح له التالي الحرّ، والحركة
  // التي يتنازعها سطران بدرجتين متقاربتين «تحتاج مراجعة» لا «جاهزة»)
  type Pair = { l: (typeof lines)[number]; x: X; score: number; gap: number; reasons: string[] };
  const pairs: Pair[] = [];
  for (const l of lines) {
    const list = byAmount.get(Number(l.amount));
    if (!list) continue;
    const ld = dayNo(l.date);
    const lDigits = digitsOf(l.descr + ' ' + (l.ref ?? ''));
    const lWords = wordsOf(l.descr);
    for (let i = firstFrom(list, ld - 14); i < list.length && list[i].day <= ld + 14; i++) {
      const x = list[i];
      const gap = Math.abs(x.day - ld);
      const reasons = ['amount', gap === 0 ? 'sameDay' : 'days'];
      let score = 50 + (DATE_SCORE.find(([d]) => gap <= d)?.[1] ?? 0);
      if ([...x.digits].some((d) => lDigits.has(d))) { score += 15; reasons.push('ref'); }
      if ([...x.words].some((w) => lWords.has(w))) { score += 3; reasons.push('words'); }
      pairs.push({ l, x, score, gap, reasons });
    }
  }
  const perLine = new Map<string, Pair[]>();
  const perTx = new Map<string, Pair[]>();
  for (const p of pairs) {
    const a = perLine.get(p.l.id); if (a) a.push(p); else perLine.set(p.l.id, [p]);
    const b = perTx.get(p.x.id); if (b) b.push(p); else perTx.set(p.x.id, [p]);
  }
  const desc = (p: Pair, q: Pair) => q.score - p.score || p.gap - q.gap;
  for (const g of perLine.values()) g.sort(desc);
  for (const g of perTx.values()) g.sort(desc);
  pairs.sort(desc);
  const usedL = new Set<string>();
  const usedX = new Set<string>();
  // ومتنازَعٌ عليه: سطرٌ آخر حرٌّ على الحركة نفسها، أو حركةٌ أخرى حرّةٌ للسطر نفسه، بدرجةٍ قريبة (القائمتان مرتبتان بالدرجة فيُقطع المرور)
  const rivalIn = (g: Pair[], p: Pair, free: (q: Pair) => boolean) => {
    for (const q of g) { if (q.score < p.score - 5) return false; if (q !== p && free(q)) return true; }
    return false;
  };
  const out: Suggestion[] = [];
  for (const p of pairs) {
    if (usedL.has(p.l.id) || usedX.has(p.x.id)) continue;
    usedL.add(p.l.id); usedX.add(p.x.id);
    let score = p.score;
    const reasons = [...p.reasons];
    const rival = rivalIn(perTx.get(p.x.id)!, p, (q) => !usedL.has(q.l.id)) || rivalIn(perLine.get(p.l.id)!, p, (q) => !usedX.has(q.x.id));
    if (rival) { score -= 15; reasons.push('ambiguous'); } else if (perLine.get(p.l.id)!.length === 1 && perTx.get(p.x.id)!.length === 1) { score += 5; reasons.push('unique'); }
    score = Math.min(100, score);
    if (score < 50) continue;
    out.push({
      line: { id: p.l.id, date: p.l.date, descr: p.l.descr, amount: Number(p.l.amount) },
      tx: { id: p.x.id, date: String(p.x.date), descr: String(p.x.descr), amount: Number(p.x.amount), no: String(p.x.no ?? '') },
      score, level: score >= 85 ? 'ready' : 'review', reasons,
    });
  }
  return out.sort((a2, b2) => (a2.line.date < b2.line.date ? -1 : a2.line.date > b2.line.date ? 1 : 0));
}

/** اعتماد المطابقة بموافقة المستخدم: سطرٌ مفتوح وحركةٌ حيّة من البنك نفسه بالمبلغ نفسه، غير مطابَقةٍ بسطرٍ آخر */
export function approveMatch(db: DB, lineId: string, txId: string): void {
  const l = db.get<{ bank_id: string; status: string; amount: number; descr: string }>(
    `SELECT bank_id, status, amount_halalas AS amount, descr FROM bank_statement_lines WHERE id = ? AND deleted_at IS NULL`, [lineId]);
  if (!l || l.status !== 'open') throw new RuleViolation(t('bankStatement.lineNotOpen'));
  const x = db.get<{ bank_id: string; amount: number }>(`SELECT bank_id, amount_halalas AS amount FROM bank_tx WHERE id = ? AND deleted_at IS NULL`, [txId]);
  if (!x || x.bank_id !== l.bank_id) throw new RuleViolation(t('bankStatement.txMissing'));
  if (Number(x.amount) !== Number(l.amount)) throw new RuleViolation(t('bankStatement.amountDiffers'));
  if (db.get(`SELECT 1 FROM bank_statement_lines WHERE bank_tx_id = ? AND status = 'matched' AND deleted_at IS NULL`, [txId])) {
    throw new RuleViolation(t('bankStatement.txTaken'));
  }
  db.transaction(() => {
    db.run(`UPDATE bank_statement_lines SET status = 'matched', bank_tx_id = ?, matched_at = ? WHERE id = ?`, [txId, new Date().toISOString(), lineId]);
    audit(db, 'update', l.descr);
  });
}

/** يعيد السطر مفتوحاً (من المطابقة أو الاستبعاد) */
export function unmatchLine(db: DB, lineId: string): void {
  db.transaction(() => {
    db.run(`UPDATE bank_statement_lines SET status = 'open', bank_tx_id = NULL, matched_at = NULL, note = '' WHERE id = ? AND deleted_at IS NULL`, [lineId]);
    audit(db, 'update', lineId);
  });
}

/** استبعاد سطرٍ بسببٍ مكتوب: يبقى ظاهراً في التقرير بسببه */
export function excludeLine(db: DB, lineId: string, note: string): void {
  const why = note.trim();
  if (!why) throw new RuleViolation(t('bankStatement.noteRequired'));
  const l = db.get<{ status: string }>(`SELECT status FROM bank_statement_lines WHERE id = ? AND deleted_at IS NULL`, [lineId]);
  if (!l || l.status !== 'open') throw new RuleViolation(t('bankStatement.lineNotOpen'));
  db.transaction(() => {
    db.run(`UPDATE bank_statement_lines SET status = 'excluded', note = ? WHERE id = ?`, [why, lineId]);
    audit(db, 'update', why);
  });
}

export interface Reconciliation {
  month: string;
  /** في الشهر كشفٌ محفوظ */
  covered: boolean;
  statementOpening: number | null;
  statementClosing: number | null;
  booksOpening: number;
  booksClosing: number;
  matched: number;
  onlyInStatement: LineView[];
  excluded: Array<LineView & { note: string }>;
  onlyInBooks: TxView[];
  /** في الطريق: حركةٌ في دفاتر هذا الشهر سطرُ كشفها في شهرٍ آخر، وسطرُ كشفٍ في هذا الشهر حركتُه في شهرٍ آخر (U١٤) */
  inTransitBooks: TxView[];
  inTransitStatement: LineView[];
  /** ما لا يفسّره فرق الافتتاحي ولا السطور غير المطابقة في الشهر (صفرٌ إن ثبت كل شيء) */
  unexplained: number | null;
  /** ختامي ما قبل كشفٍ يخالف افتتاحيه */
  gaps: Array<{ after: string; closing: number; nextOpening: number }>;
  /** في الشهر كشفٌ حُفظ «غير متحقَّق» بتأكيد المستخدم (الهجرة ٥٧) */
  unverified: boolean;
}

/** تقرير المطابقة لبنكٍ وشهر (YYYY-MM) بالفروق في الطرفين */
export function reconciliation(db: DB, bankId: string, month: string): Reconciliation {
  const start = month + '-01';
  const end = month + '-31';
  // خط زمن الكشوف: افتتاحي كل كشفٍ قبل سطور يومه، وكل سطرٍ برصيده المطبوع أو بما قبله
  type Ev = { date: string; open?: number; amount?: number; balance?: number | null };
  const events: Ev[] = ([] as Ev[]).concat(
    db.all<{ d: string; o: number }>(`SELECT period_from AS d, opening_halalas AS o FROM bank_statements WHERE bank_id = ? AND deleted_at IS NULL`, [bankId])
      .map((x): Ev => ({ date: x.d, open: Number(x.o) })),
    db.all<{ d: string; a: number; b: number | null }>(
      `SELECT date AS d, amount_halalas AS a, balance_halalas AS b FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY date, rowid`, [bankId])
      .map((l): Ev => ({ date: l.d, amount: Number(l.a), balance: l.b == null ? null : Number(l.b) })),
  ).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.open != null ? -1 : 0) - (y.open != null ? -1 : 0)));
  let running: number | null = null;
  let lastDate = '';
  let firstInMonth: Ev | null = null;
  let before: number | null = null;
  const gaps: Reconciliation['gaps'] = [];
  for (const e of events) {
    if (e.date > end) break;
    if (!firstInMonth && e.date >= start) { firstInMonth = e; before = running; }
    if (e.open != null) {
      if (e.date >= start && running !== null && running !== e.open) gaps.push({ after: lastDate, closing: running, nextOpening: e.open });
      running = e.open;
    } else {
      running = e.balance ?? (running ?? 0) + (e.amount ?? 0);
      lastDate = e.date;
    }
  }
  // وبلا حدثٍ في الشهر: الجاري عند بدايته (U١٦) · وكشفٌ يبدأ في الشهر بعد فجوة: افتتاحيه هو (U١٥ · والفجوة في gaps)
  if (!firstInMonth) before = running;
  const covered = !!db.get(`SELECT 1 FROM bank_statements WHERE bank_id = ? AND deleted_at IS NULL AND period_from <= ? AND period_to >= ?`, [bankId, end, start]);
  const unverified = !!db.get(`SELECT 1 FROM bank_statements WHERE bank_id = ? AND deleted_at IS NULL AND verified = 0 AND period_from <= ? AND period_to >= ?`, [bankId, end, start]);
  const statementOpening = covered ? (firstInMonth?.open != null ? firstInMonth.open : before) : null;
  const statementClosing = covered ? running : null;
  const bankOpening = Number(db.get<{ o: number }>(`SELECT opening_halalas AS o FROM banks WHERE id = ?`, [bankId])?.o ?? 0);
  const books = (cmp: string, d: string) => bankOpening + Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(amount_halalas), 0) AS s FROM bank_tx WHERE bank_id = ? AND deleted_at IS NULL AND date ${cmp} ?`, [bankId, d])?.s ?? 0);
  const booksOpening = books('<', start);
  const booksClosing = books('<=', end);
  const lineRows = db.all<{ id: string; date: string; descr: string; amount: number; status: string; note: string; txDate: string | null }>(
    `SELECT l.id, l.date, l.descr, l.amount_halalas AS amount, l.status, l.note,
       (SELECT t.date FROM bank_tx t WHERE t.id = l.bank_tx_id AND t.deleted_at IS NULL) AS txDate
     FROM bank_statement_lines l WHERE l.bank_id = ? AND l.deleted_at IS NULL AND l.date BETWEEN ? AND ? ORDER BY l.date, l.rowid`, [bankId, start, end]);
  const view = (r: { id: string; date: string; descr: string; amount: number }): LineView => ({ id: r.id, date: r.date, descr: r.descr, amount: Number(r.amount) });
  const inMonth = (d: string | null) => !!d && d >= start && d <= end;
  const onlyInStatement = lineRows.filter((r) => r.status === 'open').map(view);
  const excluded = lineRows.filter((r) => r.status === 'excluded').map((r) => ({ ...view(r), note: r.note }));
  const inTransitStatement = lineRows.filter((r) => r.status === 'matched' && !inMonth(r.txDate)).map(view);
  const txRows = db.all<{ id: string; date: string; descr: string; amount: number; no: string; lineDate: string | null }>(
    `SELECT t.id, t.date, t.descr, t.amount_halalas AS amount, t.journal_no AS no,
       (SELECT l.date FROM bank_statement_lines l WHERE l.bank_tx_id = t.id AND l.status = 'matched' AND l.deleted_at IS NULL LIMIT 1) AS lineDate
     FROM bank_tx t WHERE t.bank_id = ? AND t.deleted_at IS NULL AND t.date BETWEEN ? AND ? ORDER BY t.date, t.rowid`, [bankId, start, end]);
  const tv = (x: (typeof txRows)[number]): TxView => ({ id: x.id, date: x.date, descr: x.descr, amount: Number(x.amount), no: String(x.no ?? '') });
  const onlyInBooks = txRows.filter((x) => !x.lineDate).map(tv);
  const inTransitBooks = txRows.filter((x) => x.lineDate && !inMonth(x.lineDate)).map(tv);
  const sum = (xs: Array<{ amount: number }>) => xs.reduce((acc, x) => acc + x.amount, 0);
  const unexplained = statementOpening == null || statementClosing == null ? null
    : (statementClosing - booksClosing) - (statementOpening - booksOpening)
      - sum(onlyInStatement) - sum(excluded) - sum(inTransitStatement) + sum(onlyInBooks) + sum(inTransitBooks);
  return {
    month, covered, statementOpening, statementClosing, booksOpening, booksClosing,
    matched: lineRows.filter((r) => r.status === 'matched' && inMonth(r.txDate)).length,
    onlyInStatement, excluded, onlyInBooks, inTransitBooks, inTransitStatement, unexplained, gaps, unverified,
  };
}

/** كشفٌ حيٌّ آخر للبنك يحتاج سطراً ببصمته (تخطّاه عند حفظه لأنه في كشفٍ قبله · الهجرة ٥٨)، أو null */
export function statementSharing(db: DB, bankId: string, lineKey: string, exceptStatementId: string): string | null {
  return db.get<{ id: string }>(
    `SELECT s.id FROM bank_statements s, json_each(s.shared_keys) k
     WHERE s.bank_id = ? AND s.id != ? AND s.deleted_at IS NULL AND k.value = ? ORDER BY s.created_at, s.id LIMIT 1`,
    [bankId, exceptStatementId, lineKey])?.id ?? null;
}

/**
 * حذف كشفٍ وسطوره (حذفاً ناعماً) · وما فيه مطابَقٌ تُلغى مطابقته أولاً · وسطرٌ تخطّاه كشفٌ حيٌّ آخر عند حفظه لأنه هنا يُنقل إليه ولا
 * يُحذف، وما سواه يُحذف ولو وقع تاريخه في فترة ذلك الكشف (المدقق الخارجي U١٧ وV١: كشفٌ غير متحقَّق بسطرٍ مقروءٍ خطأً كان ينقل سطره الخاطئ
 * إلى الصحيح)
 */
export function deleteStatement(db: DB, statementId: string): void {
  if (db.get(`SELECT 1 FROM bank_statement_lines WHERE statement_id = ? AND status = 'matched' AND deleted_at IS NULL`, [statementId])) {
    throw new RuleViolation(t('bankStatement.deleteMatched'));
  }
  const st = db.get<{ bank_id: string }>(`SELECT bank_id FROM bank_statements WHERE id = ?`, [statementId]);
  const now = new Date().toISOString();
  db.transaction(() => {
    if (st) {
      for (const l of db.all<{ id: string; k: string }>(`SELECT id, line_key AS k FROM bank_statement_lines WHERE statement_id = ? AND deleted_at IS NULL`, [statementId])) {
        const to = statementSharing(db, st.bank_id, l.k, statementId);
        if (to) db.run(`UPDATE bank_statement_lines SET statement_id = ? WHERE id = ?`, [to, l.id]);
      }
    }
    db.run(`UPDATE bank_statement_lines SET deleted_at = ? WHERE statement_id = ? AND deleted_at IS NULL`, [now, statementId]);
    db.run(`UPDATE bank_statements SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, [now, statementId]);
    logAudit(db, t('bankStatement.auditModule', { lng: 'ar' }), 'delete', t('bankStatement.auditEntity', { lng: 'ar' }), statementId);
  });
}
