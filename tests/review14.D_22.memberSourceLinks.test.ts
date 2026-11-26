/**
 * المراجعة الشاملة 2026-11-13 · D-22 · منخفض · روابط «أحدث الحركات» وأوراق التفصيل في الرئيسية ترتدّ بالعضو.
 * السيناريو: عضوٌ يرى «الدفتر» ولا يرى المشتريات ← يضغط قيد شراء في «أحدث الحركات» ← يُدفع إلى /purchases ← يرجعه
 * حارس المسارات إلى الرئيسية: ضغطةٌ بلا نتيجة.
 * الصحيح: المسار يُحسب أولاً، والصف لا يكون زراً إن لم يُسمح بمساره.
 */
import fs from 'fs';
import path from 'path';
import { sourcePath } from '../src/ui/sourceRoute';
import { routeAllowed } from '../src/domain/access/routes';
import type { Access } from '../src/domain/access/access';

const noRent = () => null;

test('D-22 مسار كل مصدر', () => {
  expect(sourcePath('purchase', 'P1', noRent)).toBe('/purchases?detail=P1');
  expect(sourcePath('invoice', 'I1', noRent)).toBe('/invoices?detail=I1');
  expect(sourcePath('rent', 'PAY1', () => 'C1')).toBe('/contracts?detail=C1');
  expect(sourcePath('rent', 'PAY1', noRent)).toBe('/journal');
  expect(sourcePath('deposit_refund', 'C2', noRent)).toBe('/contracts?detail=C2');
  expect(sourcePath('claim', 'CL1', noRent)).toBe('/claims?detail=CL1');
  expect(sourcePath('cash_op', 'X', noRent)).toBe('/banks');
  expect(sourcePath(null, null, noRent)).toBe('/journal');
});

test('D-22 عضو الدفتر بلا المشتريات: مسار قيد الشراء ممنوع، ومسار القيد اليدوي مسموح', () => {
  const member = { owner: false, uid: 'u-member', perms: { ledger: 1 }, allProps: true, props: [] } as unknown as Access;
  expect(routeAllowed(member, sourcePath('purchase', 'P1', noRent))).toBe(false);
  expect(routeAllowed(member, sourcePath(null, null, noRent))).toBe(true);
});

test('D-22 الرئيسية لا تجعل الصف زراً إلا لمسارٍ مسموح', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', '(tabs)', 'index.tsx'), 'utf8');
  expect(src).toMatch(/sourcePath\(/);
  expect(src).toMatch(/routeAllowed\(access, /);
  // لا دفعٌ مباشر إلى مسار المصدر بلا فحص
  expect(src).not.toMatch(/router\.push\(`\/purchases\?detail=\$\{srcId\}`\)/);
});
