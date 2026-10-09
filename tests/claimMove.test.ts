/**
 * التحقق المستقل من 9362a6f · قرار المالك 2026-10-09: «النقل بين العقارات لمن له كلها، ويُخفى عن المحصور مع سببه» ·
 * المطالبة القائمة لا ينقلها المحصور إلى عقد عقارٍ آخر (القواعد ترفضه فتنفصل نسخته بصمت) · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { saveClaim } from '@/domain/claims';
import type { Access } from '@/domain/access/access';

const restricted: Access = { owner: false, uid: 'U2', perms: { claims: 3 }, allProps: false, props: ['CP1', 'CP2'] };
const allProps: Access = { ...restricted, allProps: true, props: [] };

test('المحصور لا ينقل مطالبةً قائمة إلى عقد عقارٍ آخر · ويعدّلها في عقارها · وذو كل العقارات ينقلها', () => {
  const db = memDb();
  const p1 = addProperty(db, { id: 'CP1', name: 'عقار مطالبة أول مصطنع' });
  const p2 = addProperty(db, { id: 'CP2', name: 'عقار مطالبة ثانٍ مصطنع' });
  const c1 = confirmContract(db, contractInput(addUnit(db, p1, { unit_no: 'C-1' }), { tenant: 'مستأجر مطالبة أول مصطنع', idNumber: '1000000967', phone: '0500000967', depositHalalas: 0 }));
  const c1b = confirmContract(db, contractInput(addUnit(db, p1, { unit_no: 'C-2' }), { tenant: 'مستأجر مطالبة ثانٍ مصطنع', idNumber: '1000000975', phone: '0500000975', depositHalalas: 0 }));
  const c2 = confirmContract(db, contractInput(addUnit(db, p2, { unit_no: 'C-3' }), { tenant: 'مستأجر مطالبة ثالث مصطنع', idNumber: '1000000983', phone: '0500000983', depositHalalas: 0 }));
  const id = saveClaim(db, { contractId: c1, amountHalalas: 5000, reason: 'ضرر مصطنع', date: '2026-03-01' });
  const input = (contractId: string) => ({ contractId, amountHalalas: 5000, reason: 'ضرر مصطنع', date: '2026-03-01' });
  expect(() => saveClaim(db, input(c2), id, { access: restricted })).toThrow();
  expect(db.get(`SELECT contract_id AS c FROM claims WHERE id = ?`, [id])).toEqual({ c: c1 });
  saveClaim(db, input(c1b), id, { access: restricted });
  saveClaim(db, input(c2), id, { access: allProps });
  expect(db.get(`SELECT contract_id AS c FROM claims WHERE id = ?`, [id])).toEqual({ c: c2 });
  db.close();
});
