/**
 * صلاحيات الأقسام (docs/PERMISSIONS.md) · النموذج والمسارات وكاتب المسودة
 */
import { memDb } from './helpers/testDb';
import { canAdd, canEdit, canManage, canView, level, OWNER_ACCESS, propAllowed, type Access, canMergeTenants } from '@/domain/access/access';
import { GRANTABLE, levelOf, SECTIONS, TEMPLATES } from '@/domain/access/sections';
import { normalizeRoute, ROUTE_SECTION, routeAllowed } from '@/domain/access/routes';
import { readAccess, rowBy, saveMembership } from '@/services/access';
import { setCapture, setSyncState } from '@/sync/engine';

const member = (perms: Access['perms'], extra: Partial<Access> = {}): Access =>
  ({ owner: false, uid: 'U-member', perms, allProps: true, props: [], ...extra });

describe('المستويات', () => {
  test('المالك كامل في كل قسم ومنها الأعضاء والإعدادات', () => {
    for (const s of SECTIONS) expect(level(OWNER_ACCESS, s.key)).toBe(3);
  });

  test('الأعضاء والإعدادات لا تُمنح لعضو ولو كُتبت في خريطته', () => {
    expect(level(member({ admin: 3 }), 'admin')).toBe(0);
  });

  test('لا · عرض · إدخال · كامل', () => {
    const a = member({ contracts: 0, tenants: 1, collect: 2, ledger: 3 });
    expect([canView(a, 'contracts'), canAdd(a, 'contracts'), canManage(a, 'contracts')]).toEqual([false, false, false]);
    expect([canView(a, 'tenants'), canAdd(a, 'tenants'), canManage(a, 'tenants')]).toEqual([true, false, false]);
    expect([canView(a, 'collect'), canAdd(a, 'collect'), canManage(a, 'collect')]).toEqual([true, true, false]);
    expect([canView(a, 'ledger'), canAdd(a, 'ledger'), canManage(a, 'ledger')]).toEqual([true, true, true]);
    // القسم الغائب «لا»
    expect(canView(a, 'reports')).toBe(false);
  });

  test('قسم القراءة وحدها لا يتجاوز «عرض»', () => {
    expect(levelOf({ audit: 3 }, 'audit')).toBe(1);
  });

  test('إدخال يعدّل مسودته هو وحده قبل ترحيلها · لا مسودة غيره ولا ما رُحّل', () => {
    const a = member({ contracts: 2 });
    expect(canEdit(a, 'contracts', { by: 'U-member', draft: true })).toBe(true);
    expect(canEdit(a, 'contracts', { by: 'U-other', draft: true })).toBe(false);
    expect(canEdit(a, 'contracts', { by: 'U-member', draft: false })).toBe(false);
    expect(canEdit(a, 'contracts', { by: null, draft: true })).toBe(false);
    expect(canEdit(member({ contracts: 3 }), 'contracts', { by: 'U-other', draft: false })).toBe(true);
    expect(canEdit(member({ contracts: 1 }), 'contracts', { by: 'U-member', draft: true })).toBe(false);
  });

  test('العقارات المسموحة قيدٌ فوق القسم', () => {
    const a = member({ props: 1 }, { allProps: false, props: ['P1'] });
    expect(propAllowed(a, 'P1')).toBe(true);
    expect(propAllowed(a, 'P2')).toBe(false);
    expect(propAllowed(a, null)).toBe(true);
    expect(propAllowed(OWNER_ACCESS, 'P2')).toBe(true);
  });
});

describe('القوالب', () => {
  test('فني الصيانة: الوحدة عرضاً والصيانة إدخالاً ولا مبالغ ولا عقود', () => {
    const tech = member(TEMPLATES.find((t) => t.key === 'tech')!.perms);
    expect(level(tech, 'props')).toBe(1);
    expect(level(tech, 'maintenance')).toBe(2);
    for (const k of ['contracts', 'collect', 'deposits', 'reports', 'ledger', 'banks'] as const) expect(canView(tech, k)).toBe(false);
  });

  test('المدير كامل في كل ما يُمنح ولا يبلغ الأعضاء والإعدادات', () => {
    const mgr = member(TEMPLATES.find((t) => t.key === 'manager')!.perms);
    for (const s of GRANTABLE) expect(level(mgr, s.key)).toBe(s.max);
    expect(level(mgr, 'admin')).toBe(0);
  });
});

describe('المسارات', () => {
  test('مسار (tabs) يُطبَّع', () => {
    expect(normalizeRoute('/(tabs)/contracts')).toBe('/contracts');
    expect(normalizeRoute('/(tabs)')).toBe('/');
    expect(normalizeRoute('/journal/')).toBe('/journal');
  });

  test('الرابط المباشر لقسمٍ «لا» لا يُفتح · والمسار المجهول للمالك وحده', () => {
    const a = member({ collect: 2 });
    expect(routeAllowed(a, '/collect')).toBe(true);
    expect(routeAllowed(a, '/journal')).toBe(false);
    expect(routeAllowed(a, '/settings')).toBe(true);
    expect(routeAllowed(a, '/perf')).toBe(false);
    expect(routeAllowed(a, '/route-not-in-table')).toBe(false);
    expect(routeAllowed(OWNER_ACCESS, '/route-not-in-table')).toBe(true);
  });

  test('كل شاشة في التطبيق لها قسم', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const app = path.join(__dirname, '..', 'app');
    const screens = [
      ...fs.readdirSync(app).filter((f) => f.endsWith('.tsx') && !f.startsWith('_')).map((f) => '/' + f.replace('.tsx', '')),
      ...fs.readdirSync(path.join(app, '(tabs)')).filter((f) => f.endsWith('.tsx') && !f.startsWith('_')).map((f) => '/' + f.replace('.tsx', '')),
    ];
    for (const s of screens) expect([s, s in ROUTE_SECTION]).toEqual([s, true]);
  });
});

describe('عضوية الجهاز', () => {
  test('بلا عضوية: المالك · والعضوية التالفة لا تفتح شيئاً', () => {
    const db = memDb();
    expect(readAccess(db).owner).toBe(true);
    setSyncState(db, 'membership', '{not json');
    const a = readAccess(db);
    expect(a.owner).toBe(false);
    for (const s of SECTIONS) expect(canView(a, s.key)).toBe(false);
  });

  test('العضوية تُقرأ كما حُفظت والمستوى الغريب يسقط', () => {
    const db = memDb();
    saveMembership(db, { org: 'OWNER', uid: 'U-member', perms: { collect: 2, ledger: 9 as never }, allProps: false, props: ['P1'] });
    const a = readAccess(db);
    expect(a.owner).toBe(false);
    expect(level(a, 'collect')).toBe(2);
    expect(level(a, 'ledger')).toBe(0);
    expect(a.props).toEqual(['P1']);
    saveMembership(db, null);
    expect(readAccess(db).owner).toBe(true);
  });
});

describe('الهجرة ٢٢ · كاتب المسودة', () => {
  const insertContract = (db: ReturnType<typeof memDb>, id: string) => {
    db.run(`INSERT OR IGNORE INTO properties (id,name,created_at) VALUES ('P1','برج الاختبار','x')`);
    db.run(`INSERT OR IGNORE INTO units (id,property_id,unit_no,created_at) VALUES ('U1','P1','A-1','x')`);
    db.run(`INSERT INTO contracts (id,tenant_name,unit_id,value_halalas,start,end,deposit_halalas,status,created_at)
            VALUES (?,'مستأجر تجريبي','U1',100000,'2026-01-01','2026-12-31',0,'مسودة','x')`, [id]);
  };

  test('الإنشاء المحلي بعد الدخول يُنسب لصاحب الجهاز', () => {
    const db = memDb();
    setSyncState(db, 'uid', 'U-member');
    setCapture(db, true);
    insertContract(db, 'C1');
    expect(rowBy(db, 'contracts', 'C1')).toBe('U-member');
  });

  test('الوارد من المزامنة (الالتقاط مطفأ) لا يُنسب لصاحب الجهاز', () => {
    const db = memDb();
    setSyncState(db, 'uid', 'U-member');
    setCapture(db, false);
    insertContract(db, 'C2');
    expect(rowBy(db, 'contracts', 'C2')).toBeNull();
  });
});

test('دمج المستأجرين لمن له القسم كاملاً في كل العقارات وحده (المحصور يُرفض دمجه صامتاً في السحابة)', () => {
  const m = (all: boolean, lvl: 1 | 2 | 3) => ({ owner: false, uid: 'u1', perms: { tenants: lvl }, allProps: all, props: all ? [] : ['P1'] }) as never;
  expect(canMergeTenants(OWNER_ACCESS)).toBe(true);
  expect(canMergeTenants(m(true, 3))).toBe(true);
  expect(canMergeTenants(m(false, 3))).toBe(false);
  expect(canMergeTenants(m(true, 2))).toBe(false);
});

