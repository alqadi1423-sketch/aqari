/**
 * المراجع المعاكس الثالث على تعارض R12-DEP-2 مع R12-BAK-2 · reverseDepositRent يعكس «قيد سدادٍ من التأمين بلا دفعةٍ حيّة» (service.ts) ·
 * بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * السيناريو: عقد ثلاثة أشهر بأقساط ١٬٠٠٠ وتأمين ١٬٠٠٠ نقداً · سُدّد يناير وفبراير نقداً وبقي مارس · سوّى المالك التأمين: كله مقابل مارس
 *   (دفعة «من التأمين» P وقيدها E) · مزامنة · ثم يعدّل عضوٌ بقسم «التأمينات» وحده التسوية إلى ردّ التأمين كله.
 *   عضو التأمينات يقرأ قيود التأمين (ومنها E) ولا يقرأ الدفعات ولا الأقساط (readSections.ts: contract_payments لـ collect/contracts/
 *   reports/ledger) · فعلى جهازه كل قيد سدادٍ من التأمين «بلا دفعةٍ حيّة»، والحلقة الجديدة في reverseDepositRent تعكس E ولا تلغي P.
 * على جهاز المالك: يُقبل العاكس (depositRentEdit: صفّ التسوية معه) ولا يُلغى P، فلا شيء يصلحه (إصلاح Z١-١ وZ٢-٢ يجري حين تصل الدفعة
 *   نفسها، والعضو لم يكتبها) · فمارس «مدفوعة» بدفعةٍ حيّة قيدها معكوس، والتأمين مردودٌ كله ومستعملٌ في مارس معاً في المستندات.
 * والحال نفسها لعضوٍ بقسمي التحصيل والتأمينات تتأخر عنده الدفعة P عن قيدها E (الكتابة إلى السحابة غير ذرية، ودفعات الرفع): يعدّل
 *   التسوية قبل وصول P فتعكس الحلقة E · ثم تصل P فيلغيها إصلاح Z١-١ على جهازه وحده (الإصلاح يرفعه جهاز المالك، لا العضو) · فيفترق الجهازان.
 *   (وقبل هذا التغيير كان E يبقى حيّاً مع الردّ فيُصرف التأمين مرتين في الدفتر: 2400 = −١٬٠٠٠ و4200 = ٣٬٠٠٠ · الحالان معيبتان.)
 *   (ورقة التسوية تحت مسار العقود فتلزمها رؤية العقود (routes.ts)، فالحالة الأولى لا تُبلغ من الواجهة اليوم وإن أجازها المجال وصلاحية
 *   الكتابة (opWrites.ts: deposits) · والثانية تُبلغ بتأخر وصول الدفعة، وفيها يفترق الجهازان: العضو ألغى الدفعة والمالك لم يلغها.)
 * الصحيح: ما قرره تعديل التسوية: مارس مستحقٌ ودفعته ملغاةٌ بعاكس قيدها · 2400 = ١٬٠٠٠ − ١٬٠٠٠ ردّ = ٠ · 4200 = ٢٬٠٠٠ ·
 *   1100 = ٢٬٠٠٠ + ١٬٠٠٠ − ١٬٠٠٠ = ٢٬٠٠٠ · والفحوص خضراء.
 *   TZ=Asia/Riyadh npx jest tests/review12.r3.depositsMemberOrphanRev.test.ts
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { holdBack } from './helpers/rederive';
import { enableSync, syncOnce, setSyncState } from '@/sync/engine';
import { annotate, memberTokens } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract, saveDepositSettlement, recordRentPayment } from '@/domain/contracts/service';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { DEPOSIT_RENT_METHOD } from '@/domain/contracts/installments';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteStore, RemoteDoc } from '@/sync/types';

const OWNER = 'OWNER-R12-R3-DMO';
const OWNER_ACCESS: Access = { owner: true, uid: OWNER, perms: {}, allProps: true, props: [] } as Access;
const dev = (db: DB) => getMeta(db, 'device_id')!;

/** العضو يسحب ما تقرؤه رموز عضويته وحدها (كقواعد Firestore: السحب يستعلم برموز الرؤية) · رموز المستند كما يكتبها annotate */
async function joinMember(r: MemoryRemote, a: Access, owner: DB) {
  const tokens = new Set(memberTokens(a));
  const seen = (x: RemoteDoc | null | undefined) => !!x && (x.g ?? []).some((g) => tokens.has(g));
  const pull: RemoteStore['pull'] = async (c, l) => {
    const page = await r.pull(c, l);
    const docs: RemoteDoc[] = [];
    for (const d of page.docs) {
      const { doc, pub } = annotate(owner, { ...d } as RemoteDoc, OWNER_ACCESS);
      if (seen(doc)) docs.push(d);
      else if (seen(pub)) docs.push(pub!);
    }
    return { ...page, docs };
  };
  const db = memDb();
  enableSync(db, a.uid!);
  db.run(`DELETE FROM sync_outbox`);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: OWNER, profile: { name: 'عضو مصطنع' } })]);
  setSyncState(db, 'org', OWNER);
  const remote: RemoteStore = {
    pull, write: (d) => r.write(d), clockSample: () => r.clockSample(),
    reserveBlocks: (q) => r.reserveBlocks(q), takeInvoiceSeq: (f) => r.takeInvoiceSeq(f), memberMode: true,
    annotate: (d, doc) => annotate(d, doc, a).doc,
  };
  await syncOnce(db, remote, dev(db));
  return { db, sync: () => syncOnce(db, remote, dev(db)) };
}

const view = (db: DB, cid: string) => ({
  insts: db.all<{ p: number; s: string }>(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid])
    .map((x) => [Number(x.p), x.s]),
  depositRentLive: Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE contract_id = ? AND method_label = ?
    AND cancelled_at IS NULL`, [cid, DEPOSIT_RENT_METHOD])!.n),
  c2400: accountBalance(db, '2400'), c4200: accountBalance(db, '4200'), c1100: accountBalance(db, '1100'),
  red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
  rejects: db.all(`SELECT tbl, reason FROM sync_rejects`),
});

test.each([
  { name: 'عضو «التأمينات» وحده (لا يقرأ الدفعات)', perms: { deposits: 3 }, late: false },
  { name: 'عضو التحصيل والتأمينات تتأخر عنده دفعة «من التأمين» عن قيدها', perms: { collect: 3, deposits: 3 }, late: true },
])('$name يعدّل تسويةً سدّدت قسطاً إلى ردٍّ كامل: يُلغى سداد القسط على جهاز المالك ولا تبقى دفعته حيّة بقيدٍ معكوس', async ({ perms, late }) => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, OWNER);
  const u = addUnit(owner, addProperty(owner, { name: 'عقار عضو التأمينات المصطنع' }), { unit_no: late ? 'R3D-2' : 'R3D-1' });
  const cid = confirmContract(owner, contractInput(u, { tenant: 'مستأجر عضو التأمينات المصطنع', idNumber: late ? '1000013002' : '1000013001',
    phone: late ? '0500013002' : '0500013001', valueHalalas: 300_000, cycle: 'شهرية', start: '2026-01-01', end: '2026-03-31', depositHalalas: 100_000 }));
  for (const i of owner.all<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).slice(0, 2)) {
    recordRentPayment(owner, cid, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100_000 }], discountHalalas: 0, notes: '' });
  }
  saveDepositSettlement(owner, cid, { date: '2026-04-05', deductionHalalas: 100_000, deductionReason: 'إيجار مارس غير المدفوع',
    refundHalalas: 0, notes: '', arrearsHalalas: 100_000 });
  await syncOnce(owner, r, dev(owner));
  // قبل التعديل: مارس مدفوع من التأمين · 2400 = ١٬٠٠٠ − ١٬٠٠٠ = ٠ · 4200 = ٣٬٠٠٠ · 1100 = ٢٬٠٠٠ + ١٬٠٠٠ = ٣٬٠٠٠
  expect(view(owner, cid)).toMatchObject({ depositRentLive: 1, c2400: 0, c4200: 300_000, c1100: 300_000, red: [] });

  const held = late ? holdBack(r, (d) => d.t === 'contract_payments' && d.d?.method_label === DEPOSIT_RENT_METHOD) : null;
  const m = await joinMember(r, { owner: false, uid: 'M-R12-R3-DMO', perms, allProps: true, props: [] } as Access, owner);
  // على جهاز العضو قيد السداد E وليست دفعته P
  expect([m.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE src_type = 'deposit_rent'`)!.n,
    m.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE method_label = ?`, [DEPOSIT_RENT_METHOD])!.n]).toEqual([1, 0]);
  saveDepositSettlement(m.db, cid, { date: '2026-04-05', deductionHalalas: 0, deductionReason: '', refundHalalas: 100_000, notes: '', arrearsHalalas: 0 });
  held?.release();
  for (let i = 0; i < 3; i++) { await m.sync(); await syncOnce(owner, r, dev(owner)); }

  // الصحيح: مارس مستحق ودفعته ملغاة · 2400 = ٠ · 4200 = ٢٬٠٠٠ · 1100 = ٣٬٠٠٠ − ١٬٠٠٠ ردّ = ٢٬٠٠٠ · والفحوص خضراء
  // اليوم: P حيّة على جهاز المالك ومارس «مدفوعة» ١٬٠٠٠ وقيدها معكوس · «كل دفعة محصَّلة لها قيد مرحّل (1 بلا قيد)»
  // (وعضو التحصيل يتفق مع المالك على مارس ودفعته: على جهازه ألغى إصلاحُ Z١-١ الدفعةَ حين وصلت، ولا يرفع الإصلاحَ إلا جهاز المالك)
  const want = { insts: [[100_000, 'مدفوعة'], [100_000, 'مدفوعة'], [0, 'مستحقة']], depositRentLive: 0 };
  const docsOf = (db: DB) => { const v = view(db, cid); return { insts: v.insts, depositRentLive: v.depositRentLive }; };
  expect({ owner: view(owner, cid), member: late ? docsOf(m.db) : want }).toEqual({
    owner: { ...want, c2400: 0, c4200: 200_000, c1100: 200_000, red: [], rejects: [] }, member: want,
  });
  owner.close();
  m.db.close();
});
