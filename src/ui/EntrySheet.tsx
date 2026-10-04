/**
 * ورقة تفاصيل القيد · الوجه الوحيد الذي يُعرض به قيدٌ في التطبيق:
 * رقمه وتاريخه، ثم سطر بيانه واسم مصدره بالعربية، ثم سطوره كلها
 * (رمز الحساب واسمه · مدين أو دائن · المبلغ)، ثم زر «فتح المستند المصدر»
 * ولا يظهر هذا الزر إلا إن كان للقيد مستند قائم يمكن فتحه فعلاً.
 *
 * وفيه خريطة أسماء المصادر العربية · لا يقرأ المستخدم اسماً برمجياً أبداً.
 */
import React, { useMemo } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Sheet } from './Sheet';
import { Row, T, Num, Money, BtnPrimary, EmptyState } from './components';
import { C } from './theme';
import { useApp, useFs } from './store';
import { useAccess } from './access';
import { routeAllowed } from '../domain/access/routes';
import { dfmt } from '../domain/dates';
import type { DB } from '../db/adapter';

/** اسم كل مصدر قيدٍ بالعربية · المفتاح تقني والقيمة وحدها ما يُعرض */
export const JE_SOURCE_AR: Record<string, string> = {
  rent: 'تحصيل إيجار',
  key_money: 'عمولة تقبيل',
  contract_deposit: 'استلام تأمين',
  deposit_deduct: 'خصم من التأمين',
  deposit_deduct_move: 'استقرار المخصوم من التأمين',
  deposit_refund: 'رد التأمين',
  deposit_carry: 'ترحيل التأمين',
  reservation: 'عربون حجز',
  reservation_forfeit: 'مصادرة عربون',
  reservation_convert: 'تحويل عربون إلى عقد',
  claim: 'مطالبة',
  claim_collect: 'تحصيل مطالبة',
  invoice: 'فاتورة مبيعات',
  purchase: 'فاتورة شراء',
  purchase_pay: 'سداد فاتورة شراء',
  vat_refund: 'استرداد ضريبة مدخلات',
  cash_op: 'حركة نقدية',
  manual: 'قيد يدوي',
};

/** ما يُكتب لقيدٍ لا مصدر له أو مصدره غير معروف */
export const JE_MANUAL_LABEL = 'قيد يدوي';
export const JE_NO_SOURCE_LABEL = 'بلا مستند مصدر';

/** لاحقة القيد العاكس · «عكس» + اسم الأصل */
const REV = '_rev';
const baseType = (srcType: string) => (srcType.endsWith(REV) ? srcType.slice(0, -REV.length) : srcType);

/** اسم مصدر القيد بالعربية · «تحصيل إيجار» و«عكس تحصيل إيجار» و«قيد يدوي» */
export function srcTypeLabel(srcType: string | null | undefined): string {
  if (!srcType) return JE_MANUAL_LABEL;
  const base = baseType(srcType);
  const name = JE_SOURCE_AR[base] ?? JE_MANUAL_LABEL;
  return srcType.endsWith(REV) ? 'عكس ' + name : name;
}

/**
 * وجهة المستند المصدر إن كان قائماً · وإلا null فلا يُعرض الزر.
 * القيد العاكس يفتح مستند أصله فمصدرهما واحد.
 */
export function entrySourceRoute(db: DB, srcType: string | null, srcId: string | null): string | null {
  if (!srcType || !srcId) return null;
  const t = baseType(srcType);
  const exists = (sql: string) => !!db.get(sql, [srcId]);
  if (['purchase', 'purchase_pay', 'vat_refund'].includes(t)) {
    return exists(`SELECT id FROM purchases WHERE id = ? AND deleted_at IS NULL`)
      ? `/purchases?detail=${srcId}` : null;
  }
  if (t === 'invoice') {
    return exists(`SELECT id FROM invoices WHERE id = ? AND deleted_at IS NULL`)
      ? `/invoices?detail=${srcId}` : null;
  }
  if (t === 'rent') {
    const p = db.get<{ contract_id: string }>(`SELECT contract_id FROM contract_payments WHERE id = ?`, [srcId]);
    return p ? `/contracts?detail=${p.contract_id}` : null;
  }
  if (['contract_deposit', 'deposit_refund', 'deposit_carry', 'deposit_deduct', 'deposit_deduct_move', 'key_money'].includes(t)) {
    return exists(`SELECT id FROM contracts WHERE id = ?`) ? `/contracts?detail=${srcId}` : null;
  }
  if (['claim', 'claim_collect'].includes(t)) {
    return exists(`SELECT id FROM claims WHERE id = ? AND deleted_at IS NULL`) ? `/claims?detail=${srcId}` : null;
  }
  if (['reservation', 'reservation_convert', 'reservation_forfeit'].includes(t)) {
    return exists(`SELECT id FROM reservations WHERE id = ? AND deleted_at IS NULL`) ? '/units' : null;
  }
  if (t === 'cash_op') return '/banks';
  return null;
}

interface EntryHead {
  id: string; no: string; date: string; memo: string; status: string;
  src_type: string | null; src_id: string | null;
}
interface EntryLineRow {
  account_code: string; account_name: string | null;
  debit_halalas: number; credit_halalas: number;
}

/**
 * تُستدعى بمعرّف القيد وحده · تقرأ رأسه وسطوره بنفسها
 * فيستوي استدعاؤها من الدفتر ومن كشف الحساب ومن التقارير.
 */
export function EntrySheet({
  entryId, onClose, onLeave,
}: {
  entryId: string;
  onClose: () => void;
  /** تُنادى قبل مغادرة الشاشة · لتغلق الورقة التي فُتحت منها هذه */
  onLeave?: () => void;
}) {
  const { db, version } = useApp();
  const router = useRouter();
  const fs = useFs();
  const access = useAccess();

  const head = useMemo(() => db.get<EntryHead>(
    `SELECT id, no, date, memo, status, src_type, src_id FROM journal_entries WHERE id = ?`, [entryId]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, entryId]);

  const lines = useMemo(() => db.all<EntryLineRow>(
    `SELECT l.account_code, a.name AS account_name, l.debit_halalas, l.credit_halalas
       FROM journal_lines l LEFT JOIN accounts a ON a.code = l.account_code
      WHERE l.entry_id = ?
      ORDER BY (l.credit_halalas > 0), l.rowid`, [entryId]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, entryId]);

  // مستندٌ في قسمٍ لا يراه المستخدم لا يُعرض زرّه · المسار يُفحص بلا معاملاته
  const route = useMemo(() => {
    const r = head ? entrySourceRoute(db, head.src_type, head.src_id) : null;
    return r && routeAllowed(access, r.split('?')[0]) ? r : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, head, access]);

  const title = head ? head.no + ' · ' + dfmt(head.date) : 'تفاصيل القيد';

  return (
    <Sheet visible onClose={onClose} title={title} tall>
      {!head ? <EmptyState>لم يعد هذا القيد موجوداً في الدفتر</EmptyState> : (
        <>
          {head.memo ? <T size={13} bold numberOfLines={3}>{head.memo}</T> : null}
          <Row gap={6} style={{ marginTop: 4, marginBottom: 10, flexWrap: 'wrap' }}>
            <T size={11} color={C.muted} numberOfLines={1}>{srcTypeLabel(head.src_type)}</T>
            {head.status !== 'مرحّل' ? (
              <T size={11} color={C.rose} numberOfLines={1}>· {head.status}</T>
            ) : null}
          </Row>

          {lines.map((l, i) => {
            const debit = Number(l.debit_halalas) > 0;
            return (
              <Row key={i} style={{
                paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.paperLine,
              }}>
                <Row gap={6} style={{ flex: 1, minWidth: fs(96) }}>
                  <Num size={11.5} color={C.muted}>{l.account_code}</Num>
                  <T size={12} numberOfLines={1} style={{ flex: 1 }}>{l.account_name || 'حساب محذوف'}</T>
                </Row>
                <T size={11} med color={debit ? C.emerald : C.rose} style={{ width: fs(36) }} numberOfLines={1}>
                  {debit ? 'مدين' : 'دائن'}
                </T>
                <Money halalas={debit ? Number(l.debit_halalas) : Number(l.credit_halalas)} size={12.5} bold />
              </Row>
            );
          })}
          {!lines.length ? <EmptyState>لا سطور لهذا القيد</EmptyState> : null}

          <View style={{ marginTop: 14 }}>
            {route ? (
              <BtnPrimary
                icon="eye"
                title="فتح المستند المصدر"
                onPress={() => { onClose(); onLeave?.(); router.push(route as never); }}
              />
            ) : (
              <T size={11.5} color={C.muted} center>{JE_NO_SOURCE_LABEL}</T>
            )}
          </View>
          <View style={{ height: 10 }} />
        </>
      )}
    </Sheet>
  );
}
