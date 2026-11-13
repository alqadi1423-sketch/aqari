/**
 * المتحقق المستقل على إصلاح A1-2 (المراجعة الشاملة 2026-11-13) · بيانات مصطنعة كلها.
 *
 * العيب: قيد سداد القسط من التأمين (deposit_rent) قسمه «التأمينات» (readSections.journalSection: كل ما يبدأ بـ deposit)، فيقرؤه
 *   الدفتر والتقارير والتأمينات والعقود وحدها · ودفعته «من التأمين» في contract_payments يقرؤها «التحصيل» أيضاً. فعضو التحصيل
 *   (بلا العقود ولا التأمينات) تصله الدفعة ولا يصله قيدها، فتنتظر أباها (journal_entry_id) بلا نهاية، ولا يُحسب بها القسط على
 *   جهازه · وهو العطل نفسه الذي أصلحته قراءة «قارئ المستند يقرأ قيده» (أعطال ٢٠٢٦-١٠-٠٥) لقيود التحصيل.
 * الأثر: على جهاز المحصِّل يبقى قسط مارس «مستحقاً ١٬٠٠٠» بعد أن سُدّد من التأمين في التسوية (وعلى جهاز المالك «مدفوعة»)، فشاشة
 *   التحصيل وتنبيهاتها ورسالة المطالبة تطالب المستأجر بما دفعه · وهي أعراض A1-2 نفسها، باقيةٌ لمن عمله التحصيل.
 * السلوك الصحيح: عضو التحصيل الذي تصله دفعة «من التأمين» يصله قيدها، فيُطبَّق على جهازه ويرى القسط مدفوعاً كجهاز المالك.
 *   TZ=Asia/Riyadh npx jest tests/review11.A1_2.collectMemberView.test.ts
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate, memberTokens } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract, saveDepositSettlement, recordRentPayment } from '@/domain/contracts/service';
import type { Access } from '@/domain/access/access';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';

const ORG = 'owner-a12-collect';
const OWNER: Access = { owner: true, uid: ORG, perms: {}, allProps: true, props: [] } as Access;
/** المحصِّل: التحصيل كاملاً وحده (لا العقود ولا التأمينات) */
const COLLECTOR: Access = { owner: false, uid: 'member-a12-collect', perms: { collect: 3 }, allProps: true, props: [] } as Access;

const instRows = (db: DB, cid: string) => db.all<{ due: string; status: string; paid: number }>(
  `SELECT due_date AS due, status, paid_halalas AS paid FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid])
  .map((r) => ({ due: r.due, status: r.status, paid: Number(r.paid) }));

test('A1-2 · عضو التحصيل يرى القسط المسدَّد من التأمين مدفوعاً كجهاز المالك (يصله قيد دفعته)', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, ORG);
  const u = addUnit(owner, addProperty(owner, { name: 'عقار محصِّل مصطنع' }), { unit_no: 'CM-1' });
  // عقد ثلاثة أشهر ٣٬٠٠٠ بأقساط ١٬٠٠٠ وتأمين ١٬٠٠٠ لدى المكتب · سُدّد يناير وفبراير نقداً، وغادر ولم يدفع مارس
  const cid = confirmContract(owner, contractInput(u, { tenant: 'مستأجر محصِّل مصطنع', idNumber: '1000007711', phone: '0500007711',
    valueHalalas: 300000, cycle: 'شهرية', start: '2026-01-01', end: '2026-03-31', depositHalalas: 100000 }));
  const insts = owner.all<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  for (const i of insts.slice(0, 2)) {
    recordRentPayment(owner, cid, { installmentId: i.id, period: '', date: i.due_date,
      lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  // التسوية: التأمين كله مقابل مارس غير المدفوع
  saveDepositSettlement(owner, cid, { date: '2026-04-05', deductionHalalas: 100000, deductionReason: 'إيجار مارس غير المدفوع',
    refundHalalas: 0, notes: '', arrearsHalalas: 100000 });
  await syncOnce(owner, r, getMeta(owner, 'device_id')!);
  const ownerView = instRows(owner, cid);
  expect(ownerView.map((x) => [x.status, x.paid])).toEqual([['مدفوعة', 100000], ['مدفوعة', 100000], ['مدفوعة', 100000]]);

  // ما يقرؤه المحصِّل من الحساب: رموز رؤية كل مستند كما يكتبها annotate، مقابل رموز عضويته (السحب يستعلم بها)
  const tokens = new Set(memberTokens(COLLECTOR));
  const visible = new MemoryRemote();
  for (const d of r.docs.values()) {
    const { doc, pub } = annotate(owner, { ...d } as RemoteDoc, OWNER);
    const seen = (x: RemoteDoc | null) => !!x && (x.g ?? []).some((g) => tokens.has(g));
    if (seen(doc)) visible.inject(doc);
    else if (seen(pub)) visible.inject(pub!);
  }

  const member = memDb();
  enableSync(member, COLLECTOR.uid!);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'محصِّل مصطنع' } })]);
  member.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [ORG]);
  Object.assign(visible, { memberMode: true, annotate: (db: DB, doc: never) => annotate(db, doc, COLLECTOR).doc });
  await syncOnce(member, visible, getMeta(member, 'device_id')!);
  await syncOnce(member, visible, getMeta(member, 'device_id')!);

  // الدفعتان النقديتان وصلتا بقيدَيهما · ودفعة «من التأمين» يجب أن تصل بقيدها فيُحسب بها مارس
  expect(member.all<{ m: string }>(`SELECT method_label AS m FROM contract_payments WHERE contract_id = ? ORDER BY date`, [cid]).map((x) => x.m))
    .toEqual(['نقداً', 'نقداً', 'من التأمين']);
  // على جهاز المحصِّل كجهاز المالك: مارس مدفوعٌ ١٬٠٠٠ (اليوم: «مستحقة» ٠ فيطالبه المحصِّل بما سُدّد من تأمينه)
  expect(instRows(member, cid)).toEqual(ownerView);
  owner.close();
  member.close();
});
