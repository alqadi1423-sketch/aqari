/**
 * المدقق المستقل للمرحلة ١ · الواجهة (ui) · D-2 · src/ui/DateField.tsx:41-45 مع src/domain/contracts/service.ts:460
 *
 * السيناريو (بيانات مصطنعة): في «إلغاء العقد» حقل «تاريخ إنهاء العقد» قيمته اليوم 2026-11-13. يريد المستخدم 2026-10-31 فيضغط القلم،
 * ويمسح النص بزر الحذف (هكذا يُكتب تاريخٌ جديد على الجوال)، ثم يكتبه كما يراه في الحقل يوماً-شهراً-سنة «31-10-2026».
 *  - عند آخر حرفٍ مُسح صار النص فارغاً، والحقل يمرّر الفراغ إلى النموذج («أو الفراغ إن مُسح الحقل») · ثم لا يمرّر المكتوب لأنه بغير صيغته.
 *  - الحقل أحمر ورسالته «تاريخ غير صحيح · اكتبه سنة-شهر-يوم مثل 2026-01-15» وحدها: لا تذكر أن المحفوظ سيكون تاريخ اليوم، وزر
 *    «تأكيد إلغاء العقد» ظاهر بلا حوار تأكيد.
 *  - cancelContract يأخذ الفارغ تاريخَ اليوم (`input.date || today()`)، فيُلغى العقد في 2026-11-13 لا في 2026-10-31: قسط نوفمبر
 *    (استحقاقه 2026-11-01، ١٠٠٬٠٠٠ هللة) يبقى مستحقاً على المستأجر، ولا يُلغى إلا ديسمبر.
 *  ومثله «تسجيل دفعة إيجار» والتحصيل الجماعي و«تاريخ الاتفاق» في التقبيل: الفارغ يصير اليوم.
 *
 * والخطة (D-2 · الإصلاح ١): «لا يُستدعى onChange إلا بتاريخٍ صحيح تماماً» · وما عولج في R11-5 حالة القيمة المعتمدة الصحيحة وحدها
 * (تُسمّى في الرسالة)، أما الفراغ فيُحفظ بغيره بلا تسمية.
 *
 * السلوك الصحيح: ما يُحفظ هو ما يراه المستخدم · إمّا أن يرفض الإلغاءُ التاريخَ الفارغ، وإمّا أن تسمّي رسالة الحقل التاريخ الذي سيُحفظ
 * (أو لا يمرّر الحقل الفراغ فيبقى المعتمد ويُسمّى كما في R11-5).
 *
 * لا مُصيِّر للواجهة في المستودع: الاختبار يستدعي المكوّن دالةً بموزّع خطافاتٍ صغير (useState وuseEffect وuseContext) ويضغط
 * أزراره بخصائصها، والمكوّنات الأصلية أسماءٌ نصية.
 */
jest.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput' }));
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('@/ui/icons', () => ({ Icon: 'Icon' }));
jest.mock('@/ui/store', () => ({ useFs: () => (n: number) => n }));

import React from 'react';
import { DateField } from '@/ui/DateField';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, cancelContract } from '@/domain/contracts/service';
import { dfmt } from '@/domain/dates';

type Node = { type?: unknown; props?: Record<string, unknown> } | string | number | boolean | null | undefined | Node[];
const RS = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } })
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/** حقل التاريخ مع نموذجٍ يحمل قيمته كما تفعل الشاشات (useState في الأب) */
function mountDateField(label: string, initial: string) {
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
        tree = DateField({ label, value, onChange: (v: string) => { value = v; } }) as unknown as Node;
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

test('D-2 مسح التاريخ ثم كتابته بغير صيغته: ما يُحفظ تاريخٌ لم يُسمَّ للمستخدم (اليوم بدل 2026-10-31)', () => {
  const db = memDb();
  const unit = addUnit(db, addProperty(db, { name: 'عقار مصطنع ui-12' }));
  // عقد 2026-01-01 إلى 2026-12-31 · ١٢٬٠٠٠٫٠٠ شهرياً ١٬٠٠٠٫٠٠ (١٠٠٬٠٠٠ هللة) · بلا تأمين
  const cid = confirmContract(db, contractInput(unit, {
    tenant: 'مستأجر مصطنع ui-12', idNumber: '1000001201', phone: '0500001201',
    valueHalalas: 1200000, depositHalalas: 0, start: '2026-01-01', end: '2026-12-31',
  }));

  // الحقل كما يفتحه CancelSheet: القيمة اليوم
  const f = mountDateField('تاريخ إنهاء العقد', '2026-11-13');
  f.toggleManual();
  expect(f.input().value).toBe('2026-11-13');
  // يمسح بزر الحذف حرفاً حرفاً ثم يكتب «31-10-2026» كما يُعرض التاريخ في الحقل (يوم/شهر/سنة)
  let s = String(f.input().value);
  while (s.length) { s = s.slice(0, -1); f.type(s); }
  for (const ch of '31-10-2026') { s += ch; f.type(s); }
  expect(f.input().value).toBe('31-10-2026');
  const shown = f.shown();

  // «تأكيد إلغاء العقد» بما في النموذج · fate «تُلغى جميعها»
  let saved: string | null = null;
  try {
    cancelContract(db, cid, {
      date: f.value, reason: 'إلغاء مصطنع', installmentsFate: 'cancel', settle: false,
      deductionHalalas: 0, refundHalalas: 0, deductionReason: '',
    });
    saved = db.get<{ d: string }>(`SELECT cancel_date AS d FROM contracts WHERE id = ?`, [cid])!.d;
  } catch { saved = null; }

  // إن حُفظ الإلغاء فبتاريخٍ تسمّيه رسالة الحقل · اليوم: حُفظ 13/11/2026 والرسالة لا تذكره، وقسط نوفمبر (١٠٠٬٠٠٠ هللة) بقي مستحقاً
  if (saved !== null) expect(shown).toContain(dfmt(saved));
  db.close();
});
