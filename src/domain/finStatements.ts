/**
 * القوائم المالية الأربع كتلاً نقية قابلة للعرض بالصيغ الثلاث · نفس أرقام الشاشة حرفياً.
 * لا استيراد لأي شيء أصلي فتُختبر آلياً وتُولَّد عيناتها من بيئة الاختبار.
 */
import type { DB } from '../db/adapter';
import { allAccounts, accountMovement, accountPeriodChange } from './accounting/ledger';
import { fmt } from './money';
import { dfmt } from './dates';
import type { ReportBlock, Cell } from './officeBuild';

const M = (h: number): Cell => ({ money: Number(h) });
const periodLabel = (from: string | null, to: string) =>
  from ? 'من ' + dfmt(from) + ' إلى ' + dfmt(to) : 'حتى ' + dfmt(to);





export type FinStatement = 'income' | 'balance' | 'cash' | 'equity';

/** قائمة مالية واحدة كتلةً قابلة للعرض بالصيغ الثلاث · نفس أرقام الشاشة حرفياً */
export function financialStatementBlock(db: DB, tab: FinStatement, from: string | null, to: string): ReportBlock {
  const accounts = allAccounts(db);
  const mv = (code: string) => accountMovement(db, code, from, to);
  const balAt = (a: { code: string; type: string; opening_halalas: number }, at: string | null) => {
    const m = accountMovement(db, a.code, null, at);
    const net = m.debit - m.credit;
    const oriented = ['أصل', 'مصروف'].includes(a.type) ? net : -net;
    return oriented + Number(a.opening_halalas || 0);
  };
  const rev = accounts.filter((a) => a.type === 'إيراد').map((a) => ({ name: a.name, v: mv(a.code).credit - mv(a.code).debit }));
  const exp = accounts.filter((a) => a.type === 'مصروف').map((a) => ({ name: a.name, v: mv(a.code).debit - mv(a.code).credit }));
  const totalRev = rev.reduce((s2, r) => s2 + r.v, 0);
  const totalExp = exp.reduce((s2, r) => s2 + r.v, 0);
  const net = totalRev - totalExp;

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
    const eq = accounts.filter((a) => a.type === 'حقوق ملكية').map((a) => ({ name: a.name, v: balAt(a, to) }));
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
    const arChange = accountPeriodChange(db, '1200', from, to);
    const apChange = accountPeriodChange(db, '2100', from, to);
    const faChange = accountPeriodChange(db, '1400', from, to);
    const opCash = net - arChange + apChange;
    return {
      heading: 'قائمة التدفقات النقدية',
      meta: [['المدة', periodLabel(from, to)]],
      sections: [{
        title: 'التدفقات', sum: false, header: ['البند', 'المبلغ'],
        rows: [
          ['صافي الربح', M(net)],
          ['التغير في الذمم المدينة', M(-arChange)],
          ['التغير في الذمم الدائنة', M(apChange)],
          ['صافي التدفق من الأنشطة التشغيلية', M(opCash)],
          ['شراء وبيع أصول ثابتة', M(-faChange)],
        ],
      }],
      totals: [['صافي التغير في النقدية', M(opCash - faChange), true]],
    };
  }
  const capIn = mv('3100').credit;
  const capOut = mv('3100').debit;
  const eqAll = accounts.filter((a) => a.type === 'حقوق ملكية');
  const dayBefore = (d: string) => {
    const t = new Date(d + 'T00:00:00');
    return new Date(t.getTime() - 86400000).toISOString().slice(0, 10);
  };
  const eqOpen = eqAll.reduce((s2, a) => s2 + (from ? balAt(a, dayBefore(from)) : 0), 0);
  return {
    heading: 'قائمة التغيّرات في حقوق الملكية',
    meta: [['المدة', periodLabel(from, to)]],
    sections: [{
      title: 'الحركة', sum: false, header: ['البند', 'المبلغ'],
      rows: [
        ['حقوق الملكية أول المدة', M(eqOpen)],
        ['إضافات المالك', M(capIn)],
        ['مسحوبات المالك', M(-capOut)],
        ['صافي ربح المدة', M(net)],
      ],
    }],
    totals: [['حقوق الملكية آخر المدة', M(eqOpen + capIn - capOut + net), true]],
  };
}



export const FIN_TITLES: Record<FinStatement, string> = {
  income: 'قائمة الدخل', balance: 'قائمة المركز المالي',
  cash: 'قائمة التدفقات النقدية', equity: 'قائمة التغيّرات في حقوق الملكية',
};
