/**
 * مراجعة إصلاح R12-SYN-1 (adb649e) · بيانات مصطنعة كلها.
 *
 * العيب: isDbFault (src/db/adapter.ts) يعدّ الخطأ عطلاً في القاعدة إن وُجد في نصّ رسالته «database is locked» أو أخواتها، وapplyOne يعيد
 *   رمي كل ما يعدّه عطلاً فتُلغى صفحة الوارد كلها وتبقى في الصندوق · لكن بعض رسائل الرفض تحمل نصاً كتبه العضو: «حركة البنك لقيدٍ مرفوض
 *   ({{no}})» برقم القيد كما في مستند العضو، والقواعد لا تقيّد رقم القيد نصاً · فعضوٌ يرفع قيداً مرفوضاً رقمه «database is locked»
 *   وحركة بنكٍ بهذا الرقم يجعل رفض حركته «عطلاً»: تفشل مزامنة جهاز المالك في كل دورة عند التطبيق، فلا يُطبَّق ما بعد تلك الصفحة ولا
 *   يُرفع شيءٌ مما يكتبه المالك (الرفع بعد التطبيق) إلى الأبد · وكان قبل الإصلاح رفضاً عادياً للمستندين.
 * السيناريو: جهاز المالك وجهازه الثاني · المالك يودع نقداً في بنك أ فتصل حركة بنكٍ إلى السحابة · ثم يُزرع في السحابة باسم عضو قيدٌ
 *   غير متوازن رقمه «database is locked» وحركة بنكٍ برقمه · المالك يضيف عقاراً ويزامن ثلاث مرات.
 * الصحيح: المستندان مرفوضان، والمزامنة تكتمل، والعقار الجديد في السحابة.
 *   TZ=Asia/Riyadh npx jest tests/review12.r.dbFaultTextSpoof.test.ts
 */
import { postManualEntry } from '@/domain/accounting/post';
import { depositCashToBank } from '@/domain/cashOps';
import { addBank, addProperty } from './helpers/fixtures';
import { pair, sync, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';

test('رسالة رفضٍ تحمل نصاً كتبه العضو لا تُعدّ عطلاً في القاعدة فتوقف مزامنة المالك', async () => {
  const p = await pair();
  const A = addBank(p.owner, 'بنك أ مصطنع', 0);
  postManualEntry(p.owner, { date: '2026-03-01', memo: 'رأس مال مصطنع', lines: [
    { account: '1100', debit: 50_000, credit: 0 }, { account: '3100', debit: 0, credit: 50_000 }] });
  depositCashToBank(p.owner, { bankId: A, amountHalalas: 10_000, date: '2026-03-02' });
  await sync(p.owner, p.r);

  // قيدٌ وحركة بنكٍ مزروعان باسم عضو: القيد غير متوازن (يُرفض) ورقمه نصٌّ يشبه رسالة SQLite
  const NO = 'database is locked';
  const entry = [...p.r.docs.values()].find((d) => d.t === 'journal_entries')!;
  const tx = [...p.r.docs.values()].find((d) => d.t === 'bank_tx')!;
  const k = 'forged-spoof-entry';
  p.r.inject({ ...entry, id: 'journal_entries__' + k, k, by: MEMBER, d: { ...entry.d, id: k, no: NO, src_type: null, src_id: null },
    lines: (entry.lines ?? []).map((l, i) => ({ ...l, id: k + '-l' + i, entry_id: k, debit_halalas: i === 0 ? Number(l.debit_halalas) + 100 : l.debit_halalas })),
  } as RemoteDoc);
  const t = 'forged-spoof-tx';
  p.r.inject({ ...tx, id: 'bank_tx__' + t, k: t, by: MEMBER, d: { ...tx.d, id: t, journal_no: NO } } as RemoteDoc);

  // المالك يكتب عقاراً ويزامن
  const prop = addProperty(p.owner, { name: 'عقار مصطنع بعد الزرع' });
  const errs: string[] = [];
  for (let i = 0; i < 3; i++) await sync(p.owner, p.r).catch((e: unknown) => { errs.push(e instanceof Error ? e.message : String(e)); });

  const out = {
    errs,
    // العقار الذي كتبه المالك وصل السحابة
    uploaded: !!p.r.docs.get('properties__' + prop),
    // المستندان المزروعان مرفوضان ولا شيء منهما ينتظر
    rejected: p.owner.all<{ pk: string }>(`SELECT DISTINCT pk FROM sync_rejects WHERE pk IN (?, ?) ORDER BY pk`, [k, t]).map((x) => x.pk),
    inbox: p.owner.all(`SELECT 1 FROM sync_inbox`).length,
  };
  // eslint-disable-next-line no-console
  console.log('نص العطل من العضو ·', JSON.stringify(out));
  // اليوم: كل دورة تفشل بـ«حركة البنك لقيدٍ مرفوض (database is locked)…»، والعقار لا يُرفع، والمزروعان في الصندوق
  expect(out).toEqual({ errs: [], uploaded: true, rejected: [k, t].sort(), inbox: 0 });
  p.close();
});
