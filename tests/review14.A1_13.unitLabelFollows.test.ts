/**
 * المراجعة الشاملة 2026-11-13 · A1-13 · منخفض · src/domain/contracts/service.ts (unit_label) · app/(tabs)/contracts.tsx ·
 * src/ui/TenantProfileSheet.tsx · بيانات مصطنعة.
 *
 * ما كان: اسم الوحدة في العقد نصٌّ محفوظ عند الحفظ «اسم العقار · رقم الوحدة» لا يتبع نقل الوحدة ولا تغيير رقمها، فبطاقة العقد وتفاصيله
 * ونافذة التجديد وملف المستأجر تعرض العقار القديم، والبحث بالرقم الجديد لا يجد العقد.
 * الإصلاح: يُشتق النص عند العرض من units وproperties (والقيود تبقى بعقارها التاريخي بحق · قرار 2026-10-09).
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import * as rules from '@/domain/contracts/rules';
import { tenantProfile } from '@/domain/tenants';
import { saveUnit } from '@/domain/propertiesService';
import { initI18n } from '@/i18n';

beforeAll(() => { initI18n('ar'); });

const labelSql = (alias: string): string =>
  (rules as unknown as { contractUnitLabelSql: (a: string) => string }).contractUnitLabelSql(alias);

test('A1-13 بعد نقل الوحدة وتغيير رقمها: العرض والبحث وملف المستأجر بالعقار والرقم الجديدين', () => {
  const db = memDb();
  const p1 = addProperty(db, { name: 'عقار قديم مصطنع' });
  const p2 = addProperty(db, { name: 'عقار جديد مصطنع' });
  const u = addUnit(db, p1, { unit_no: 'Q-1' });
  const c = confirmContract(db, contractInput(u, { tenant: 'مستأجر وحدة مصطنع', idNumber: '1000001016' }));
  expect(db.get<{ l: string }>(`SELECT unit_label AS l FROM contracts WHERE id = ?`, [c])!.l).toBe('عقار قديم مصطنع · Q-1');
  saveUnit(db, { propertyId: p2, unitNo: 'N-7', floor: 'الأرضي', type: 'سكني', subtype: '', rentMonthlyHalalas: 100000, rooms: [], meters: [] }, u);
  const shown = db.get<{ l: string }>(`SELECT ${labelSql('c.')} AS l FROM contracts c WHERE c.id = ?`, [c])!.l;
  expect(shown).toBe('عقار جديد مصطنع · N-7');
  const found = db.all<{ id: string }>(`SELECT c.id FROM contracts c WHERE ${labelSql('c.')} LIKE '%'||?||'%'`, ['N-7']).map((r) => r.id);
  expect(found).toEqual([c]);
  const tid = db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [c])!.t;
  expect(tenantProfile(db, tid, '2026-06-01')!.contracts[0].unit_label).toBe('عقار جديد مصطنع · N-7');
  // عقدٌ بلا وحدة قائمة يبقى بنصّه المحفوظ
  db.run(`UPDATE contracts SET unit_id = NULL WHERE id = ?`, [c]);
  expect(db.get<{ l: string }>(`SELECT ${labelSql('c.')} AS l FROM contracts c WHERE c.id = ?`, [c])!.l).toBe('عقار قديم مصطنع · Q-1');
  db.close();
});

test('A1-13 قائمة العقود وتفاصيله ونافذة التجديد والبحث تعرض الاسم المشتق', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', '(tabs)', 'contracts.tsx'), 'utf8');
  expect(src).not.toMatch(/c\.unit_label LIKE/);
  expect(src).not.toMatch(/\{c\.unit_label\}/);
  expect(src).not.toMatch(/\[c\.tenant_name, c\.unit_label,/);
  expect(src).toMatch(/contractUnitLabelSql\(/);
});
