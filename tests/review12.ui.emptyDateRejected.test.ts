/**
 * R12-UI-1 (المراجعة ١٢ · الواجهة) · ما لم يكتبه المدقق: الفراغ لا يصير «تاريخ اليوم» بصمت
 *
 * (١) حقل التاريخ اللازم (تاريخ الإلغاء والدفعة والاتفاق…): مسحه كله بزر الحذف لا يمرّر الفراغ إلى النموذج، فيبقى المعتمد ويُسمّى
 *     في رسالةٍ حمراء تحت الحقل · والحقل الاختياري (انتهاء الضمان، المهلة، من/إلى في التقارير…) يمرّر الفراغ كما كان فيُمسح.
 * (٢) الخدمات الأربع التي كانت تأخذ الفارغ تاريخَ اليوم (`input.date || today()`) ترفضه برسالة: إلغاء العقد، ودفعة الإيجار،
 *     والتحصيل الجماعي، وصفقة التقبيل · ومعها أثرُ المشكك (ALSO): الإلغاء بتسوية تأمينٍ وتاريخٍ فارغ كان يُلغي بتاريخ اليوم ويُرحّل
 *     الخصم كله «إيراداً آخر» (4300) لأن «منها مقابل أقساطٍ متأخرة» يحسب بالفراغ صفراً، والأقساط المتأخرة تبقى ديناً.
 *
 * بيانات مصطنعة · الساعة 2026-11-13.
 */
jest.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput' }));
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('@/ui/icons', () => ({ Icon: 'Icon' }));
jest.mock('@/ui/store', () => ({ useFs: () => (n: number) => n }));

import React from 'react';
import { DateField } from '@/ui/DateField';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, cancelContract, recordRentPayment, recordBulkRentPayment, depositArrearsDue } from '@/domain/contracts/service';
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { t } from '@/i18n';

type Node = { type?: unknown; props?: Record<string, unknown> } | string | number | boolean | null | undefined | Node[];
const RS = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } })
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/** حقل التاريخ مع نموذجٍ يحمل قيمته (useState في الأب) · موزّع خطافاتٍ صغير كما في اختبار المدقق */
function mountDateField(label: string, initial: string, extra: { optional?: boolean } = {}) {
  let value = initial;
  const slots: Array<{ v?: unknown; deps?: unknown[] }> = [];
  let tree: Node = null;
  let dirty = false;
  const render = () => {
    for (let n = 0; n < 30; n++) {
      dirty = false;
      const pending: Array<() => void> = [];
      let i = 0;
      RS.H = {
        useState(init: unknown) {
          const k = i++;
          if (!slots[k]) slots[k] = { v: typeof init === 'function' ? (init as () => unknown)() : init };
          const s = slots[k];
          return [s.v, (nv: unknown) => { s.v = typeof nv === 'function' ? (nv as (p: unknown) => unknown)(s.v) : nv; dirty = true; }];
        },
        useEffect(fn: () => void, deps?: unknown[]) {
          const k = i++;
          const prev = slots[k];
          if (!prev || !deps || deps.some((d, j) => !Object.is(d, prev.deps?.[j]))) { slots[k] = { deps }; pending.push(fn); }
        },
        useContext(ctx: { _currentValue: unknown }) { return ctx._currentValue; },
      };
      try {
        tree = DateField({ label, value, onChange: (v: string) => { value = v; }, ...extra } as Parameters<typeof DateField>[0]) as unknown as Node;
      } finally { RS.H = null; }
      pending.forEach((f) => f());
      if (!dirty) return;
    }
    throw new Error('لم يستقر الحقل');
  };
  const all = (n: Node, out: Array<{ type?: unknown; props?: Record<string, unknown> }> = []) => {
    if (Array.isArray(n)) { n.forEach((c) => all(c, out)); return out; }
    if (n && typeof n === 'object') { out.push(n); all(n.props?.children as Node, out); }
    return out;
  };
  const strings = (n: Node, out: string[] = []): string[] => {
    if (Array.isArray(n)) n.forEach((c) => strings(c, out));
    else if (typeof n === 'string') out.push(n);
    else if (n && typeof n === 'object') strings(n.props?.children as Node, out);
    return out;
  };
  render();
  return {
    get value() { return value; },
    shown: () => strings(tree).join(' '),
    toggleManual() { (all(tree).find((e) => e.type === 'Pressable' && e.props?.hitSlop === 6)!.props!.onPress as () => void)(); render(); },
    input() { return all(tree).find((e) => e.type === 'TextInput')!.props!; },
    type(text: string) { (this.input().onChangeText as (v: string) => void)(text); render(); },
    clear() { let s = String(this.input().value); while (s.length) { s = s.slice(0, -1); this.type(s); } },
  };
}

beforeAll(() => { jest.useFakeTimers({ now: new Date('2026-11-13T10:00:00+03:00'), doNotFake: ['setImmediate', 'nextTick'] }); });
afterAll(() => { jest.useRealTimers(); });

test('R12-UI-1 الحقل اللازم: مسحه كله لا يمرّر الفراغ · يبقى المعتمد ويُسمّى بالأحمر', () => {
  const f = mountDateField('تاريخ إنهاء العقد', '2026-11-13');
  f.toggleManual();
  f.clear();
  expect(f.input().value).toBe('');
  // النموذج يحمل المعتمد لا الفراغ (اليوم: صار '')
  expect(f.value).toBe('2026-11-13');
  // ورسالة الحقل تسمّيه بصيغة العرض يوم/شهر/سنة
  expect(f.shown()).toContain('13/11/2026');
  // ثم تاريخٌ صحيح يُمرَّر كما كُتب
  f.type('2026-10-31');
  expect(f.value).toBe('2026-10-31');
  expect(f.shown()).not.toContain('13/11/2026');
});

test('R12-UI-1 الحقل الاختياري: مسحه يمرّر الفراغ فيُمسح التاريخ بلا رسالة', () => {
  const f = mountDateField('انتهاء الضمان', '2027-03-31', { optional: true });
  f.toggleManual();
  f.clear();
  expect(f.value).toBe('');
  expect(f.shown()).toBe('انتهاء الضمان');
});

test('R12-UI-1 (مراجعة) الحقل الاختياري بلا تاريخ والمكتوب بغير صيغته: الرسالة تسمّي أنه بلا تاريخ', () => {
  // ممسوحٌ ثم مكتوبٌ يوماً ثم شهراً ثم سنة: الفراغ مُرِّر عند المسح، و«31-03-2028» لا يُمرَّر، فالمحفوظ «بلا تاريخ» ويُسمّى
  const f = mountDateField('انتهاء الضمان', '2027-03-31', { optional: true });
  f.toggleManual();
  f.clear();
  f.type('31-03-2028');
  expect(f.value).toBe('');
  expect(f.shown()).toBe('انتهاء الضمان ' + t('dates.invalidEmpty'));
  // وحقلٌ اختياريٌّ بدأ بلا تاريخ ثم كُتب بغير صيغته: الرسالة نفسها
  const g = mountDateField('مهلة سداد حتى', '', { optional: true });
  g.toggleManual();
  g.type('20-11-2026');
  expect(g.value).toBe('');
  expect(g.shown()).toBe('مهلة سداد حتى ' + t('dates.invalidEmpty'));
  // والمكتوب بصيغته يُمرَّر فتزول الرسالة
  g.type('2026-11-20');
  expect(g.value).toBe('2026-11-20');
  expect(g.shown()).toBe('مهلة سداد حتى');
});

test('R12-UI-1 الخدمات الأربع ترفض التاريخ الفارغ برسالة ولا تأخذ تاريخ اليوم', () => {
  const db = memDb();
  const unit = addUnit(db, addProperty(db, { name: 'عقار مصطنع ui-12ب' }));
  // عقد 2026-01-01 إلى 2026-12-31 · ١٢٬٠٠٠٫٠٠ سنوياً ١٬٠٠٠٫٠٠ شهرياً (١٠٠٬٠٠٠ هللة) · تأمين ٢٬٠٠٠٫٠٠ (٢٠٠٬٠٠٠ هللة)
  const cid = confirmContract(db, contractInput(unit, {
    tenant: 'مستأجر مصطنع ui-12ب', idNumber: '1000001202', phone: '0500001202',
    valueHalalas: 1200000, depositHalalas: 200000, start: '2026-01-01', end: '2026-12-31',
  }));
  const msg = t('dates.required');
  expect(msg).not.toBe('dates.required');

  // أثر المشكك: بتاريخٍ فارغ «منها مقابل أقساطٍ متأخرة» صفر · وبتاريخ اليوم أحد عشر قسطاً حلّت (يناير إلى نوفمبر) = ١١ × ١٠٠٬٠٠٠
  expect(depositArrearsDue(db, cid, '')).toBe(0);
  expect(depositArrearsDue(db, cid, '2026-11-13')).toBe(1100000); // 11 × 100000
  const statusBefore = db.get<{ s: string }>(`SELECT status AS s FROM contracts WHERE id = ?`, [cid])!.s;

  // (أ) الإلغاء بتسوية والخصم كله (٢٠٠٬٠٠٠) ومقابل الأقساط صفر كما ترسله الورقة بالفراغ
  expect(() => cancelContract(db, cid, {
    date: '', reason: 'إلغاء مصطنع', installmentsFate: 'cancel', settle: true,
    deductionHalalas: 200000, refundHalalas: 0, deductionReason: 'خصم مصطنع', arrearsHalalas: 0,
  })).toThrow(msg);
  const c = db.get<{ s: string; d: string | null }>(`SELECT status AS s, cancel_date AS d FROM contracts WHERE id = ?`, [cid])!;
  expect(c.s).toBe(statusBefore);
  expect(c.d).toBeNull();
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM deposit_settlements WHERE contract_id = ?`, [cid])!.n).toBe(0);
  // ولا شيء في 4300 «إيراد آخر»
  expect(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM journal_lines l WHERE l.account_code = '4300'`)!.n).toBe(0);

  // (ب) دفعة إيجار بقسط نوفمبر ١٠٠٬٠٠٠ نقداً بتاريخٍ فارغ
  const nov = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? AND due_date = '2026-11-01'`, [cid])!.id;
  expect(() => recordRentPayment(db, cid, {
    installmentId: nov, period: 'نوفمبر 2026', date: '', lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '',
  })).toThrow(msg);
  // (ج) التحصيل الجماعي بالقسط نفسه
  expect(() => recordBulkRentPayment(db, cid, {
    installmentIds: [nov], date: '', lines: [{ method: 'cash', amountHalalas: 100000 }], notes: '',
  })).toThrow(msg);
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments`)!.n).toBe(0);
  expect(db.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = ?`, [nov])!.p).toBe(0);

  // (د) صفقة تقبيل ٥٠٬٠٠٠٫٠٠ بلا عمولة بتاريخٍ فارغ
  expect(() => recordKeyMoneyDeal(db, {
    unitId: unit, outgoing: 'متنازل مصطنع', incoming: 'متنازل له مصطنع', amountHalalas: 5000000, date: '',
    commissionHalalas: 0, method: null, notes: '',
  })).toThrow(msg);
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM key_money_deals`)!.n).toBe(0);
  db.close();
});
