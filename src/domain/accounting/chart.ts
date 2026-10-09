/**
 * دليل الحسابات: الإضافة والتعديل والحذف · الحساب النظامي (is_system) لا يُحذف ولا يتغيّر نوعه، فلا يفشل أول ترحيلٍ عليه،
 * ويُعدَّل اسمه وحده (دراسة القائم 2026-10-09 · إصلاح فوري بقرار المالك) · والمستخدَم في قيدٍ لا يتغيّر نوعه ولا يُحذف.
 */
import type { DB } from '../../db/adapter';
import { logAudit } from '../audit';
import { t } from '../../i18n';

export interface AccountInput { code: string; name: string; type: string; openingHalalas: number }

export const isSystemAccount = (db: DB, code: string): boolean =>
  !!db.get(`SELECT 1 FROM accounts WHERE code = ? AND is_system = 1`, [code]);

const usedCount = (db: DB, code: string): number =>
  Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_lines WHERE account_code = ?`, [code])?.n ?? 0);

export function saveAccount(db: DB, input: AccountInput, editingCode?: string): void {
  const name = input.name.trim(), code = input.code.trim();
  if (!name || !code) throw new Error(t('accounts.required'));
  db.transaction(() => {
    if (editingCode) {
      const acc = db.get<{ type: string }>(`SELECT type FROM accounts WHERE code = ?`, [editingCode]);
      if (!acc) throw new Error(t('accounts.notFound'));
      if (acc.type !== input.type && isSystemAccount(db, editingCode)) throw new Error(t('accounts.systemType'));
      const used = usedCount(db, editingCode) > 0;
      if (used && acc.type !== input.type) throw new Error(t('accounts.usedType'));
      db.run(`UPDATE accounts SET name = ?, type = ?${used ? '' : ', opening_halalas = ?'} WHERE code = ?`,
        used ? [name, input.type, editingCode] : [name, input.type, input.openingHalalas, editingCode]);
    } else {
      if (db.get(`SELECT code FROM accounts WHERE code = ?`, [code])) throw new Error(t('accounts.codeTaken', { code }));
      db.run(`INSERT INTO accounts (code, name, type, opening_halalas, created_at) VALUES (?,?,?,?,?)`,
        [code, name, input.type, input.openingHalalas, new Date().toISOString()]);
    }
    logAudit(db, t('accounts.auditModule', { lng: 'ar' }), editingCode ? 'update' : 'create', t('accounts.auditEntity', { lng: 'ar' }), name);
  });
}

/** يعيد سبب منع الحذف، أو null إن جاز */
/**
 * فرق الأرصدة الافتتاحية (مراجعة التثبيت #60 · قرار المالك 2026-10-07: «يُحفظ ويظهر الفرق»): مدينها (الأصول والمصروفات
 * وافتتاحيات البنوك، وهي خارج الدفتر حتى تُسجَّل فيه) ناقص دائنها (الخصوم وحقوق الملكية والإيرادات) · صفرٌ إن توازنت
 */
export function openingDifference(db: DB): number {
  const acc = Number(db.get<{ d: number }>(
    `SELECT COALESCE(SUM(CASE WHEN type IN (?, ?) THEN opening_halalas ELSE -opening_halalas END), 0) AS d
     FROM accounts WHERE deleted_at IS NULL`, ['أصل', 'مصروف'])?.d ?? 0); // i18n-exempt: أنواع الحسابات المخزّنة
  let banks = 0;
  try {
    banks = Number(db.get<{ b: number }>(`SELECT COALESCE(SUM(opening_halalas), 0) AS b FROM banks WHERE deleted_at IS NULL`)?.b ?? 0);
  } catch { /* قاعدة بلا جدول البنوك */ }
  return acc + banks;
}

export function deleteBlocker(db: DB, code: string): string | null {
  if (isSystemAccount(db, code)) return t('accounts.systemDelete');
  const n = usedCount(db, code);
  return n ? t('accounts.usedDelete', { count: n }) : null;
}

export function deleteAccount(db: DB, code: string): void {
  const why = deleteBlocker(db, code);
  if (why) throw new Error(why);
  db.transaction(() => {
    db.run(`UPDATE accounts SET deleted_at = ? WHERE code = ?`, [new Date().toISOString(), code]);
    logAudit(db, t('accounts.auditModule', { lng: 'ar' }), 'delete', t('accounts.auditEntity', { lng: 'ar' }), code);
  });
}
