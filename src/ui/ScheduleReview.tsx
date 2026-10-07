/**
 * جدول الدفعات قبل حفظ العقد (أعطال قراءة عقد إيجار ٢٠٢٦-١٠-٠٧): يُعرض كاملاً للمراجعة والاعتماد ·
 * رقم الدفعة والاستحقاق وآخر المهلة والمبلغ، وتنبيهٌ واضح إن كانت التواريخ محسوبة لا مقروءة من الملف.
 */
import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Money, Note, Row, T } from './components';
import { C, TYPE } from './theme';
import { useLang } from '../i18n';
import { dfmt } from '../domain/dates';
import { toHalalas } from '../domain/money';
import { scheduleInstallments } from '../domain/contracts/service';
import { generateInstallments } from '../domain/contracts/installments';
import type { ScheduleRow } from '../domain/pdf/parseEjar';

export function ScheduleReview({ start, end, value, cycle, schedule, fromEjarFile }: {
  start: string; end: string; value: string; cycle: string; schedule?: ScheduleRow[] | null; fromEjarFile?: boolean;
}) {
  const { t } = useLang();
  const rows = useMemo(() => {
    if (!start || !end) return null;
    const v = toHalalas(value);
    const read = scheduleInstallments(schedule ?? null, start, end, v);
    if (read) return { read: true, rows: read.map((r) => ({ due: r.dueDate, deadline: r.deadline, amount: r.amountHalalas })) };
    try {
      return { read: false, rows: generateInstallments(start, end, v, cycle).map((r) => ({ due: r.dueDate, deadline: null as string | null, amount: r.amountHalalas })) };
    } catch { return null; }
  }, [start, end, value, cycle, schedule]);
  if (!rows || !rows.rows.length) return null;
  return (
    <View style={{ marginTop: 12 }}>
      <T size={TYPE.body} bold>{t('lease.scheduleTitle', { n: rows.rows.length })}</T>
      {rows.read
        ? <Note tone="ok">{t('lease.scheduleRead')}</Note>
        : fromEjarFile ? <Note tone="danger">{t('lease.scheduleComputedFromFile')}</Note> : <Note>{t('lease.scheduleComputed')}</Note>}
      <Row style={{ paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.line }}>
        <T size={TYPE.caption} color={C.muted} style={{ width: 28 }}>#</T>
        <T size={TYPE.caption} color={C.muted} style={{ flex: 1 }}>{t('lease.due')}</T>
        <T size={TYPE.caption} color={C.muted} style={{ flex: 1 }}>{t('lease.deadline')}</T>
        <T size={TYPE.caption} color={C.muted} style={{ width: 96 }}>{t('lease.amount')}</T>
      </Row>
      {rows.rows.map((r, i) => (
        <Row key={i} style={{ paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
          <T size={TYPE.caption} style={{ width: 28 }}>{String(i + 1)}</T>
          <T size={TYPE.caption} style={{ flex: 1 }}>{dfmt(r.due)}</T>
          <T size={TYPE.caption} color={r.deadline ? C.charcoal : C.muted} style={{ flex: 1 }}>{r.deadline ? dfmt(r.deadline) : '—'}</T>
          <View style={{ width: 96 }}><Money halalas={r.amount} size={TYPE.caption} /></View>
        </Row>
      ))}
    </View>
  );
}
