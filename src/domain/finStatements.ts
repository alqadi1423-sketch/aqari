/**
 * القوائم المالية الأربع كتلاً نقية قابلة للعرض بالصيغ الثلاث · نفس أرقام الشاشة حرفياً.
 * لا استيراد لأي شيء أصلي فتُختبر آلياً وتُولَّد عيناتها من بيئة الاختبار.
 */
import type { DB } from '../db/adapter';
import { allAccounts, accountPeriodChange, hasDimFilter, dimConds, type DimFilter, allAccountMovements } from './accounting/ledger';
import { fmt } from './money';
import { dfmt, addDays } from './dates';
import type { ReportBlock, Cell } from './officeBuild';
import { t } from '../i18n';

const M = (h: number): Cell => ({ money: Number(h) });
const periodLabel = (from: string | null, to: string) =>
  from ? 'من ' + dfmt(from) + ' إلى ' + dfmt(to) : 'حتى ' + dfmt(to);





export type FinStatement = 'income' | 'balance' | 'cash' | 'equity';

/** قيود الأصول التي لا نقد فيها: الإهلاك وإهلاك ما فات وإعادة التصنيف والاستبعاد والنقل وإثبات التكلفة (الهجرة ٢٩) */
// وعكسها (_rev) مثلها: عكسُ قيدٍ غير نقدي غير نقدي (التحقق المستقل: عكس إهلاك ما فات ظهر تشغيلياً واستثمارياً)
const ASSET_ENTRY_TYPES = ['depreciation', 'asset_dep', 'asset_catchup', 'asset_convert', 'asset_dispose', 'asset_sell', 'asset_transfer', 'asset_cost']
  .flatMap((x) => [x, x + '_rev']);
const FIXED_ASSET_CODES = ['1400', '1410', '1420', '1430', '1440', '1450', '1460', '1470'];
/** مجمع الإهلاك (استثماري مع الأصول) · والقروض (تمويلية مع حقوق الملكية) */
const ACC_ACCUM_DEP = '1490';
const ACC_LOANS = '2300';

/**
 * أرقام قائمة التدفقات النقدية · مشتركة بين الشاشة والتصدير، وتطابق تغيّر النقدية (1100) بالضبط (مراجعة التثبيت #14):
 * القيد متوازن، فتغيّر النقدية = صافي الربح + تغيّر كل حساب ميزانية غير النقدية. فيُقسم:
 *  - التشغيلي: صافي الربح بلا أثر قيود الأصول غير النقدية (الإهلاك والخسارة والربح وإعادة التصنيف)،
 *    وتغيّر رأس المال العامل: كل أصل وخصم غير النقدية والأصول الثابتة والقروض (الذمم والتأمينات والعرابين والضريبة وأرصدة المستأجرين).
 *  - الاستثماري: تغيّر الأصول الثابتة ومجمع إهلاكها من غير قيود الأصول، وما في قيود الأصول من نقد (متحصّل البيع).
 *  - التمويلي: حقوق الملكية (إيداع المالك ومسحوباته) والقروض (2300).
 */
export function cashFlowFigures(db: DB, from: string | null, to: string | null, net: number, dims?: DimFilter | null) {
  const dc = dimConds(dims);
  const where = (extra: string[]) => {
    const w = [`e.status = 'مرحّل'`, 'e.deleted_at IS NULL', ...extra, ...dc.sql]; // i18n-exempt: حالة القيد المخزّنة
    const p: string[] = [];
    if (from) { w.push('e.date >= ?'); p.push(from); }
    if (to) { w.push('e.date <= ?'); p.push(to); }
    return { sql: w.join(' AND '), p: [...dc.params, ...p] };
  };
  const q = (sql: string, extra: string[], params: string[]) => {
    const w = where(extra);
    return Number(db.get<{ v: number }>(sql.replace('{W}', w.sql), [...params, ...w.p])?.v ?? 0);
  };
  const types = ASSET_ENTRY_TYPES.map(() => '?').join(',');
  const codes = FIXED_ASSET_CODES.map(() => '?').join(',');
  const JOIN = 'FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.code = l.account_code';
  // أثر قيود الأصول على صافي الربح (دائن الإيراد والمصروف ناقص مدينهما)
  const nonCashPL = q(`SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS v ${JOIN} WHERE {W}`,
    [`e.src_type IN (${types})`, `a.type IN ('إيراد', 'مصروف')`], ASSET_ENTRY_TYPES); // i18n-exempt: أنواع الحسابات المخزّنة
  const bought = q(`SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas), 0) AS v ${JOIN} WHERE {W}`,
    [`l.account_code IN (${codes})`, `(e.src_type IS NULL OR e.src_type NOT IN (${types}))`], [...FIXED_ASSET_CODES, ...ASSET_ENTRY_TYPES]);
  const sold = q(`SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas), 0) AS v ${JOIN} WHERE {W}`,
    [`l.account_code = '1100'`, `e.src_type = 'asset_sell'`], []);
  const arChange = accountPeriodChange(db, '1200', from, to, dims);
  const apChange = accountPeriodChange(db, '2100', from, to, dims);
  // حركة كل حساب ميزانية (دائن ناقص مدين) من غير قيود الأصول · ونقد قيود الأصول وحده
  const w = where([`(e.src_type IS NULL OR e.src_type NOT IN (${types}))`, `a.type IN ('أصل', 'خصم', 'حقوق ملكية')`, `l.account_code != '1100'`]); // i18n-exempt: أنواع الحسابات المخزّنة
  const moves = db.all<{ code: string; type: string; name: string; d: number }>(
    `SELECT l.account_code AS code, a.type AS type, a.name AS name, COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS d ${JOIN}
     WHERE ${w.sql} GROUP BY l.account_code ORDER BY l.account_code`, [...ASSET_ENTRY_TYPES, ...w.p]);
  const assetCash = q(`SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas), 0) AS v ${JOIN} WHERE {W}`,
    [`l.account_code = '1100'`, `e.src_type IN (${types})`], ASSET_ENTRY_TYPES);
  const isInv = (c: string) => FIXED_ASSET_CODES.includes(c) || c === ACC_ACCUM_DEP;
  const isFin = (m: { code: string; type: string }) => m.type === 'حقوق ملكية' || m.code === ACC_LOANS; // i18n-exempt: نوع الحساب المخزّن
  const line = (m: { code: string; name: string; d: number }) => ({ code: m.code, name: m.name, v: Number(m.d) });
  const workingCapital = moves.filter((m) => !isInv(m.code) && !isFin(m) && Number(m.d)).map(line);
  const financingLines = moves.filter((m) => isFin(m) && Number(m.d)).map(line);
  const opCash = net - nonCashPL + workingCapital.reduce((s, l) => s + l.v, 0);
  const investing = moves.filter((m) => isInv(m.code)).reduce((s, m) => s + Number(m.d), 0) + assetCash;
  const financing = financingLines.reduce((s, l) => s + l.v, 0);
  const cashChange = accountPeriodChange(db, '1100', from, to, dims);
  return { arChange, apChange, nonCash: -nonCashPL, opCash, investing, bought, sold, workingCapital, financingLines, financing,
    cashChange, unexplained: cashChange - (opCash + investing + financing) };
}

/** قائمة مالية واحدة كتلةً قابلة للعرض بالصيغ الثلاث · نفس أرقام الشاشة حرفياً */
export function financialStatementBlock(db: DB, tab: FinStatement, from: string | null, to: string, dims?: DimFilter | null): ReportBlock {
  const accounts = allAccounts(db);
  // حركات كل الحسابات بعبارة مجمّعة واحدة لكل مدة (دراسة ٨ · قرار المالك 2026-10-09) · لا استعلامٌ لكل حساب
  const periods = new Map<string, Map<string, { debit: number; credit: number }>>();
  const movesOf = (f: string | null, t: string | null) => {
    const k = (f ?? '') + '|' + (t ?? '');
    let m = periods.get(k);
    if (!m) { m = allAccountMovements(db, f, t, dims); periods.set(k, m); }
    return m;
  };
  const ZERO = { debit: 0, credit: 0 };
  const mv = (code: string) => movesOf(from, to).get(code) ?? ZERO;
  const balAt = (a: { code: string; type: string; opening_halalas: number }, at: string | null) => {
    const m = movesOf(null, at).get(a.code) ?? ZERO;
    const net = m.debit - m.credit;
    const oriented = ['أصل', 'مصروف'].includes(a.type) ? net : -net;
    // الافتتاحي المزروع بلا أبعاد · فلا يدخل قائمةً مصفّاة ببُعد
    return oriented + (hasDimFilter(dims) ? 0 : Number(a.opening_halalas || 0));
  };
  const rev = accounts.filter((a) => a.type === 'إيراد').map((a) => ({ name: a.name, v: mv(a.code).credit - mv(a.code).debit }));
  const exp = accounts.filter((a) => a.type === 'مصروف').map((a) => ({ name: a.name, v: mv(a.code).debit - mv(a.code).credit }));
  const totalRev = rev.reduce((s2, r) => s2 + r.v, 0);
  const totalExp = exp.reduce((s2, r) => s2 + r.v, 0);
  const net = totalRev - totalExp;
  // أرباح الفترات حتى تاريخٍ: لا إقفال للإيراد والمصروف في الدفتر، فهي سطرٌ في حقوق الملكية يتوازن به المركز
  // كفحص المطابقة ٦ (مراجعة التثبيت #13)
  const earningsAt = (at: string | null) => accounts.reduce((s2, a) =>
    s2 + (a.type === 'إيراد' ? balAt(a, at) : a.type === 'مصروف' ? -balAt(a, at) : 0), 0); // i18n-exempt: أنواع الحسابات المخزّنة

  if (tab === 'income') {
    return {
      heading: 'قائمة الدخل',
      meta: [['المدة', periodLabel(from, to)]],
      sections: [
        { title: 'الإيرادات', sum: true, header: ['البند', 'المبلغ'], rows: rev.map((r) => [r.name, M(r.v)]) },
        { title: 'المصروفات', sum: true, header: ['البند', 'المبلغ'], rows: exp.map((r) => [r.name, M(r.v)]) },
      ],
      totals: [
        ['إجمالي الإيرادات', M(totalRev)],
        ['إجمالي المصروفات', M(totalExp)],
        ['صافي الربح', M(net), true],
      ],
    };
  }
  if (tab === 'balance') {
    const asset = accounts.filter((a) => a.type === 'أصل').map((a) => ({ name: a.name, v: balAt(a, to) }));
    const liab = accounts.filter((a) => a.type === 'خصم').map((a) => ({ name: a.name, v: balAt(a, to) }));
    const eq = [...accounts.filter((a) => a.type === 'حقوق ملكية').map((a) => ({ name: a.name, v: balAt(a, to) })),
      { name: t('fin.unclosedEarnings'), v: earningsAt(to) }];
    const sumA = asset.reduce((s2, r) => s2 + r.v, 0);
    const sumL = liab.reduce((s2, r) => s2 + r.v, 0);
    const sumE = eq.reduce((s2, r) => s2 + r.v, 0);
    return {
      heading: 'قائمة المركز المالي',
      meta: [['كما في', dfmt(to)]],
      sections: [
        { title: 'الأصول', sum: true, header: ['البند', 'المبلغ'], rows: asset.map((r) => [r.name, M(r.v)]) },
        { title: 'الخصوم', sum: true, header: ['البند', 'المبلغ'], rows: liab.map((r) => [r.name, M(r.v)]) },
        { title: 'حقوق الملكية', sum: true, header: ['البند', 'المبلغ'], rows: eq.map((r) => [r.name, M(r.v)]) },
      ],
      totals: [
        ['إجمالي الأصول', M(sumA)],
        ['إجمالي الخصوم وحقوق الملكية', M(sumL + sumE)],
        [Math.abs(sumA - (sumL + sumE)) > 1 ? 'الميزانية غير متوازنة · تحقق من القيود' : 'الأصول = الخصوم + حقوق الملكية', M(sumA - (sumL + sumE)), true],
      ],
    };
  }
  if (tab === 'cash') {
    const cf = cashFlowFigures(db, from, to, net, dims);
    return {
      heading: 'قائمة التدفقات النقدية',
      meta: [['المدة', periodLabel(from, to)]],
      sections: [{
        title: 'التدفقات', sum: false, header: ['البند', 'المبلغ'],
        rows: [
          ['صافي الربح', M(net)],
          ...(cf.nonCash ? [[t('assets.cashflow.nonCash'), M(cf.nonCash)] as [string, Cell]] : []),
          ...cf.workingCapital.map((l) => [t('fin.changeIn', { name: l.name }), M(l.v)] as [string, Cell]),
          ['صافي التدفق من الأنشطة التشغيلية', M(cf.opCash)],
          ['شراء وبيع أصول ثابتة', M(cf.investing)],
          ...cf.financingLines.map((l) => [t('fin.changeIn', { name: l.name }), M(l.v)] as [string, Cell]),
          [t('fin.financing'), M(cf.financing)],
          ...(cf.unexplained ? [[t('fin.unexplained'), M(cf.unexplained)] as [string, Cell]] : []),
        ],
      }],
      totals: [['صافي التغير في النقدية', M(cf.cashChange), true]],
    };
  }
  const capIn = mv('3100').credit;
  const capOut = mv('3100').debit;
  const eqAll = accounts.filter((a) => a.type === 'حقوق ملكية');
  // اليوم السابق بالتقويم المحلي · كان يُحوَّل إلى UTC فيرجع يومين بتوقيت الرياض (المراجعة ٤.٧)
  const dayBefore = (d: string) => addDays(d, -1);
  // أول المدة بأرباح ما قبلها، وبلا بداية: الأرصدة الافتتاحية · وحركة حقوق الملكية غير رأس المال (3200) سطرٌ ظاهر،
  // فآخر المدة = حقوق الملكية في المركز بتاريخها (مراجعة التثبيت #13)
  // وبلا بداية: افتتاحيات حقوق الملكية والإيراد والمصروف (التحقق المستقل: الافتتاحي على 4300 كان يُسقط من أول المدة)
  const openingOf = (a: { type: string; opening_halalas: number }) => Number(a.opening_halalas || 0)
    * (a.type === 'حقوق ملكية' || a.type === 'إيراد' ? 1 : a.type === 'مصروف' ? -1 : 0); // i18n-exempt: أنواع الحسابات المخزّنة
  const eqOpen = from
    ? eqAll.reduce((s2, a) => s2 + balAt(a, dayBefore(from)), 0) + earningsAt(dayBefore(from))
    : (hasDimFilter(dims) ? 0 : accounts.reduce((s2, a) => s2 + openingOf(a), 0));
  const otherMove = eqAll.filter((a) => a.code !== '3100').reduce((s2, a) => s2 + mv(a.code).credit - mv(a.code).debit, 0);
  return {
    heading: 'قائمة التغيّرات في حقوق الملكية',
    meta: [['المدة', periodLabel(from, to)]],
    sections: [{
      title: 'الحركة', sum: false, header: ['البند', 'المبلغ'],
      rows: [
        ['حقوق الملكية أول المدة', M(eqOpen)],
        ['إضافات المالك', M(capIn)],
        ['مسحوبات المالك', M(-capOut)],
        ...(otherMove ? [[t('fin.otherEquityMove'), M(otherMove)] as [string, Cell]] : []),
        ['صافي ربح المدة', M(net)],
      ],
    }],
    totals: [['حقوق الملكية آخر المدة', M(eqOpen + capIn - capOut + otherMove + net), true]],
  };
}



/**
 * يلبس كتلة القائمة صيغ إكسل حيّة لصفوف مجاميعها وإجمالياتها (المراجع الرمزية
 * تُحل في officeBuild) والقيم المحسوبة تبقى كاشاً · لا أثر لها في PDF ووورد.
 */
export function withLiveFormulas(tab: FinStatement, b: ReportBlock): ReportBlock {
  const totalsWith = (formulas: Array<string | null>): ReportBlock['totals'] =>
    b.totals.map(([k, v, big], i): [string, Cell, boolean?] => {
      const f = formulas[i];
      return f && typeof v === 'object' ? [k, { ...v, f }, big] : [k, v, big];
    });
  if (tab === 'income')
    return { ...b, totals: totalsWith(['SUM({S0})', 'SUM({S1})', '{T0}-{T1}']) };
  if (tab === 'balance')
    return { ...b, totals: totalsWith(['SUM({S0})', 'SUM({S1})+SUM({S2})', '{T0}-{T1}']) };
  if (tab === 'cash') {
    // الصفوف متغيرة العدد (رأس المال العامل والتمويلي، مراجعة التثبيت #14) · فالصيغ من مواضعها لا من ترتيب ثابت
    // (التحقق المستقل: كان الإجمالي في إكسل ٤٠٠٠ والحقيقي ٢٥٠٠) · المراجع بالترتيب من ١
    const rows = b.sections[0]?.rows ?? [];
    const at = (label: string) => rows.findIndex((r) => r[0] === label);
    const op = at('صافي التدفق من الأنشطة التشغيلية');
    const inv = at('شراء وبيع أصول ثابتة');
    const fin = at(t('fin.financing'));
    const unexplained = at(t('fin.unexplained'));
    const formulaAt = new Map<number, string>();
    if (op > 0) formulaAt.set(op, `SUM({S0R1}:{S0R${op}})`);
    if (fin > inv + 1) formulaAt.set(fin, `SUM({S0R${inv + 2}}:{S0R${fin}})`);
    const sections = b.sections.map((s, si) => si !== 0 ? s : {
      ...s,
      rows: s.rows.map((row, ri) => !formulaAt.has(ri) ? row : row.map((c) =>
        typeof c === 'object' ? { ...c, f: formulaAt.get(ri)! } : c)),
    });
    const parts = [op, inv, fin, unexplained].filter((i) => i >= 0).map((i) => `{S0R${i + 1}}`);
    return { ...b, sections, totals: totalsWith([parts.join('+')]) };
  }
  // حقوق الملكية: آخر المدة = مجموع صفوف الحركة (أولها + إضافات - مسحوبات + صافي الربح)
  return { ...b, totals: totalsWith(['SUM({S0})']) };
}

export const FIN_TITLES: Record<FinStatement, string> = {
  income: 'قائمة الدخل', balance: 'قائمة المركز المالي',
  cash: 'قائمة التدفقات النقدية', equity: 'قائمة التغيّرات في حقوق الملكية',
};
