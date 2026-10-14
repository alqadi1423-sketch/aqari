/**
 * المراجعة الخارجية ٧ · النتيجة ١٧ (قرار المالك «رابعاً ١٠»: «شارة دور مشتقة من المعرّف لا من النص، وقيد على الاسم») ·
 * بيانات مصطنعة. معيار الإغلاق: «ناتج senderOf لغير المالك لا يساوي عرض المالك أبداً».
 */
import { roleOf, senderDisplay } from '@/chat';
import { validateProfile, reservedName } from '@/domain/access/profile';

const ORG = 'OWNER-17';
const OWNER_NAME = 'مالك مصطنع';

test('عرض غير المالك لا يساوي عرض المالك أبداً ولو طابق اسمُه اسمَ المالك أو شارته نصاً', () => {
  const owner = senderDisplay(ORG, ORG, { name: OWNER_NAME, sup: [] }, '');
  expect(owner.role).toEqual({ kind: 'owner' });
  for (const name of [OWNER_NAME, OWNER_NAME + ' · مالك المنشأة', 'المالك', 'مالك المنشأة', 'Organisation owner']) {
    for (const sup of [[], ['contracts']]) {
      const d = senderDisplay('MEMBER-17', ORG, { name, sup }, '');
      expect(d.role?.kind).not.toBe('owner');
      expect(d).not.toEqual(owner);
    }
  }
  expect(roleOf('MEMBER-17', ORG, ['contracts'])).toEqual({ kind: 'supervisor', sections: ['contracts'] });
  expect(roleOf('MEMBER-17', ORG, [])).toBeNull();
});

test('قيد الاسم على الجهاز: ما يحاكي شارة دور أو فاصلها يُرفض · والاسم العادي يُقبل', () => {
  for (const name of ['عضو مصطنع · المالك', 'المالك', 'مالك المنشأة', 'مشرف: العقود', 'x · y', 'The Owner', 'supervisor x']) {
    expect(reservedName(name)).toBe(true);
    const r = validateProfile({ name, phone: '0500000017' }, true);
    expect(r.ok).toBe(false);
  }
  for (const name of ['عضو مصطنع', 'مالك مصطنع', 'مشرف مصطنع', 'Malik Test']) {
    expect(reservedName(name)).toBe(false);
    expect(validateProfile({ name, phone: '0500000017' }, true).ok).toBe(true);
  }
});

test('الجولة ٢٨: الجهاز ينزع التطويل والتشكيل قبل الفحص · ويرفض الحروف الشبيهة والعريضة', () => {
  expect(validateProfile({ name: 'عضو المـالك', phone: '0500000028' }, true).ok).toBe(false);
  expect(validateProfile({ name: 'عضو المالِك', phone: '0500000028' }, true).ok).toBe(false);
  for (const name of ['Member \u043Ewner', 'Member \uFF2F\uFF37\uFF2E\uFF25\uFF32', 'عضو \u30FB ب', 'عضو\u200Fب']) {
    expect(validateProfile({ name, phone: '0500000028' }, true).ok).toBe(false);
  }
  const ok = validateProfile({ name: 'عبدُالله مصطـفى', phone: '0500000028' }, true);
  expect(ok.ok && ok.profile.name).toBe('عبدالله مصطفى');
});

test('الجولة ٢٩: الحروف الشبيهة داخل الصنف تُطوى قبل فحص المحجوز', () => {
  for (const name of ['محمد المال\u06A9', 'محمد مال\u06A9 المنشأة', 'محمد \u0671لمالك', 'محمد المال\u06AA', 'Ali 0wner', 'Ali 5upervisor']) {
    expect(validateProfile({ name, phone: '0500000029' }, true).ok).toBe(false);
  }
  for (const name of ['مالك مصطنع', 'گل مصطنع', 'Ali 5', 'Room 101']) expect(validateProfile({ name, phone: '0500000029' }, true).ok).toBe(true);
});
