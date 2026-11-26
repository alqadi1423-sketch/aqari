/**
 * طريقة قبض التأمين والعربون وردّهما: نقداً أو تحويلاً لحساب بنكي بعينه (المراجعة الشاملة 2026-11-13 · A1-6 · قرار المالك س١٧) ·
 * اختيارٌ واحد: «نقداً» أو «تحويل إلى حساب بنكي · اسم البنك» · والقيمة معرّف البنك، والفارغ نقداً ·
 * ولا حساب بنكياً يقرؤه المستخدم فلا يظهر الحقل (الطريقة نقداً كما كانت): خيارٌ لا يعمل لا يُعرض.
 */
import React, { useMemo } from 'react';
import { SelectField } from './Sheet';
import { useApp } from './store';
import { useLang } from '../i18n';

const CASH = 'cash';

export function DepositBankField({ label, value, onChange, out }: {
  label: string;
  /** معرّف البنك، والفارغ نقداً */
  value: string;
  onChange: (bankId: string) => void;
  /** ردٌّ يخرج من البنك (لا قبضٌ يدخله) */
  out?: boolean;
}) {
  const { db, version } = useApp();
  const { t } = useLang();
  const banks = useMemo(() => db.all<{ id: string; name: string }>(
    `SELECT id, name FROM banks WHERE deleted_at IS NULL ORDER BY name`), [db, version]);
  if (!banks.length) return null;
  const via = t(out ? 'depositBank.bankOut' : 'depositBank.bankIn');
  return (
    <SelectField<string>
      label={label}
      value={value || CASH}
      options={[{ value: CASH, label: t('depositBank.cash') }, ...banks.map((b) => ({ value: b.id, label: via + ' · ' + b.name }))]}
      onPick={(v) => onChange(v === CASH ? '' : v)}
    />
  );
}
