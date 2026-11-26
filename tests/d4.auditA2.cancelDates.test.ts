/**
 * المدقق A2 · الجولة الرابعة عشرة · على 52f19cb · إلغاء الدفعة بمعرّفاتٍ حتمية من معرّفها وحده (إصلاح Z2-2) يدمج إلغاءين بتاريخين مختلفين
 * صامتاً · بياناتٌ مصطنعة كلها، ولا كشف بنك.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditA2.cancelDates.test.ts
 *
 * A2-6 · متوسط · src/domain/contracts/cancelPayment.ts:194-196 (البذرة «cancel:» + معرّف الدفعة، بلا تاريخ الإلغاء) مع
 * src/sync/engine.ts:1751-1757 (اسم رقم القيد يُسجَّل إن طابقت سطوره حساباً ومبلغاً، أياً كان تاريخه) وengine.ts:2628-2630 (knownInCloud:
 * لا «مرفوض» لقيدٍ عرف الجهاز رقمه في السحابة) وengine.ts:1513-1520 (القيد المرحّل هنا لا يتغيّر بالوارد): دفعة شيكٍ بنكي لماجد (30 أكتوبر)
 * يرتدّ شيكها، فيلغيها عضوٌ بتاريخ 31 أكتوبر وعضوٌ آخر بلا اتصال بتاريخ 2 نوفمبر · العاكسان بالمعرّف نفسه ومحتواهما مختلف (التاريخ والبيان)
 * فيلتقيان «قيداً واحداً» في السحابة بنسخة الأول، ويبقى عند الثاني بتاريخه هو ولا يُسجَّل له رفض · وصفّ الدفعة وحركة البنك (المعرّف الحتمي
 * نفسه) بنسخة الأحدث: على جهاز المالك الدفعة «ملغاة في 2 نوفمبر» وحركة البنك السالبة في نوفمبر، وعاكس قيدها في 31 أكتوبر · وعلى جهاز
 * العضو الثاني العاكس في 2 نوفمبر.
 * لماذا يهم: إيراد أكتوبر وتقريره ومطابقة بنك أكتوبر تختلف بين جهاز المالك وجهاز العضو بلا أي أثرٍ ظاهر (قبل 52f19cb كان العاكس الثاني
 * يظهر مرفوضاً)، وعلى جهاز المالك نفسه تاريخ الإلغاء في الدفعة والبنك غير تاريخ قيده.
 * السلوك الصحيح: إلغاءٌ واحدٌ بتاريخٍ واحد على كل جهاز (عاكس القيد وصفّ الدفعة وحركة البنك)، أو يظهر الإلغاء المخالف مرفوضاً على جهازه.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { sync, ownerPulls, MEMBER, UID } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncStatus } from '@/sync/engine';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('A2-6 · [متوسط] عضوان يلغيان دفعة الشيك المرتجع بلا اتصال بتاريخين (31 أكتوبر و2 نوفمبر): تاريخ إلغاءٍ واحد على كل جهاز أو رفضٌ ظاهر', async () => {
  const r = new MemoryRemote();
  const owner = memDb(); const m1 = memDb(); const m2 = memDb();
  for (const d of [owner, m1, m2]) enableSync(d, UID);
  const ids = [getMeta(m1, 'device_id'), getMeta(m2, 'device_id')];
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await sync(owner, r); await sync(m1, r); await sync(m2, r);
      for (const d of [...r.docs.values()]) if (ids.includes(d.dev) && d.by !== MEMBER) r.docs.set(d.id, { ...d, by: MEMBER });
      await ownerPulls(owner, r);
    }
  };
  const bank = addBank(owner, 'بنك مصطنع A2-6', 0);
  const prop = addProperty(owner, { name: 'عقار مصطنع A2-6' });
  const c = confirmContract(owner, contractInput(addUnit(owner, prop, { unit_no: 'A26-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000002166', phone: '0500002166', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const oct = owner.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!.id;
  const pay = recordRentPayment(owner, c, { installmentId: oct, period: 'أكتوبر', date: '2026-10-30',
    lines: [{ method: 'cheque', bankId: bank, amountHalalas: 100000 }], discountHalalas: 0, notes: 'شيك مصطنع' });
  await settle();

  // الشيك ارتدّ: يلغيها كلٌّ من العضوين بلا اتصال، بتاريخ علمه
  cancelPayment(m1, pay, { date: '2026-10-31', reason: 'شيك مرتجع (العضو الأول)' });
  await wait(5);
  cancelPayment(m2, pay, { date: '2026-11-02', reason: 'شيك مرتجع (العضو الثاني)' });
  await settle();
  // وما انتظر في الوارد بلغ حدّ الانتظار فيُحسم كما على الجهاز الحقيقي
  owner.run(`UPDATE sync_inbox SET waiting_since = '2026-01-01T00:00:00.000Z', attempts = 50`);
  await settle();

  const cancelEntry = (db: DB) => db.get<{ id: string; date: string }>(
    `SELECT e.id, e.date FROM contract_payments p JOIN journal_entries e ON e.id = p.cancel_entry_id WHERE p.id = ?`, [pay])!;
  const ownerDates = {
    payment: owner.get<{ d: string }>(`SELECT cancelled_at AS d FROM contract_payments WHERE id = ?`, [pay])!.d,
    entry: cancelEntry(owner).date,
    bankTx: owner.get<{ d: string }>(`SELECT date AS d FROM bank_tx WHERE bank_id = ? AND amount_halalas < 0`, [bank])!.d,
  };
  // الإصلاح: الإلغاءان بتاريخين لا يلتقيان بمعرّفٍ واحد (بذرة الإلغاء بتاريخه)، فيُقبل الأول على جهاز المالك ويظهر رفض الثاني على جهازه ·
  // فعاكس المالك عاكس الأول (العضو الأول)، ومن يخالفه مرفوضٌ ظاهر
  expect(cancelEntry(owner).id).toBe(cancelEntry(m1).id);
  const state = {
    ownerSame: new Set(Object.values(ownerDates)).size === 1,
    m2AgreesOrRejected: cancelEntry(m2).date === cancelEntry(owner).date || syncStatus(m2).rejected > 0,
  };
  // (الواقع: على جهاز المالك الدفعة والحركة في 2026-11-02 والعاكس في 2026-10-31، وعاكس العضو الثاني في 2026-11-02 بلا رفض)
  expect({ ownerDates, m2Entry: cancelEntry(m2).date, ...state })
    .toEqual({ ownerDates, m2Entry: cancelEntry(m2).date, ownerSame: true, m2AgreesOrRejected: true });
  owner.close(); m1.close(); m2.close();
});
