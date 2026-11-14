/**
 * المدقق Z2 · الجولة الثالثة عشرة · على db011e7 · علامة «تصحيح» سطر الكشف تبقى بعد أن يستهلك الواردُ التصحيح · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditZ2.stmtMark.test.ts
 *
 * Z2-7 · منخفض/متوسط · src/sync/engine.ts:1756-1757 (correction: أي واردٍ للسطر المعلَّم يغلب ولو كان أقدم) مع engine.ts:984-1000
 * (العلامة تُرفع عند الرفع وحده: engine.ts:2527) وengine.ts:1745-1748 و1913 (الوارد «المتفق» أو الغالب يحذف التصحيح من الطابور ولا يرفع
 * العلامة): العضو يحذف كشفاً · جهاز المالك يطبّق الكشف المحذوف فيحذف سطره «تصحيحاً» ويعلّمه (statementCascade)، ثم يصله مستند السطر
 * نفسه محذوفاً من العضو بالمحتوى نفسه فيُحذف التصحيح من الطابور «متفقين» وتبقى العلامة أبداً (لا رفع لهذا السطر يمحوها) · بعدها
 * يعيد المالك قراءة الملف نفسه (يحيا الكشف وسطره بمعرّفيهما) ويعتمد الإيداع تحصيلاً · وفي دورته التالية يعود إليه مستند الحذف القديم في
 * نافذة الأمان (firestore.ts:130 PULL_SAFETY_MS: كل ما كُتب في الدقيقة الأخيرة يُسحب ثانيةً) فيغلب بالعلامة تعديلَ المالك الأحدث: السطر
 * محذوفٌ في كشفٍ حيّ على الجهاز وفي السحابة، والتحصيل «في الدفاتر وحدها»، وختامي الكشف في التقرير صفرٌ بلا الإيداع.
 * وبلا العلامة يغلب تعديل المالك الأحدث كما ينبغي (الطابور المعلَّق أحدث من الوارد).
 * لماذا يهم: «التصحيح يغلبه التعديل الحقيقي» (Y٧) صار «كل واردٍ يغلب» لسطورٍ لا تصحيح لها، فيمحو مستندٌ قديمٌ معاد اعتماداً صريحاً.
 * السلوك الصحيح: العلامة تزول حين يزول تصحيحها من الطابور (بالرفع أو بوارد يستهلكه)، فيبقى السطر حيّاً مطابَقاً بحركة التحصيل.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { sync, MEMBER, UID } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync } from '@/sync/engine';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, deleteStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';
import type { Cursor } from '@/sync/types';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Z2-7 · العضو يحذف الكشف، والمالك يعيد قراءته ويعتمد الإيداع ثم يزامن مرتين في الدقيقة: السطر حيٌّ مطابَقٌ بحركة التحصيل', async () => {
  const r = new MemoryRemote();
  // المؤشر المحفوظ كما في FirestoreRemote.durableCursor: الموضع الآمن قبل وقت القراءة بستين ثانية · واختبارٌ يجري في ثوانٍ لا يتجاوزه
  // شيءٌ مما كُتب، فيُحفظ المؤشر من أوله وتعيد كل دورةٍ سحب ما كُتب في الدقيقة الأخيرة
  Object.assign(r, { durableCursor: (_c: Cursor): Cursor | null => null });
  const owner = memDb(); const m1 = memDb();
  enableSync(owner, UID); enableSync(m1, UID);
  const bank = addBank(owner, 'بنك مصطنع Z2-7', 0);
  const prop = addProperty(owner, { name: 'عقار مصطنع Z2-7' });
  confirmContract(owner, contractInput(addUnit(owner, prop, { unit_no: 'Z27-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000002701', phone: '0500002701', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const file = () => {
    const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
    if (!g.ok) throw new Error(g.error);
    return g;
  };
  const st = saveStatement(owner, bank, file(), { name: 'z27-oct.csv', hash: 'z27' });
  await sync(owner, r);
  await sync(m1, r);

  // العضو يحذف الكشف (خطأً) · وجهاز المالك يطبّق حذفه
  deleteStatement(m1, st.statementId);
  await sync(m1, r);
  const mid = getMeta(m1, 'device_id');
  for (const d of [...r.docs.values()]) if (d.dev === mid) r.inject({ ...d, by: MEMBER });
  await sync(owner, r);
  expect(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_statement_lines WHERE deleted_at IS NULL`)!.n).toBe(0);

  // المالك يعيد قراءة الملف نفسه (يحيا الكشف وسطره) ويعتمد الإيداع تحصيلاً لقسط ماجد، ثم يزامن
  await wait(5);
  saveStatement(owner, bank, file(), { name: 'z27-oct.csv', hash: 'z27' });
  const s = collectionSuggestions(owner, bank)[0];
  const { txId } = approveCollection(owner, s.line.id, s.target);
  await sync(owner, r);

  const line = owner.get<{ status: string; tx: string | null; del: string | null }>(
    `SELECT status, bank_tx_id AS tx, deleted_at AS del FROM bank_statement_lines WHERE id = ?`, [s.line.id])!;
  const cloud = r.docs.get('bank_statement_lines__' + s.line.id)!.d!;
  // (الواقع: مستند الحذف القديم المعاد في نافذة الأمان يغلب بالعلامة الباقية: السطر محذوفٌ مفتوح على جهاز المالك وفي السحابة)
  expect({ owner: line, cloud: { status: cloud.status, tx: cloud.bank_tx_id, del: cloud.deleted_at } })
    .toEqual({ owner: { status: 'matched', tx: txId, del: null }, cloud: { status: 'matched', tx: txId, del: null } });
  owner.close(); m1.close();
});
