/**
 * مراجعٌ مستقل خامس على R12-BAK-2 (4913565) · كلفة «صار له مستند» المشتق (orphans.ts: documentedSql) على بياناتٍ بحجم مكتبٍ عامل ·
 * بيانات مصطنعة تُدرج بالـSQL للسرعة، والأرقام بالهللة محسوبة باليد.
 *
 * الحجم: ٢٬٠٠٠ عقد بتأمين ١٬٠٠٠ · ٤٨٬٥٢٤ قيداً مرحّلاً · ٢٠٬٠٠٠ سطر في سجل العمليات · واستعادةٌ واحدة ضمّت تعديل تسوية عشرة عقود بعد النسخة:
 *   لكلٍّ عاكسُ ردٍّ في النسخة معلَّمٌ للمراجعة (عشر علامات) · وعقدٌ X عُدّلت تسويته التي سدّدت قسطين من التأمين قبل النسخة: دفعتان «من التأمين»
 *   ملغاتان بعاكسَي قيدَيهما (داخل المطابقة، لا علامة عليهما).
 * documentedSql يمسح سجل العمليات مرتين (mk وsv بلا فهرس ولا تجسيد) لكل قيدٍ معلَّمٍ من أنواع REPOST_SRC في كل استدعاء، فكلفة markedNetOn
 *   وkeptForReview وoutOfMatch عدد العلامات × حجم السجل (كانت مسحاً واحداً قبل 4913565) · وdepositArrearsPaid يستدعي outOfMatch مرتين لكل
 *   دفعةٍ «من التأمين» ملغاة في العقد، وتستدعيه ورقة التسوية في كل رسم (app/(tabs)/contracts.tsx: useState بلا دالة، فيُحسب مع كل حرف) ·
 *   فبعد استعادةٍ واحدة تثقل الورقة وفحص المطابقة (يجري قبل كل نسخة احتياطية) على الجوال.
 * الضابط نسبيٌّ لا بالثانية، فلا يتأثر بسرعة الجهاز: الاستدعاء الواحد لا يتجاوز عشرة أضعاف مسحٍ واحد لسجل العمليات.
 * والأرقام: depositArrearsPaid(X) = ٠ (لا دفعة حيّة، والملغاتان داخل المطابقة) · markedNetOn('2400') = −١٠ × ١٠٠٬٠٠٠ = −١٬٠٠٠٬٠٠٠
 *   (العاكس المعلَّم دائن 2400 بمبلغ الردّ، وأصله في النسخة داخل المطابقة).
 *   TZ=Asia/Riyadh npx jest tests/review12.r5.reviewQueriesScale.test.ts
 */
import { memDb } from './helpers/testDb';
import { uid } from '@/domain/ids';
import { markForReview, markedNetOn, keptForReview } from '@/domain/accounting/orphans';
import { depositArrearsPaid } from '@/domain/contracts/service';
import { DEPOSIT_RENT_METHOD } from '@/domain/contracts/installments';
import type { DB } from '@/db/adapter';

function seed(db: DB) {
  const now = new Date().toISOString();
  const ts = now.slice(0, 19);
  let no = 0;
  const entry = (src: string, sid: string, date: string, lines: Array<[string, number, number]>, reverses?: string): string => {
    const id = uid();
    db.run(`INSERT INTO journal_entries (id, no, date, memo, status, auto, src_type, src_id, created_at) VALUES (?,?,?,?,'قيد الإنشاء',1,?,?,?)`,
      [id, 'JE-R5-' + (++no), date, 'مصطنع', src, sid, now]);
    for (const [a, dr, cr] of lines) {
      db.run(`INSERT INTO journal_lines (id, entry_id, account_code, debit_halalas, credit_halalas) VALUES (?,?,?,?,?)`, [uid(), id, a, dr, cr]);
    }
    db.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = ?`, [id]);
    if (reverses) db.run(`UPDATE journal_entries SET reversed_by = ? WHERE id = ?`, [id, reverses]);
    return id;
  };
  let audits = 0;
  const audit = (type: string, after: unknown) => {
    audits++;
    db.run(`INSERT INTO audit_log (id, ts, user_name, module, action_type, entity_type, entity_name, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?)`,
      [uid(), ts, 'المالك', 'العقود', 'update', type, 'مصطنع', null, JSON.stringify(after)]);
  };
  const pid = uid();
  db.run(`INSERT INTO properties (id, name, created_at) VALUES (?,?,?)`, [pid, 'عقار الحجم المصطنع', now]);
  const contracts: string[] = [];
  const toMark: string[] = [];
  db.transaction(() => {
    for (let c = 0; c < 2000; c++) {
      const unit = uid();
      db.run(`INSERT INTO units (id, property_id, unit_no, rent_monthly_halalas, created_at) VALUES (?,?,?,?,?)`, [unit, pid, 'R5S-' + c, 100000, now]);
      const cid = uid();
      contracts.push(cid);
      db.run(`INSERT INTO contracts (id, contract_no, tenant_name, unit_id, value_halalas, cycle, start, end, deposit_halalas, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [cid, 'R5S-' + c, 'مستأجر مصطنع ' + c, unit, 1200000, 'شهرية', '2025-01-01', '2025-12-31', 100000,
        c < 500 ? 'منتهٍ' : 'سارٍ', now]);
      entry('contract_deposit', cid, '2025-01-01', [['1100', 100000, 0], ['2400', 0, 100000]]);
      for (let m = 0; m < 23; m++) {
        const je = entry('rent', cid, '2025-01-' + String((m % 28) + 1).padStart(2, '0'), [['1100', 50000, 0], ['4200', 0, 50000]]);
        db.run(`INSERT INTO contract_payments (id, contract_id, period, date, gross_halalas, net_halalas, method_label, journal_entry_id, created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`, [uid(), cid, 'دفعة', '2025-01-01', 50000, 50000, 'نقداً', je, now]);
        if (m < 9) audit('دفعة إيجار', { contract: cid, amount: 50000, m });
      }
      if (c < 500) {
        // تسويةٌ بالردّ في النسخة، وتعديلها بعد النسخة: عاكس الردّ (المضموم المعلَّم في عشرة عقود) ثم ردٌّ جديد
        const f = entry('deposit_refund', cid, '2026-01-05', [['2400', 100000, 0], ['1100', 0, 100000]]);
        audit('تسوية تأمين', { refund_halalas: 100000, reposted: cid });
        db.run(`INSERT INTO deposit_settlements (contract_id, date, deduction_halalas, deduction_reason, refund_halalas, notes, deduct_destination)
          VALUES (?,?,?,?,?,?,?)`, [cid, '2026-01-05', 0, '', 100000, '', '']);
        if (c < 10) {
          toMark.push(entry('deposit_refund_rev', cid, '2026-01-06', [['1100', 100000, 0], ['2400', 0, 100000]], f));
          entry('deposit_refund', cid, '2026-01-06', [['2400', 100000, 0], ['1100', 0, 100000]]);
        }
      }
    }
    // العقد X: تسويةٌ سدّدت قسطين من التأمين ثم عُدّلت قبل النسخة (دفعتان ملغاتان بعاكسَي قيدَيهما)
    const x = contracts[1999];
    for (let i = 0; i < 2; i++) {
      const e = entry('deposit_rent', x, '2026-01-05', [['2400', 50000, 0], ['4200', 0, 50000]]);
      const rv = entry('deposit_rent_rev', x, '2026-01-07', [['4200', 50000, 0], ['2400', 0, 50000]], e);
      db.run(`INSERT INTO contract_payments (id, contract_id, period, date, gross_halalas, net_halalas, method_label, journal_entry_id, created_at,
        cancelled_at, cancel_reason, cancel_entry_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uid(), x, 'قسط', '2026-01-05', 50000, 50000, DEPOSIT_RENT_METHOD, e, now, '2026-01-07', 'تعديل تسوية التأمين', rv]);
    }
    while (audits < 20000) audit('سطر مصطنع', { i: audits });
    for (const id of toMark) {
      const e = db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ?`, [id])!;
      markForReview(db, { id, no: e.no }, 'عكس قيد ردّ تأمين · مستنده في النسخة بحاله قبل العكس');
    }
  });
  return { x: contracts[1999] };
}

/** أقلّ زمنٍ من خمس مرات (بالملّي ثانية) · يُسقط ضجيج العمّال المتوازين */
function best(fn: () => unknown): number {
  let min = Infinity;
  for (let i = 0; i < 5; i++) { const s = process.hrtime.bigint(); fn(); min = Math.min(min, Number(process.hrtime.bigint() - s) / 1e6); }
  return min;
}

test('بعد استعادةٍ واحدة بعشر علامات: ورقة التسوية ومطابقة 2400 بكلفة مسحٍ لسجل العمليات لا بعدد العلامات', () => {
  const db = memDb();
  const { x } = seed(db);
  expect(db.get(`SELECT (SELECT COUNT(*) FROM journal_entries) AS e, (SELECT COUNT(*) FROM audit_log) AS a`)).toEqual({ e: 48524, a: 20010 });
  // الأرقام أولاً: لا تتغير بالإصلاح
  expect({ arrears: depositArrearsPaid(db, x), net2400: markedNetOn(db, '2400'), review: keptForReview(db).length })
    .toEqual({ arrears: 0, net2400: -1000000, review: 10 });
  const scan = best(() => db.get(`SELECT COUNT(*) AS n FROM audit_log WHERE instr(after_json, '"reposted"') > 0`));
  const t = {
    sheet: best(() => depositArrearsPaid(db, x)),
    net2400: best(() => markedNetOn(db, '2400')),
    review: best(() => keptForReview(db)),
  };
  // eslint-disable-next-line no-console
  console.log('مسحٌ واحد ' + scan.toFixed(1) + 'م.ث · ' + JSON.stringify(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.toFixed(1)]))));
  const limit = 10 * scan;
  expect({ sheet: t.sheet < limit, net2400: t.net2400 < limit, review: t.review < limit }).toEqual({ sheet: true, net2400: true, review: true });
  db.close();
});
