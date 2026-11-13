/**
 * إصلاح المراجع المعاكس الرابع على R12-BAK-2 · سطر الاعتماد (KEPT_FOREIGN_ENTITY · orphans.ts: foreignAuditIds) · ضابطٌ لسلسلة الاعتمادات ·
 * بيانات مصطنعة بلا مبالغ.
 * اعتماد استعادةٍ يسمّي ما ضمّه من السحابة ويُبنى عليه حكم المراجعة (علامة، وحفظ مستندٍ أعاد ترحيل قيوده، وسطر اعتمادٍ سابق) فلا يعمل ·
 *   وسطر الاعتماد نفسه يضمّه اعتمادٌ لاحق لنسخةٍ من خطٍّ آخر فيسمّيه: فلا يعمل هو، ويعود ما سمّاه وحده نافذاً (علامةٌ في تلك النسخة
 *   نفسها سمّاها اعتمادٌ في خطٍّ لم تَعُد إليه البيانات).
 *   TZ=Asia/Riyadh npx jest tests/review12.r4.foreignChain.test.ts
 */
import { memDb } from './helpers/testDb';
import { logAudit } from '@/domain/audit';
import {
  KEPT_REVIEW_ENTITY, KEPT_FOREIGN_ENTITY, REPOSTED_KEY, foreignAuditIds, foreignReviewRows, recordForeignReview,
} from '@/domain/accounting/orphans';
import type { DB } from '@/db/adapter';

const lastId = (db: DB, type: string) => db.get<{ id: string }>(`SELECT id FROM audit_log WHERE entity_type = ? ORDER BY rowid DESC LIMIT 1`, [type])!.id;

test('سطر الاعتماد يُبطل ما سمّاه، وسطر اعتمادٍ سمّاه اعتمادٌ لاحق لا يعمل فيعود ما سمّاه نافذاً', () => {
  const db = memDb();
  logAudit(db, 'النسخ الاحتياطي', 'create', KEPT_REVIEW_ENTITY, 'ق-1', undefined, { id: 'entry-1', no: 'ق-1', reason: 'مصطنع', saves: [] });
  const mark = lastId(db, KEPT_REVIEW_ENTITY);
  expect(foreignAuditIds(db)).toEqual([]);

  recordForeignReview(db, [mark]);
  const first = lastId(db, KEPT_FOREIGN_ENTITY);
  expect(foreignAuditIds(db)).toEqual([mark]);

  recordForeignReview(db, [first]);
  expect(foreignAuditIds(db)).toEqual([first]);
  // ولا سطر بلا شيء يسمّيه
  recordForeignReview(db, []);
  expect(db.get(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = ?`, [KEPT_FOREIGN_ENTITY])).toEqual({ n: 2 });
});

test('ما يُسمّى عند الاعتماد: العلامة وحفظ المستند الذي أعاد ترحيل قيوده وسطر الاعتماد · لا غيرها ولا نصّاً تالفاً', () => {
  const row = (id: string, entity_type: string, after_json: string | null) => ({ k: id, d: { id, entity_type, after_json } });
  expect(foreignReviewRows([
    row('a1', KEPT_REVIEW_ENTITY, JSON.stringify({ id: 'e1' })),
    row('a2', KEPT_FOREIGN_ENTITY, JSON.stringify({ ids: ['x'] })),
    row('a3', 'تعديل تسوية تأمين', JSON.stringify({ deduction_halalas: 0, [REPOSTED_KEY]: 'contract-1' })),
    row('a4', 'مطالبة', JSON.stringify({ [REPOSTED_KEY]: 'claim-1' })),
    row('b1', 'تعديل تسوية تأمين', JSON.stringify({ deduction_halalas: 0 })),
    row('b2', 'مطالبة', '{"' + REPOSTED_KEY + '": تالف'),
    row('b3', 'إلغاء عقد', null),
  ])).toEqual(['a1', 'a2', 'a3', 'a4']);
});
