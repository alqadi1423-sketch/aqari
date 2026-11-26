/**
 * المراجعة الشاملة 2026-11-13 · A1-11 · منخفض · app/(tabs)/contracts.tsx (instBadge) · src/ui/InstallmentSheet.tsx · بيانات مصطنعة.
 *
 * ما كان: شارة القسط في جدول العقد تعرض الحالة المخزَّنة، و«متأخرة» لا تُخزَّن أبداً، و«قادمة» من الاستحقاق لا من الموعد المتفق عليه ·
 * فالقسط المتأخر ٤٠ يوماً «مستحقة» في العقد و«متأخرة ٤٠ يوماً» في التحصيل. وتفاصيل القسط نسخةٌ ثانية من منطق الحالة.
 * القرار ٤.١٠ و٤.١١: بدالةٍ واحدة مشتركة مع شاشة التحصيل (installmentState).
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, setInstallmentSchedule } from '@/domain/contracts/service';
import * as inst from '@/domain/contracts/installments';
import { allInstallments } from '@/domain/stats';
import { initI18n } from '@/i18n';

beforeAll(() => { initI18n('ar'); });

type Badge = { label: string; kind: string };
const badgeOf = (f: inst.InstallmentFacts, T: string): Badge =>
  (inst as unknown as { installmentBadge: (f: inst.InstallmentFacts, T: string) => Badge }).installmentBadge(f, T);

const T = '2026-03-12';
test('A1-11 القسط المتأخر ٣٩ يوماً «متأخرة ٣٩ يوماً» في العقد كما في التحصيل', () => {
  const f = { dueDate: '2026-02-01', amount: 100000, paid: 0, discount: 0, status: 'مستحقة' };
  expect(badgeOf(f, T)).toEqual({ label: 'متأخرة 39 يوماً', kind: 'overdue' });
  expect(badgeOf(f, T).label).toBe(inst.installmentState(f, T).displayStatus);
});

test('A1-11 «قادمة» من الموعد المتفق عليه لا من الاستحقاق · والمهلة القائمة لا تأخير فيها', () => {
  expect(badgeOf({ dueDate: '2026-03-01', agreedDate: '2026-03-20', amount: 100000, paid: 0, discount: 0, status: 'مستحقة' }, T))
    .toEqual({ label: 'قادمة', kind: 'draft' });
  expect(badgeOf({ dueDate: '2026-04-01', amount: 100000, paid: 0, discount: 0, status: 'مستحقة' }, T).label).toBe('قادمة');
  expect(badgeOf({ dueDate: '2026-03-01', graceUntil: '2026-03-15', amount: 100000, paid: 0, discount: 0, status: 'مستحقة' }, T))
    .toEqual({ label: 'مستحقة', kind: 'due' });
});

test('A1-11 الجزئي المتأخر والمسدَّد بالخصم والملغى', () => {
  expect(badgeOf({ dueDate: '2026-02-01', amount: 100000, paid: 40000, discount: 0, status: 'مدفوعة جزئياً' }, T))
    .toEqual({ label: 'مدفوعة جزئياً · متأخرة 39 يوماً (متبقي 600.00)', kind: 'overdue' });
  expect(badgeOf({ dueDate: '2026-02-01', amount: 100000, paid: 90000, discount: 10000, status: 'مدفوعة جزئياً' }, T))
    .toEqual({ label: 'مدفوعة', kind: 'paid' });
  expect(badgeOf({ dueDate: '2026-02-01', amount: 100000, paid: 0, discount: 0, status: 'ملغية' }, T).kind).toBe('draft');
});

test('A1-11 على قسطٍ حقيقي: الشارة تطابق شاشة التحصيل', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار شارة مصطنع' }), { unit_no: 'B-11' });
  const c = confirmContract(db, contractInput(u, { tenant: 'مستأجر شارة مصطنع', idNumber: '1000001011', valueHalalas: 1200000,
    start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  const rows = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY sort`, [c]);
  setInstallmentSchedule(db, rows[2].id, { agreedDate: '2026-03-25', graceUntil: null, reason: 'موعد مصطنع' });
  const views = allInstallments(db, T);
  for (const r of rows.slice(0, 4)) {
    const v = views.find((x) => x.installmentId === r.id)!;
    const b = badgeOf({ dueDate: v.dueDate, agreedDate: v.agreedDate, graceUntil: v.graceUntil, amount: v.amount, paid: v.paid, discount: v.discount, status: v.status }, T);
    expect(b.kind === 'draft' ? v.daysLate < 0 : b.label === v.displayStatus).toBe(true);
  }
  db.close();
});

test('A1-11 جدول العقد وتفاصيل القسط بالدالة الواحدة لا بنسخةٍ ثانية', () => {
  const contracts = fs.readFileSync(path.resolve(__dirname, '..', 'app', '(tabs)', 'contracts.tsx'), 'utf8');
  const badge = contracts.slice(contracts.indexOf('const instBadge'), contracts.indexOf('const renderInst'));
  expect(badge).toMatch(/installmentBadge\(/);
  expect(badge).not.toMatch(/i\.status === 'مستحقة' && i\.due_date > today\(\)/);
  const sheet = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ui', 'InstallmentSheet.tsx'), 'utf8');
  expect(sheet).toMatch(/installmentBadge\(/);
  expect(sheet).not.toMatch(/daysBetween\(T_, effectiveDue\)/);
});
