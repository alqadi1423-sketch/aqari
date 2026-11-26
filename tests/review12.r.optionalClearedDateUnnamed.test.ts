/**
 * مراجعة الإصلاح R12-UI-1 (ad462eb) · المراجع المستقل
 *
 * الإصلاح أغلق المسار في الحقل اللازم: مسحه لا يمرّر الفراغ، فيبقى المعتمد ويُسمّى. أما الحقل الذي عُلِّم optional فما زال على العيب
 * نفسه الذي وصفه البند: مسحه بزر الحذف (الطريقة الوحيدة على الجوال لكتابة تاريخٍ جديد) يمرّر الفراغ إلى النموذج، ثم يكتب المستخدم
 * التاريخ كما يراه يوماً ثم شهراً ثم سنة فلا يُمرَّر، والرسالة الحمراء «تاريخ غير صحيح · اكتبه…» وحدها: لا تذكر أن المحفوظ سيكون «بلا تاريخ».
 * والحفظ ظاهر، فيُمحى التاريخ القائم بدل أن يُغيَّر.
 *
 * السيناريو (بيانات مصطنعة · الساعة 2026-11-13): قسط نوفمبر (استحقاقه 2026-11-01، ١٠٠٬٠٠٠ هللة) عليه «موعد سداد متفق عليه» 2026-11-20.
 * يفتح المستخدم «تعديل الموعد» ليؤجّله إلى 25/11/2026: يضغط القلم، ويمسح النص، ويكتب «25-11-2026»، ويكتب السبب، ويضغط «حفظ».
 * saveSchedule يرسل `agreed || null` فيُزال الاتفاق كله: agreed_date = NULL، والقسط يرجع لاستحقاقه الأصلي 2026-11-01 (متأخراً ١٢ يوماً)
 * والرسالة التي رآها لم تذكر ذلك.
 *
 * السلوك الصحيح كما في البند: ما يُحفظ هو ما يراه المستخدم · فإن كان المحفوظ «بلا تاريخ» سمّته الرسالة الحمراء، لا «تاريخ غير صحيح» وحدها.
 */
jest.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput' }));
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('@/ui/icons', () => ({ Icon: 'Icon' }));
jest.mock('@/ui/store', () => ({ useFs: () => (n: number) => n }));

import React from 'react';
import { DateField } from '@/ui/DateField';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, setInstallmentSchedule } from '@/domain/contracts/service';
import { t } from '@/i18n';

type Node = { type?: unknown; props?: Record<string, unknown> } | string | number | boolean | null | undefined | Node[];
const RS = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } })
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/** حقل التاريخ مع نموذجٍ يحمل قيمته (useState في الأب) · موزّع الخطافات نفسه في اختبار المدقق */
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
  };
}

beforeAll(() => { jest.useFakeTimers({ now: new Date('2026-11-13T10:00:00+03:00'), doNotFake: ['setImmediate', 'nextTick'] }); });
afterAll(() => { jest.useRealTimers(); });

test('R12-UI-1 الحقل الاختياري: مسحه ثم كتابته بغير صيغته يمحو الموعد المتفق عليه والرسالة لا تسمّي ذلك', () => {
  const db = memDb();
  const unit = addUnit(db, addProperty(db, { name: 'عقار مصطنع r12-opt' }));
  // عقد 2026-01-01 إلى 2026-12-31 · ١٢٬٠٠٠٫٠٠ سنوياً = ١٢ قسطاً × ١٬٠٠٠٫٠٠ (١٠٠٬٠٠٠ هللة) · بلا تأمين
  const cid = confirmContract(db, contractInput(unit, {
    tenant: 'مستأجر مصطنع r12-opt', idNumber: '1000001299', phone: '0500001299',
    valueHalalas: 1200000, depositHalalas: 0, start: '2026-01-01', end: '2026-12-31',
  }));
  const nov = db.get<{ id: string; a: number }>(
    `SELECT id, amount_halalas AS a FROM contract_installments WHERE contract_id = ? AND due_date = '2026-11-01'`, [cid])!;
  expect(nov.a).toBe(100000); // 1200000 / 12
  setInstallmentSchedule(db, nov.id, { agreedDate: '2026-11-20', graceUntil: null, reason: 'اتفاق مصطنع' });

  // «تعديل الموعد» كما في InstallmentSheet: الحقل يبدأ بالموعد القائم، وهو optional في الإصلاح
  const label = 'موعد سداد متفق عليه';
  const f = mountDateField(label, '2026-11-20', { optional: true });
  f.toggleManual();
  // يمسح بزر الحذف حرفاً حرفاً ثم يكتب «25-11-2026» كما يُعرض التاريخ في الحقل (يوم/شهر/سنة)
  let s = String(f.input().value);
  while (s.length) { s = s.slice(0, -1); f.type(s); }
  for (const ch of '25-11-2026') { s += ch; f.type(s); }
  expect(f.input().value).toBe('25-11-2026');
  const shown = f.shown();

  // «حفظ» كما يرسله saveSchedule: agreedDate: agreed || null
  setInstallmentSchedule(db, nov.id, { agreedDate: f.value || null, graceUntil: null, reason: 'تأجيل مصطنع' });
  const saved = db.get<{ d: string | null }>(`SELECT agreed_date AS d FROM contract_installments WHERE id = ?`, [nov.id])!.d;
  // اليوم: مُحي الاتفاق (لا 2026-11-20 القائم ولا 2026-11-25 المقصود)
  expect(saved).toBeNull();

  // فالرسالة الحمراء يجب أن تسمّي أن المحفوظ «بلا تاريخ» · اليوم هي «تاريخ غير صحيح · اكتبه…» وحدها بعد عنوان الحقل
  expect(shown).not.toBe(label + ' ' + t('dates.invalid'));
  db.close();
});
