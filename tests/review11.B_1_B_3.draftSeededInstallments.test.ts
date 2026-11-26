/**
 * المدقق المستقل على إصلاح B-1 (ب) · عالٍ · src/sync/engine.ts: lockedParentIssue (فرع contract_installments: «if (!c || c.s ===
 * DRAFT_CONTRACT) return ''») · src/domain/contracts/service.ts: confirmContract («hasInstallments» فلا يُولَّد الجدول)
 *
 * السيناريو (بيانات مصطنعة): المالك حفظ مسودة عقدٍ لوحدةٍ في عقاره وزامنها (المسودة بلا أقساط). عضوٌ له «إدخال» العقود في العقار نفسه
 * يكتب في السحابة قسطاً واحداً لهذه المسودة بهللةٍ واحدة، بمستنده كما يبنيه جهازه (annotate). القواعد تقبله (إنشاء جدولٍ يملكه القسم
 * بإدخال في عقاره)، وجهاز المالك يقبله لأن العقد عنده «مسودة». ثم يؤكّد المالك مسودته: confirmContract يجد للعقد أقساطاً فلا يولّد
 * جدوله، فيصير جدول العقد المؤكَّد قسطَ العضو وحده (هللة واحدة بدل ١٢ قسطاً بقيمة العقد).
 *
 * لماذا يهم: هذا ما يسدّه B-1 (ب) نفسه، «أقساطٌ لم تتفق عليها مع المستأجر» في عقدٍ ليس للعضو، بأدنى مستوى كتابة، وبلا رفضٍ يظهر في حالة
 * المزامنة. والتقرير (B-المزامنة-والصلاحيات.md · B-1 · الإصلاح ٢) يقبل القسط الجديد لعقدٍ «مسودة كاتبُه هو» وحده، وقرار المالك 2026-10-04:
 * «صاحب إدخال يعدّل مسودته هو فقط، ولا يعدّل مسودة غيره». والإصلاح يقبل قسط أي عضوٍ لأي مسودة.
 *
 * السلوك الصحيح: قسطٌ من عضوٍ لمسودةٍ ليست له يُرفض على جهاز المالك (ويُرفع شاهد حذفه)، أو لا يدخل جدول العقد عند تأكيده بأي طريق ·
 * فجدول العقد بعد تأكيد المالك هو ما يولّده التطبيق (١٢ قسطاً مجموعها قيمة العقد) بلا قسط العضو.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { saveDraft, confirmContract } from '@/domain/contracts/service';
import type { Access } from '@/domain/access/access';
import type { RemoteDoc } from '@/sync/types';

test('B-1 (ب) · قسطٌ يزرعه عضو «إدخال» في مسودة المالك لا يصير جدول العقد عند تأكيده', async () => {
  const db = memDb();
  const r = new MemoryRemote();
  enableSync(db, 'OWNER-R11S');
  const dev = getMeta(db, 'device_id')!;
  const p = addProperty(db, { name: 'عقار مصطنع' });
  const u = addUnit(db, p, { unit_no: 'R11S-1' });
  const input = contractInput(u, { tenant: 'مستأجر مصطنع س', idNumber: '1000000501', phone: '0555550501' });
  const draft = saveDraft(db, input as never);
  await syncOnce(db, r, dev);
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_installments WHERE contract_id = ?`, [draft])!.n).toBe(0);

  // عضو «إدخال» العقود في العقار نفسه · مستنده كما يبنيه جهازه
  const m: Access = { owner: false, uid: 'MEMBER-R11S', perms: { contracts: 2 }, allProps: false, props: [p] };
  const k = 'R11S-SEED';
  const seed = annotate(db, {
    id: 'contract_installments__' + k, t: 'contract_installments', k, u: new Date().toISOString(), dev: 'DEV-M', del: false,
    d: { id: k, contract_id: draft, due_date: '2026-01-01', amount_halalas: 1, status: 'مستحقة', sort: 0 },
  } as RemoteDoc, m).doc;
  expect(seed).toMatchObject({ op: 'contracts', by: 'MEMBER-R11S' });
  await r.write([seed]);
  await syncOnce(db, r, dev);
  await syncOnce(db, r, dev);

  // المالك يؤكّد مسودته كما تفعل الشاشة
  confirmContract(db, input as never, draft);
  const insts = db.all<{ id: string; amount_halalas: number }>(
    `SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY sort`, [draft]);
  // eslint-disable-next-line no-console
  console.log('B-1 (ب) مسودة مزروعة · أقساط العقد بعد التأكيد:', insts.length, insts.slice(0, 2));
  expect(insts.some((i) => i.id === k)).toBe(false);
  expect(insts.length).toBe(12);
  expect(insts.reduce((s, i) => s + Number(i.amount_halalas), 0)).toBe(input.valueHalalas);
  db.close();
});
