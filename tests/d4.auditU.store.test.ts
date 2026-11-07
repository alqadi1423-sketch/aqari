/**
 * المدقق الخارجي U · الجولة العاشرة · كشف البنك (التوجيه الرابع ٦ · ٢): الحفظ ومنع التكرار، والمطابقة، وتقرير المطابقة لكل بنكٍ وشهر،
 * والسلة بعد الهجرة ٥٥ (src/domain/bankStatement/store.ts وsrc/domain/trash.ts) · كل اختبارٍ يسقط على 7e3b492 ويصف السلوك الصحيح ·
 * بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditU.store.test.ts
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { depositCashToBank, ownerCashIn, recordManualBankTx } from '@/domain/cashOps';
import { deleteBankTx } from '@/domain/bankTx';
import { purgeFromTrash, purgeExpiredTrash } from '@/domain/trash';
import { readStatementGrid, readStatementFile } from '@/domain/bankStatement/read';
import {
  saveStatement, matchSuggestions, approveMatch, reconciliation, deleteStatement, StatementDuplicate,
} from '@/domain/bankStatement/store';
import type { DB } from '@/db/adapter';

const HEAD = ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'];
/** كشفٌ بفترةٍ مطبوعة وافتتاحي (بالريال) وسطور */
function stmt(from: string, to: string, opening: string, rows: string[][]) {
  const r = readStatementGrid([[`الفترة من ${from} إلى ${to}`], ['الرصيد الافتتاحي', opening], HEAD, ...rows]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error + ' ' + (r.detail ?? ''));
  return r;
}
const txOf = (db: DB, bank: string, date: string) => db.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ? AND date = ? AND deleted_at IS NULL`, [bank, date])!.id;
const lineOf = (db: DB, bank: string, date: string) => db.get<{ id: string }>(`SELECT id FROM bank_statement_lines WHERE bank_id = ? AND date = ? AND deleted_at IS NULL`, [bank, date])!.id;
const approveAll = (db: DB, bank: string) => { for (const s of matchSuggestions(db, bank)) approveMatch(db, s.line.id, s.tx.id); };

function books() {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع للمدقق U', 0);
  ownerCashIn(db, { amountHalalas: 5000000, date: '2026-07-01' });
  return { db, bank };
}

describe('U١٤ · المطابَق بين شهرين (إيداعٌ في الدفاتر 30 أكتوبر يصل البنك 2 نوفمبر) يصير «فرقاً غير مفسَّر» في الشهرين ولا يُسرد', () => {
  test('أكتوبر ونوفمبر: الفرق صفرٌ مفسَّر بالبند المعلّق، والحركة ظاهرة في تقرير أكتوبر', () => {
    const { db, bank } = books();
    depositCashToBank(db, { bankId: bank, amountHalalas: 100000, date: '2026-10-02', notes: 'إيداع نقدي مصطنع أول' });
    depositCashToBank(db, { bankId: bank, amountHalalas: 500000, date: '2026-10-30', notes: 'إيداع نقدي مصطنع ثان' });
    saveStatement(db, bank, stmt('01/10/2026', '31/10/2026', '0.00', [['2026/10/02', 'إيداع نقدي مصطنع أول', '', '1,000.00', '1,000.00']]), { name: 'oct.csv', hash: 'u14-oct' });
    saveStatement(db, bank, stmt('01/11/2026', '30/11/2026', '1,000.00', [['2026/11/02', 'إيداع نقدي مصطنع ثان', '', '5,000.00', '6,000.00']]), { name: 'nov.csv', hash: 'u14-nov' });
    approveAll(db, bank);
    const late = txOf(db, bank, '2026-10-30');
    // المطابقة اعتُمدت بموافقة: الإيداع المتأخر مطابَقٌ بسطر نوفمبر
    expect(db.get(`SELECT 1 FROM bank_statement_lines WHERE bank_tx_id = ? AND status = 'matched'`, [late])).toBeTruthy();
    const oct = reconciliation(db, bank, '2026-10');
    const nov = reconciliation(db, bank, '2026-11');
    // الصحيح: في أكتوبر إيداعٌ في الطريق (في الدفاتر، يظهر في كشف الشهر التالي) يُسرد ويفسّر الفرق، وفي نوفمبر لا فرق
    expect(JSON.stringify(oct)).toContain(late);
    expect([oct.unexplained, nov.unexplained]).toEqual([0, 0]);
  });
});

describe('U١٥ · فجوةٌ قبل الشهر (لا كشف لسبتمبر) تجعل افتتاحي كشف أكتوبر ختاميَّ أغسطس، وفرقاً غير مفسَّر في أكتوبر', () => {
  test('كشف أكتوبر افتتاحيه 1,500 والدفاتر توافقه في أكتوبر كله', () => {
    const { db, bank } = books();
    depositCashToBank(db, { bankId: bank, amountHalalas: 100000, date: '2026-08-05', notes: 'إيداع أغسطس مصطنع' });
    depositCashToBank(db, { bankId: bank, amountHalalas: 50000, date: '2026-09-10', notes: 'إيداع سبتمبر مصطنع' });
    depositCashToBank(db, { bankId: bank, amountHalalas: 10000, date: '2026-10-10', notes: 'إيداع أكتوبر مصطنع' });
    saveStatement(db, bank, stmt('01/08/2026', '31/08/2026', '0.00', [['2026/08/05', 'إيداع أغسطس مصطنع', '', '1,000.00', '1,000.00']]), { name: 'aug.csv', hash: 'u15-aug' });
    saveStatement(db, bank, stmt('01/10/2026', '31/10/2026', '1,500.00', [['2026/10/10', 'إيداع أكتوبر مصطنع', '', '100.00', '1,600.00']]), { name: 'oct.csv', hash: 'u15-oct' });
    approveAll(db, bank);
    const oct = reconciliation(db, bank, '2026-10');
    // الفجوة تُذكر (بين أغسطس وأكتوبر)، لكن افتتاحي كشف أكتوبر هو المطبوع فيه، ولا فرق في أكتوبر نفسه
    expect(oct.gaps).toHaveLength(1);
    expect({ opening: oct.statementOpening, unexplained: oct.unexplained }).toEqual({ opening: 150000, unexplained: 0 });
  });
});

describe('U١٦ · شهرٌ يغطيه كشفٌ بلا سطورٍ فيه: افتتاحي الكشف null (تعرضه الشاشة صفراً) ولا يُحسب الفرق', () => {
  test('كشف أكتوبر ونوفمبر معاً، والحركات في أكتوبر وحده', () => {
    const { db, bank } = books();
    depositCashToBank(db, { bankId: bank, amountHalalas: 100000, date: '2026-10-02', notes: 'إيداع مصطنع' });
    saveStatement(db, bank, stmt('01/10/2026', '30/11/2026', '0.00', [['2026/10/02', 'إيداع مصطنع', '', '1,000.00', '1,000.00']]), { name: 'oct-nov.csv', hash: 'u16' });
    approveAll(db, bank);
    const nov = reconciliation(db, bank, '2026-11');
    expect(nov.covered).toBe(true);
    expect({ opening: nov.statementOpening, closing: nov.statementClosing, unexplained: nov.unexplained }).toEqual({ opening: 100000, closing: 100000, unexplained: 0 });
  });
});

describe('U١٧ · حذف كشفٍ متداخل يُسقط سطور الكشف الآخر التي تُخطّيت عند حفظه، ولا يُعاد حفظ الآخر', () => {
  test('A (1–20 أكتوبر) ثم B (15–31): حذف A يمحو سطر 15 أكتوبر من B، وإعادة B تُرفض «قُرئ من قبل»', () => {
    const { db, bank } = books();
    const B = stmt('15/10/2026', '31/10/2026', '1,000.00', [
      ['2026/10/15', 'رسوم مصطنعة', '100.00', '', '900.00'],
      ['2026/10/25', 'حوالة مصطنعة', '', '50.00', '950.00'],
    ]);
    const A = saveStatement(db, bank, stmt('01/10/2026', '20/10/2026', '0.00', [
      ['2026/10/02', 'إيداع مصطنع', '', '1,000.00', '1,000.00'],
      ['2026/10/15', 'رسوم مصطنعة', '100.00', '', '900.00'],
    ]), { name: 'a.pdf', hash: 'u17-a' });
    expect(saveStatement(db, bank, B, { name: 'b.pdf', hash: 'u17-b' })).toMatchObject({ added: 1, skipped: 1 });
    deleteStatement(db, A.statementId);
    // الصحيح: سطور B كلها باقية (سطر 15 أكتوبر في B أيضاً)
    const live = db.all<{ date: string }>(`SELECT date FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY date`, [bank]).map((r) => r.date);
    expect(live).toEqual(['2026-10-15', '2026-10-25']);
  });
});

describe('U١٨ · منع التكرار لا يعرف الحركة نفسها من صيغةٍ أخرى: كشف PDF/CSV بأرصدة ثم MT940 للفترة نفسها يضاعف السطور والتقرير', () => {
  test('الحركتان تُحفظان مرتين، وختامي الكشف في التقرير 970 بدل 985، ولا تنبيه تداخل', () => {
    const { db, bank } = books();
    saveStatement(db, bank, stmt('01/10/2026', '31/10/2026', '0.00', [
      ['2026/10/02', 'حوالة واردة مصطنعة', '', '1,000.00', '1,000.00'],
      ['2026/10/05', 'رسوم مصطنعة', '15.00', '', '985.00'],
    ]), { name: 'oct.pdf', hash: 'u18-pdf' });
    const sta = [':20:SYNU18', ':25:SA0000000000000000000018', ':60F:C261001SAR0,00',
      ':61:2610021002C1000,00NTRF//R1', ':86:حوالة واردة مصطنعة',
      ':61:2610051005D15,00NCHG//R2', ':86:رسوم مصطنعة', ':62F:C261031SAR985,00'].join('\n');
    const m = readStatementFile({ name: 'oct.sta', bytes: new TextEncoder().encode(sta) });
    if (!m.ok) throw new Error(m.error);
    let added = 0;
    try { added = saveStatement(db, bank, m, { name: 'oct.sta', hash: 'u18-sta' }).added; } catch (e) { if (!(e instanceof StatementDuplicate)) throw e; }
    // الصحيح: الحركتان محفوظتان من قبل لهذا البنك (التاريخ والمبلغ والبيان، والفترة متداخلة) فلا يُضاف شيء
    expect(added).toBe(0);
    expect(reconciliation(db, bank, '2026-10').statementClosing).toBe(98500);
  });

  test('والصيغة نفسها ببيانٍ أطول قليلاً (تصديرٌ آخر للفترة نفسها): التاريخ والمبلغ والرصيد نفسها، والسطور تُضاف ثانيةً', () => {
    const { db, bank } = books();
    const rows = (suffix: string) => stmt('01/10/2026', '31/10/2026', '0.00', [
      ['2026/10/02', 'حوالة واردة مصطنعة' + suffix, '', '1,000.00', '1,000.00'],
      ['2026/10/05', 'رسوم مصطنعة' + suffix, '15.00', '', '985.00'],
    ]);
    saveStatement(db, bank, rows(''), { name: 'oct-web.pdf', hash: 'u18-web' });
    let added = 0;
    try { added = saveStatement(db, bank, rows(' SARIE 0001'), { name: 'oct-app.pdf', hash: 'u18-app' }).added; } catch (e) { if (!(e instanceof StatementDuplicate)) throw e; }
    // سطرٌ برصيده المطبوع بعد حركته يعرّفه التاريخ والمبلغ والرصيد في البنك نفسه · فلا جديد
    expect(added).toBe(0);
  });
});

describe('U١٩ · حذف حركةٍ مطابَقة يُبقي السطر «مطابَقاً» بحركةٍ محذوفة، والحذف النهائي من السلة يسقط بقيد المفتاح الأجنبي', () => {
  test('إيداعٌ مطابَق ثم حذفه ثم كنسه من السلة', () => {
    const { db, bank } = books();
    depositCashToBank(db, { bankId: bank, amountHalalas: 100000, date: '2026-10-02', notes: 'إيداع مصطنع' });
    saveStatement(db, bank, stmt('01/10/2026', '31/10/2026', '0.00', [['2026/10/02', 'إيداع مصطنع', '', '1,000.00', '1,000.00']]), { name: 'oct.csv', hash: 'u19' });
    approveAll(db, bank);
    const tx = txOf(db, bank, '2026-10-02');
    let refused = false;
    try { deleteBankTx(db, tx); } catch { refused = true; }
    if (!refused) {
      // الصحيح: إما أن يُرفض حذف الحركة المطابَقة، أو يعود السطر مفتوحاً · لا سطر «مطابَق» بحركةٍ في السلة
      const line = db.get<{ status: string }>(`SELECT status FROM bank_statement_lines WHERE id = ?`, [lineOf(db, bank, '2026-10-02')])!;
      expect(line.status).toBe('open');
      expect(() => purgeFromTrash(db, 'bank_tx', tx)).not.toThrow();
    }
  });
});

describe('U٢٠ · بنكٌ له كشفٌ محفوظ وبلا حركات يُحذف إلى السلة، ثم لا يُكنس، ويوقف الكنس الدوري كله بصمت', () => {
  test('purgeFromTrash يسقط بقيد المفتاح الأجنبي، وpurgeExpiredTrash لا يكنس بنكاً آخر منتهياً', async () => {
    const { db, bank } = books();
    const other = addBank(db, 'بنك مصطنع آخر في السلة', 0);
    saveStatement(db, bank, stmt('01/10/2026', '31/10/2026', '0.00', [['2026/10/02', 'إيداع مصطنع', '', '1,000.00', '1,000.00']]), { name: 'oct.csv', hash: 'u20' });
    // شاشة البنوك تعرض «حذف» لبنكٍ بلا حركة بنك ولا سطر دفع (LINKED_SQL في app/banks.tsx) · فيُحذف كما تحذفه
    const longAgo = new Date(Date.now() - 400 * 86400000).toISOString();
    db.run(`UPDATE banks SET deleted_at = ? WHERE id IN (?, ?)`, [longAgo, bank, other]);
    await expect(purgeExpiredTrash(db)).resolves.toBeGreaterThan(0);
    // الصحيح: البنك الآخر يُكنس على الأقل، والبنك ذو الكشف يُكنس بكشوفه أو يبقى في السلة بسببه دون أن يُسقط الكنس كله
    expect(db.get(`SELECT 1 FROM banks WHERE id = ?`, [other])).toBeUndefined();
    expect(() => purgeFromTrash(db, 'banks', bank)).not.toThrow();
  });
});

describe('U٢١ · كشف حسابٍ آخر (رقم حسابه يخالف آيبان البنك) يُحفظ في البنك بلا فحص', () => {
  test('MT940 بـ:25: مختلف يُحفظ في بنكٍ آيبانه معروف', () => {
    const { db, bank } = books();
    db.run(`UPDATE banks SET iban = 'SA0300000000000000000001' WHERE id = ?`, [bank]);
    const sta = [':20:SYNU21', ':25:SA0300000000000000000002', ':60F:C261001SAR0,00',
      ':61:2610021002C1000,00NTRF//R1', ':86:حوالة مصطنعة', ':62F:C261031SAR1000,00'].join('\n');
    const m = readStatementFile({ name: 'other.sta', bytes: new TextEncoder().encode(sta) });
    if (!m.ok) throw new Error(m.error);
    // الصحيح: الحساب المطبوع في الكشف يخالف آيبان البنك فلا يُحفظ (أو يُطلب تأكيدٌ صريح)
    expect(() => saveStatement(db, bank, m, { name: 'other.sta', hash: 'u21' })).toThrow();
  });
});

describe('U٢٢ · درجة الثقة: الحركة المتنازَع عليها «جاهزة» لسطرٍ ولا اقتراح للآخر، ومرشحٌ ثانٍ حرٌّ لا يُقترح', () => {
  test('سطران بالمبلغ واليوم نفسيهما وحركةٌ واحدة: «المرشح الوحيد» لكلٍّ منهما فيصير أحدهما 85 «جاهزة» عشوائياً', () => {
    const { db, bank } = books();
    recordManualBankTx(db, { kind: 'income', bankId: bank, amountHalalas: 50000, date: '2026-10-05', descr: 'وارد مصطنع' });
    saveStatement(db, bank, stmt('01/10/2026', '31/10/2026', '0.00', [
      ['2026/10/05', 'حوالة من مستأجر مصطنع أ', '', '500.00', '500.00'],
      ['2026/10/05', 'حوالة من مستأجر مصطنع ب', '', '500.00', '1,000.00'],
    ]), { name: 'oct.csv', hash: 'u22a' });
    const s = matchSuggestions(db, bank);
    // الصحيح: سطران متعادلان على حركةٍ واحدة ليسا «جاهزة للاعتماد» (ولا يُعتمدان بـ«اعتماد كل الجاهزة»)
    expect(s.filter((x) => x.level === 'ready')).toEqual([]);
  });

  test('سطرٌ أخذ غيرُه أفضلَ مرشحيه لا يُقترح له مرشحه الثاني الحرّ', () => {
    const { db, bank } = books();
    recordManualBankTx(db, { kind: 'income', bankId: bank, amountHalalas: 50000, date: '2026-10-05', descr: 'وارد مصطنع أول' });
    recordManualBankTx(db, { kind: 'income', bankId: bank, amountHalalas: 50000, date: '2026-10-08', descr: 'وارد مصطنع ثان' });
    const no = db.get<{ no: string }>(`SELECT journal_no AS no FROM bank_tx WHERE bank_id = ? AND date = '2026-10-05'`, [bank])!.no;
    saveStatement(db, bank, stmt('01/10/2026', '31/10/2026', '0.00', [
      ['2026/10/05', 'حوالة مصطنعة', '', '500.00', '500.00'],
      ['2026/10/06', 'حوالة مصطنعة مرجع ' + no, '', '500.00', '1,000.00'],
    ]), { name: 'oct.csv', hash: 'u22b' });
    const s = matchSuggestions(db, bank);
    // سطر 6 أكتوبر يأخذ حركة 5 أكتوبر (رقمٌ مشترك) · والصحيح أن يُقترح لسطر 5 أكتوبر حركة 8 أكتوبر الحرّة
    expect(s.map((x) => [x.line.date, x.tx.date])).toEqual([['2026-10-05', '2026-10-08'], ['2026-10-06', '2026-10-05']]);
  });
});
