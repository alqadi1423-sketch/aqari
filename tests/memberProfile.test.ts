/**
 * بيانات العضو (توجيه المالك ٢٠٢٦-١٠-٠٥ · ثانياً) · الاسم والجوال إلزاميان، والهوية والمسمى اختياريان،
 * والجوال سعودي موحَّد، والهوية عشرة أرقام أولها ١ أو ٢. بيانات مصطنعة.
 */
import { validateProfile, profileIncomplete, normalizeNid } from '@/domain/access/profile';

describe('التحقق من بيانات العضو', () => {
  test('ملف كامل يُوحَّد: الجوال بكل صيغه والهوية بالأرقام العربية', () => {
    const r = validateProfile({ name: '  عضو   تجريبي ', phone: '+966 50 000 0101', nid: '١٠٠٠٠٠٠٠١٧', title: 'محاسب' }, true);
    expect(r).toEqual({ ok: true, profile: { name: 'عضو تجريبي', phone: '0500000101', nid: '1000000017', title: 'محاسب' } });
  });

  test('الاسم والجوال إلزاميان عند الإكمال', () => {
    expect(validateProfile({ phone: '0500000101' }, true)).toMatchObject({ ok: false, field: 'name' });
    expect(validateProfile({ name: 'عضو تجريبي' }, true)).toMatchObject({ ok: false, field: 'phone' });
  });

  test('عند الدعوة يجوز ترك الملف كله ليكمله العضو', () => {
    expect(validateProfile({}, false)).toEqual({ ok: true, profile: { name: '', phone: '', nid: '', title: '' } });
  });

  test('جوال غير سعودي يُرفض', () => {
    expect(validateProfile({ name: 'عضو تجريبي', phone: '0400000000' }, true)).toMatchObject({ ok: false, field: 'phone' });
    expect(validateProfile({ name: 'عضو تجريبي', phone: '05000001' }, true)).toMatchObject({ ok: false, field: 'phone' });
  });

  test.each([['3000000000'], ['100000000'], ['10000000001'], ['10000-0000x']])('هوية غير صحيحة %s تُرفض', (nid) => {
    expect(validateProfile({ name: 'عضو تجريبي', phone: '0500000101', nid }, true)).toMatchObject({ ok: false, field: 'nid' });
  });

  test('الهوية بمسافات أو شرطات تُوحَّد', () => {
    expect(normalizeNid('2 000 000-013')).toBe('2000000013');
  });

  test('ينقصه ما يلزم', () => {
    expect(profileIncomplete(null)).toBe(true);
    expect(profileIncomplete({ name: 'عضو تجريبي', phone: '' })).toBe(true);
    expect(profileIncomplete({ name: 'عضو تجريبي', phone: '0500000101' })).toBe(false);
  });
});

describe('منفّذ العملية في سجل العمليات', () => {
  test('العضو باسمه الكامل · والمالك «المالك» · وبلا حساب «مستخدم»', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { logAudit } = await import('@/domain/audit');
    const { setSyncState } = await import('@/sync/engine');
    const db = memDb();
    const last = () => db.get<{ u: string }>(`SELECT user_name AS u FROM audit_log ORDER BY rowid DESC LIMIT 1`)!.u;
    logAudit(db, 'اختبار', 'create', 'بند', 'أ');
    expect(last()).toBe('مستخدم');
    setSyncState(db, 'uid', 'OWNER1'); setSyncState(db, 'org', 'OWNER1');
    logAudit(db, 'اختبار', 'create', 'بند', 'ب');
    expect(last()).toBe('المالك');
    setSyncState(db, 'uid', 'MEM1');
    setSyncState(db, 'membership', JSON.stringify({ org: 'OWNER1', uid: 'MEM1', perms: {}, allProps: true, props: [], profile: { name: 'عضو تجريبي', phone: '0500000101', nid: '', title: 'محاسب' } }));
    logAudit(db, 'اختبار', 'create', 'بند', 'ج');
    expect(last()).toBe('عضو تجريبي');
  });
});
