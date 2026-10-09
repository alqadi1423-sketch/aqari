/**
 * دراسة القائم (2026-10-09) · إصلاح فوري بقرار المالك: «حماية الحسابات النظامية» · الحساب النظامي (is_system) لا يُحذف ولا يتغيّر
 * نوعه، فلا يفشل أول ترحيلٍ عليه، ويُعدَّل اسمه وحده · وغير النظامي كما كان · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { saveAccount, deleteAccount } from '@/domain/accounting/chart';

test('الحساب النظامي لا يُحذف ولا يتغيّر نوعه ويُعدَّل اسمه · وغير النظامي يُحذف', () => {
  const db = memDb();
  const sys = db.get<{ code: string; name: string; type: string }>(`SELECT code, name, type FROM accounts WHERE is_system = 1 AND code = '5900'`)!;
  expect(() => deleteAccount(db, sys.code)).toThrow();
  expect(() => saveAccount(db, { code: sys.code, name: sys.name, type: 'إيراد', openingHalalas: 0 }, sys.code)).toThrow();
  saveAccount(db, { code: sys.code, name: 'فروق تقريب مصطنعة', type: sys.type, openingHalalas: 0 }, sys.code);
  expect(db.get(`SELECT name, type, deleted_at AS d FROM accounts WHERE code = ?`, [sys.code])).toEqual({ name: 'فروق تقريب مصطنعة', type: sys.type, d: null });
  saveAccount(db, { code: '5950', name: 'حساب مصطنع', type: 'مصروف', openingHalalas: 0 });
  deleteAccount(db, '5950');
  expect(db.get<{ d: string | null }>(`SELECT deleted_at AS d FROM accounts WHERE code = '5950'`)!.d).not.toBeNull();
  db.close();
});
