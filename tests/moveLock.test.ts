/**
 * قرار المالك 2026-10-09 (ثانياً · المسائل الثلاث ٢): «النقل بين العقارات لمن له كلها، ويُخفى عن المحصور مع سببه».
 * القواعد ترفض تغيير عقار صفٍّ قائم من المحصور، فالنموذج يُقفله له ويُظهر السبب، والجديد يختار من عقاراته.
 */
import { canMoveAcrossProperties, propertyMoveLocked } from '@/domain/access/access';
import type { Access } from '@/domain/access/access';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';

const owner: Access = { owner: true, uid: 'U0', perms: {}, allProps: true, props: [] };
const allProps: Access = { owner: false, uid: 'U1', perms: { props: 3, purchases: 3 }, allProps: true, props: [] };
const restricted: Access = { owner: false, uid: 'U2', perms: { props: 3, purchases: 3 }, allProps: false, props: ['P1', 'P2'] };

test('النقل لمن له كل العقارات والمالك · والمحصور لا ينقل صفاً قائماً', () => {
  expect([owner, allProps, restricted].map(canMoveAcrossProperties)).toEqual([true, true, false]);
  expect(propertyMoveLocked(restricted, true)).toBe(true);
  expect(propertyMoveLocked(restricted, false)).toBe(false);
  expect(propertyMoveLocked(allProps, true)).toBe(false);
  expect(propertyMoveLocked(owner, true)).toBe(false);
});

test('سبب الإخفاء مكتوب باللغتين', () => {
  expect((ar as { access?: { moveAllPropsOnly?: string } }).access?.moveAllPropsOnly).toBeTruthy();
  expect((en as { access?: { moveAllPropsOnly?: string } }).access?.moveAllPropsOnly).toBeTruthy();
});
