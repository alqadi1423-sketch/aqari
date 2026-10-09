/**
 * دراسة القائم · قرار المالك 2026-10-09 (أولاً ٥): «سجل العمليات: تسجيل منح الصلاحيات وإزالة العضو، وحذف عضوية الحساب
 * المحذوف» · الدعوة ومنح الصلاحية وتعديلها والإزالة وإلغاء الدعوة سطورٌ بمنفّذها، والهوية لا تُكتب · بيانات مصطنعة.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { addProperty } from './helpers/fixtures';
import { logMemberAccess } from '@/domain/memberAudit';

const doc = (over: Partial<{ perm: Record<string, number>; all: boolean; props: string[] }> = {}) => ({
  email: 'member-audit@example.test', perm: { collect: 2 }, all: false, props: [] as string[], nid: '1000000900', ...over,
});

test('الدعوة والمنح والإزالة وإلغاء الدعوة في سجل العمليات بأقسامها وعقاراتها · بلا هوية', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار سجل مصطنع' });
  logMemberAccess(db, 'invite', 'member-audit@example.test', null, doc({ props: [p] }));
  logMemberAccess(db, 'grant', 'member-audit@example.test', doc({ props: [p] }), doc({ perm: { collect: 3 }, all: true }));
  logMemberAccess(db, 'remove', 'member-audit@example.test', doc({ all: true }), null);
  logMemberAccess(db, 'revoke', 'other-audit@example.test', doc(), null);
  const rows = db.all<{ module: string; action_type: string; entity_type: string; entity_name: string; before_json: string | null; after_json: string | null }>(
    `SELECT module, action_type, entity_type, entity_name, before_json, after_json FROM audit_log ORDER BY rowid`);
  expect(rows.map((r) => [r.action_type, r.entity_name])).toEqual([
    ['create', 'member-audit@example.test'], ['update', 'member-audit@example.test'],
    ['delete', 'member-audit@example.test'], ['delete', 'other-audit@example.test'],
  ]);
  expect(new Set(rows.map((r) => r.module)).size).toBe(1);
  expect(rows[0].after_json).toContain('عقار سجل مصطنع');
  expect(rows[1].before_json).not.toEqual(rows[1].after_json);
  expect(rows.map((r) => (r.before_json ?? '') + (r.after_json ?? '')).join('')).not.toContain('1000000900');
  db.close();
});

test('منح الصلاحية بلا تغيير لا يكتب سطراً', () => {
  const db = memDb();
  logMemberAccess(db, 'grant', 'member-audit@example.test', doc(), doc());
  expect(db.get(`SELECT COUNT(*) AS n FROM audit_log`)).toEqual({ n: 0 });
  db.close();
});

test('الخدمة تسجّل كل عملية عضوية · و«حذف حسابي» من العضو يحذف مستند عضويته', () => {
  const cloud = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'cloud.ts'), 'utf8');
  const fn = (name: string) => {
    const i = cloud.indexOf('export async function ' + name + '(');
    expect(i).toBeGreaterThan(-1);
    return cloud.slice(i, cloud.indexOf('\n}\n', i));
  };
  expect(fn('inviteMemberNow')).toContain("logMemberAccess(db, 'invite'");
  expect(fn('updateMemberNow')).toContain("logMemberAccess(db, 'grant'");
  expect(fn('removeMemberNow')).toContain("logMemberAccess(db, 'remove'");
  expect(fn('revokeInviteNow')).toContain("logMemberAccess(db, 'revoke'");
  expect(fn('deleteMyAccount')).toMatch(/leaveOrg\(/);
});
