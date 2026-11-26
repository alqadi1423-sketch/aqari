/**
 * مراجعة إصلاح R12-SYN-1 (adb649e) · بيانات مصطنعة كلها.
 *
 * العيب: الإصلاح يعيد رمي أعطال القاعدة من applyOne، لكن reject() نفسه يكتب سطر سجل العمليات داخل try/catch يبتلع كل خطأ
 *   («السجل لا يعطّل»). فإن ألغت SQLite معاملة الصفحة عند تلك الكتابة (قرصٌ ممتلئ) ابتُلع الإلغاء: يعود applyOne «مرفوض»،
 *   وapplySteps يحذف المستند من الصندوق الوارد خارج أي معاملة فيُحفظ الحذف، وسطر الرفض نفسه ذهب مع المعاملة الملغاة.
 *   المؤشر تقدّم عند السحب، فلا يعود المستند ولا يبقى له أثرٌ في «حالة المزامنة» (ولو كان ينتظر أباه لما أُعيد حين يصل).
 * السيناريو: الجهاز الثاني يسجّل حجزاً، ويُجعل قيد العربون مكتوباً بعضوٍ بضعف مبلغه (يُرفض على جهاز المالك كما في
 *   d3.rederiveReservation) · وعند كتابة سطر سجل العمليات لرفضه تلغي SQLite المعاملة مرةً واحدة · ثم يعود المكان ويزامن المالك مرتين.
 * الصحيح (كما في الإصلاح لغير هذا الموضع): الصفحة كلها تُلغى وتبقى في الصندوق، فيُرفض القيد في الدورة التالية ويُسجَّل رفضه.
 *   TZ=Asia/Riyadh npx jest tests/review12.r.rejectAuditAbort.test.ts
 */
import { createReservation } from '@/domain/reservations';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, asMember, has, reasonOf, doubled } from './helpers/rederive';

test('إلغاء SQLite للمعاملة عند كتابة سجل الرفض لا يُسقط المستند المرفوض ولا سجل رفضه', async () => {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار حجز مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'RA-1' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  createReservation(p.dev, { unitId: ua, name: 'صاحب حجز مصطنع', phone: '0500000771', depositHalalas: 150000, expiryDate: '2026-12-31' });
  await sync(p.dev, p.r);
  const k = asMember(p.r, 'reservation', doubled);

  // قرصٌ ممتلئ مرةً واحدة عند سطر سجل العمليات لرفض الوارد: SQLite تلغي المعاملة كلها ثم يفشل الأمر (كما في autoRollbackLoss)
  const db = p.owner as unknown as { run: (s: string, a?: unknown[]) => unknown; exec: (s: string) => void };
  const run = db.run.bind(db);
  let full = true;
  db.run = (sql: string, args?: unknown[]) => {
    if (full && sql.startsWith('INSERT INTO audit_log') && (args ?? []).includes('رفض وارد')) {
      full = false;
      db.exec('ROLLBACK');
      throw new Error('database or disk is full');
    }
    return run(sql, args);
  };
  await sync(p.owner, p.r).catch(() => { /* الدورة تفشل: مقبول */ });
  expect(full).toBe(false); // الإلغاء وقع فعلاً عند سجل الرفض
  await sync(p.owner, p.r);
  await sync(p.owner, p.r);

  const out = {
    posted: has(p.owner, k),
    // سبب رفض إعادة الاشتقاق يسمّي المصدر كما في d3.rederiveReservation
    rejectedForReservation: /reservation/.test(reasonOf(p.owner, k)),
    inbox: p.owner.all(`SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ?`, [k]).length,
  };
  // اليوم: rejectedForReservation = false (سطر الرفض ذهب مع الإلغاء، والحذف من الصندوق حُفظ وحده)
  expect(out).toEqual({ posted: false, rejectedForReservation: true, inbox: 0 });
  p.close();
});
