import type { DB } from '../../db/adapter';
import { accountBalance, allAccounts, ledgerNet } from './ledger';
import { KEPT_REVIEW_ENTITY, markedNetOn } from './orphans';
import { fmt } from '../money';

export interface IntegrityCheck {
  name: string;
  ok: boolean;
  value: string;
}

/**
 * فحوص المطابقة الستة · تُعرض في «فحص المطابقة» وتُشغَّل قبل كل نسخة احتياطية
 * وتُكتب نتائجها في بيان النسخة.
 */
/** النسخة قبل الترقية تُفحص بإصدارها القديم · فالعمود الذي أضافته هجرة لاحقة يُتحقق من وجوده */
function hasCol(db: DB, table: string, col: string): boolean {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === col);
}

export function integrityChecks(db: DB): IntegrityCheck[] {
  const out: IntegrityCheck[] = [];

  // ١) مجموع المدين = مجموع الدائن لكل القيود المرحّلة
  const tot = db.get<{ d: number; c: number }>(
    `SELECT COALESCE(SUM(l.debit_halalas),0) AS d, COALESCE(SUM(l.credit_halalas),0) AS c
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL`
  )!;
  out.push({
    name: 'مجموع المدين = مجموع الدائن',
    ok: Number(tot.d) === Number(tot.c),
    value: fmt(Number(tot.d)) + ' / ' + fmt(Number(tot.c)),
  });

  // ٢) كل قيد مرحّل متوازن على حدة
  const bad = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (
       SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
       WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL
       GROUP BY e.id
       HAVING SUM(l.debit_halalas - l.credit_halalas) != 0
     )`
  )!;
  out.push({ name: 'كل قيد متوازن على حدة', ok: Number(bad.n) === 0, value: Number(bad.n) + ' مختلّ' });

  // ٣) رصيد 2400 = التأمينات المحتجزة فعلاً:
  //    عقود سارية أو منتهية لم تُسوَّ بعد (العقد المنتهي يبقى تأمينه محتجزاً حتى التسوية)
  const dep = db.get<{ s: number }>(
    `SELECT COALESCE(SUM(c.deposit_halalas),0) AS s FROM contracts c
     WHERE c.status IN ('سارٍ','منتهٍ') AND c.deleted_at IS NULL
       AND COALESCE(c.deposit_holder,'المكتب') != 'طرف آخر'
       AND c.renewed_to IS NULL -- المجدَّد رُحِّل تأمينه إلى عقده الجديد
       AND NOT EXISTS (SELECT 1 FROM deposit_settlements ds WHERE ds.contract_id = c.id)`
  )!;
  // القيد غائب المستند (orphans.ts) لا مستند يطابقه · يُطرح أثره قبل المطابقة ويُذكر
  const out2400 = markedNetOn(db, '2400');
  const bal2400 = accountBalance(db, '2400') + out2400;
  out.push({
    name: 'تأمينات المستأجرين = التأمينات المحتجزة (غير المُسوَّاة)',
    ok: bal2400 === Number(dep.s),
    value: fmt(bal2400) + ' / ' + fmt(Number(dep.s)) + (out2400 ? ' · خارجها قيود بلا مستند ' + fmt(-out2400) : ''),
  });

  // ٤) رصيد 1250 = مجموع المطالبات المفتوحة
  const openClaims = db.get<{ s: number }>(
    `SELECT COALESCE(SUM(amount_halalas),0) AS s FROM claims
     WHERE status = 'مفتوحة' AND deleted_at IS NULL`
  )!;
  const out1250 = markedNetOn(db, '1250');
  const bal1250 = accountBalance(db, '1250') - out1250;
  out.push({
    name: 'ذمم المطالبات = المطالبات المفتوحة',
    ok: bal1250 === Number(openClaims.s),
    value: fmt(bal1250) + ' / ' + fmt(Number(openClaims.s)) + (out1250 ? ' · خارجها قيود بلا مستند ' + fmt(out1250) : ''),
  });

  // ٥) لا حركات بنكية يتيمة: كل حركة حيّة تشير إلى حساب بنكي حيّ
  const orphanTx = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bank_tx t
     WHERE t.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM banks b WHERE b.id = t.bank_id AND b.deleted_at IS NULL)`
  )!;
  const banksAgg = db.all<{ id: string; opening: number; tx: number }>(
    `SELECT b.id, b.opening_halalas AS opening,
            COALESCE((SELECT SUM(t.amount_halalas) FROM bank_tx t
                      WHERE t.bank_id = b.id AND t.deleted_at IS NULL),0) AS tx
     FROM banks b WHERE b.deleted_at IS NULL`
  );
  const banksTotal = banksAgg.reduce((s, b) => s + Number(b.opening) + Number(b.tx), 0);
  out.push({
    name: 'كل حركة بنكية مرتبطة بحساب حيّ',
    ok: Number(orphanTx.n) === 0,
    value: Number(orphanTx.n) + ' يتيمة · الأرصدة ' + fmt(banksTotal),
  });

  // ٦) الأصول = الخصوم + حقوق الملكية + (الإيرادات - المصروفات)
  let A = 0, L = 0, E = 0, Rv = 0, Ex = 0;
  for (const a of allAccounts(db)) {
    const b = accountBalance(db, a.code);
    if (a.type === 'أصل') A += b;
    else if (a.type === 'خصم') L += b;
    else if (a.type === 'حقوق ملكية') E += b;
    else if (a.type === 'إيراد') Rv += b;
    else if (a.type === 'مصروف') Ex += b;
  }
  out.push({
    name: 'الأصول = الالتزامات + حقوق الملكية + صافي الدخل',
    ok: A === L + E + (Rv - Ex),
    value: fmt(A) + ' / ' + fmt(L + E + (Rv - Ex)),
  });

  // ٧) لا قيود تحصيل يتيمة: كل قيد إيجار مرحّل غير معكوس تشير إليه دفعة حيّة
  const orphans = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM journal_entries e
     WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL AND e.auto = 1
       AND e.reversed_by IS NULL AND e.src_type = 'rent'
       /* تشمل الملغاة: قيد الملغاة معكوس فلا يبلغ هذا الشرط، وصفّها باقٍ مستنداً له */
       AND NOT EXISTS (SELECT 1 FROM contract_payments p WHERE p.journal_entry_id = e.id)
       -- قيدٌ بقي بالاستعادة ومستنده ليس في النسخة · معروفٌ في أداة المراجعة لا مستندٌ حُذف (keepPosted.ts)
       AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.entity_type = ? AND json_extract(a.after_json, '$.id') = e.id)`,
    [KEPT_REVIEW_ENTITY]
  )!;
  out.push({
    name: 'لا قيود يتيمة لمصادر محذوفة',
    ok: Number(orphans.n) === 0,
    value: Number(orphans.n) + ' يتيم',
  });

  // ٨) كل دفعة إيجار محصَّلة لها قيدها المرحّل (الربط بين التحصيل والدفتر)
  const unposted = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM contract_payments p
     WHERE p.net_halalas > 0 ${hasCol(db, 'contract_payments', 'cancelled_at') ? 'AND p.cancelled_at IS NULL' : ''} AND NOT EXISTS (
       SELECT 1 FROM journal_entries e
       WHERE e.id = p.journal_entry_id AND e.status = 'مرحّل' AND e.deleted_at IS NULL
     )`
  )!;
  out.push({
    name: 'كل دفعة محصَّلة لها قيد مرحّل',
    ok: Number(unposted.n) === 0,
    value: Number(unposted.n) + ' بلا قيد',
  });

  // ١٠) ذمم الفواتير (المراجعة ٤.٢): لا فاتورة «مدفوعة» بلا قيد تحصيل، وحركة 1200 = المصدرة غير المحصّلة
  // قاعدة ما قبل الهجرة ٢٣ (نسخة ما قبل الترقية تُفحص بإصدارها) لا عمود تحصيل فيها: كل «مدفوعة» فيها بلا قيد
  const hasPay = hasCol(db, 'invoices', 'payment_journal_entry_id');
  const inv = db.get<{ due: number; paidNoEntry: number }>(
    `SELECT COALESCE(SUM(CASE WHEN status <> 'مدفوعة' THEN total_halalas ELSE 0 END),0) AS due,
            COALESCE(SUM(CASE WHEN status = 'مدفوعة' AND ${hasPay ? 'payment_journal_entry_id' : 'NULL'} IS NULL THEN 1 ELSE 0 END),0) AS paidNoEntry
     FROM invoices WHERE deleted_at IS NULL AND journal_entry_id IS NOT NULL`)!;
  const ar = ledgerNet(db, '1200');
  out.push({
    name: 'ذمم الفواتير = الفواتير المصدرة غير المحصّلة',
    ok: ar === Number(inv.due) && Number(inv.paidNoEntry) === 0,
    value: fmt(ar) + ' / ' + fmt(Number(inv.due)) + (Number(inv.paidNoEntry) ? ' · ' + inv.paidNoEntry + ' مدفوعة بلا تحصيل' : ''),
  });

  // ١١) عربون الحجوزات (المراجعة ٤.٤ و٤.٥): رصيد 2450 = عربون الحجوزات القائمة غير المسوّاة · المحوَّل والمصادَر
  // والمردود خرجت منه (والمصادرة قبل عمود المآل تُعرف بقيدها)
  const hasOutcome = hasCol(db, 'reservations', 'deposit_outcome');
  const held = db.get<{ s: number }>(
    `SELECT COALESCE(SUM(deposit_halalas),0) AS s FROM reservations r
     WHERE r.deleted_at IS NULL AND r.status <> 'محوَّل لعقد' ${hasOutcome ? 'AND r.deposit_outcome IS NULL' : ''}
       AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.src_type = 'reservation_forfeit' AND e.src_id = r.id
                       AND e.status = 'مرحّل' AND e.deleted_at IS NULL AND e.reversed_by IS NULL)`)!;
  const rsvHeld = -ledgerNet(db, '2450');
  out.push({
    name: 'عربون الحجوزات = العربون المحتجز غير المسوّى',
    ok: rsvHeld === Number(held.s),
    value: fmt(rsvHeld) + ' / ' + fmt(Number(held.s)),
  });

  // ٩) لا سجل يتيم (توجيه المالك): لا دفعة ولا قسط بلا عقد قائم، ولا عقد بلا وحدة قائمة
  const strays = orphanCounts(db);
  out.push({
    name: 'لا سجل يتيم: دفعة أو قسط بلا عقد، أو عقد بلا وحدة',
    ok: strays.payments + strays.installments + strays.contracts === 0,
    value: strays.payments + ' دفعة · ' + strays.installments + ' قسط · ' + strays.contracts + ' عقد',
  });

  return out;
}

/** السجلات اليتيمة: أبوها غائب أو في السلة وهي قائمة */
export function orphanCounts(db: DB): { payments: number; installments: number; contracts: number } {
  const n = (sql: string) => Number(db.get<{ n: number }>(sql)!.n);
  return {
    payments: n(`SELECT COUNT(*) AS n FROM contract_payments p
      /* تشمل الملغاة: الصف الباقي بلا عقده يتيمٌ ملغىً كان أو حيّاً */
      WHERE NOT EXISTS (SELECT 1 FROM contracts c WHERE c.id = p.contract_id AND c.deleted_at IS NULL)`),
    installments: n(`SELECT COUNT(*) AS n FROM contract_installments i
      WHERE NOT EXISTS (SELECT 1 FROM contracts c WHERE c.id = i.contract_id AND c.deleted_at IS NULL)`),
    contracts: n(`SELECT COUNT(*) AS n FROM contracts c WHERE c.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM units u WHERE u.id = c.unit_id AND u.deleted_at IS NULL)`),
  };
}
