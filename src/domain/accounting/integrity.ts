import type { DB } from '../../db/adapter';
import { accountBalance, allAccounts } from './ledger';
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
     WHERE p.net_halalas > 0 AND NOT EXISTS (
       SELECT 1 FROM journal_entries e
       WHERE e.id = p.journal_entry_id AND e.status = 'مرحّل' AND e.deleted_at IS NULL
     )`
  )!;
  out.push({
    name: 'كل دفعة محصَّلة لها قيد مرحّل',
    ok: Number(unposted.n) === 0,
    value: Number(unposted.n) + ' بلا قيد',
  });

  return out;
}
