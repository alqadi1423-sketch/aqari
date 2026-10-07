/**
 * مراكز التكلفة وأبعاد الدفتر في الواجهة (قرار المالك ٢٠٢٦-١٠-٠٤):
 *  - CostCenterField: حقل مركز التكلفة في كل شاشة تُنشئ قيداً، وقيمته الافتراضية «عام».
 *  - CostCentersSheet: إضافتها بأسمائها وتسميتها وحذفها من بطاقة المالية · «عام» لا يُحذف.
 *  - DimsBackfillSheet: أبعاد القيود القديمة تُعرض قبل التنفيذ ولا تُطبَّق إلا بكلمة المالك ·
 *    وما لا يُعرف مصدره يبقى فارغاً ويُسرد.
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Sheet, SelectField } from './Sheet';
import { BtnGhost, BtnPrimary, Field, Note, Row, T } from './components';
import { C, TYPE } from './theme';
import { useApp } from './store';
import { useToast } from './Toast';
import { useDialog } from './AppDialog';
import { usePerm } from './access';
import { reportFailure } from './failureDialog';
import { uid } from '../domain/ids';
import { logAudit } from '../domain/audit';
import { dfmt } from '../domain/dates';
import {
  GENERAL_COST_CENTER, costCenters, addCostCenter, renameCostCenter, deleteCostCenter, planDimsBackfill, applyDimsBackfill,
  acknowledgeUnknownDims,
} from '../domain/accounting/dimensions';

/** حقل مركز التكلفة · «عام» افتراضاً · ويُمرَّر اختياره إلى العملية بـ withCostCenter */
export function CostCenterField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { db, version } = useApp();
  const list = useMemo(() => costCenters(db),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  return (
    <SelectField label="مركز التكلفة" value={value || GENERAL_COST_CENTER}
      options={list.map((c) => ({ value: c.id, label: c.name }))}
      onPick={(v) => onChange(v)} />
  );
}

/** إدارة مراكز التكلفة · من بطاقة المالية · الإضافة والتعديل بصلاحية الدفتر */
export function CostCentersSheet({ onClose }: { onClose: () => void }) {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const perm = usePerm('ledger');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const list = useMemo(() => costCenters(db),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const add = () => {
    try {
      db.transaction(() => {
        addCostCenter(db, 'cc-' + uid(), name);
        logAudit(db, 'مراكز التكلفة', 'create', 'مركز تكلفة', name.trim());
      });
      setName(''); bump(); toast('أُضيف مركز التكلفة');
    } catch (e) { reportFailure({ title: 'تعذّرت الإضافة', e }); }
  };
  const rename = () => {
    if (!editing) return;
    try {
      db.transaction(() => {
        renameCostCenter(db, editing.id, editing.name);
        logAudit(db, 'مراكز التكلفة', 'update', 'مركز تكلفة', editing.name.trim());
      });
      setEditing(null); bump(); toast('عُدّل الاسم');
    } catch (e) { reportFailure({ title: 'تعذّر التعديل', e }); }
  };
  const remove = (id: string, n: string) => dialog({
    title: 'حذف مركز التكلفة',
    body: 'يُحذف «' + n + '» من القائمة، وتبقى القيود المسجّلة عليه بمركزها كما هي.',
    tone: 'danger',
    actions: [
      { label: 'تراجع', variant: 'ghost' },
      { label: 'حذف', variant: 'danger', onPress: () => {
        try {
          db.transaction(() => { deleteCostCenter(db, id); logAudit(db, 'مراكز التكلفة', 'delete', 'مركز تكلفة', n); });
          bump(); toast('حُذف مركز التكلفة');
        } catch (e) { reportFailure({ title: 'تعذّر الحذف', e }); }
      } },
    ],
  });
  return (
    <Sheet visible onClose={onClose} title="مراكز التكلفة" tall>
      <Note>بُعدٌ مستقل فوق العقار والوحدة · كل شاشة تُنشئ قيداً فيها حقله، وافتراضه «عام» الذي لا يُحذف.</Note>
      {list.map((c) => (
        <Row key={c.id} style={{ justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
          <T size={TYPE.body} bold={!!c.is_default}>{c.name}{c.is_default ? ' · افتراضي' : ''}</T>
          {perm.manage && !c.is_default ? (
            <Row gap={6}>
              <BtnGhost small title="تعديل" onPress={() => setEditing({ id: c.id, name: c.name })} />
              <BtnGhost small title="حذف" onPress={() => remove(c.id, c.name)} />
            </Row>
          ) : null}
        </Row>
      ))}
      {editing ? (
        <View style={{ marginTop: 10 }}>
          <Field label="الاسم الجديد" value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} />
          <Row gap={8}>
            <View style={{ flex: 1 }}><BtnGhost title="تراجع" onPress={() => setEditing(null)} /></View>
            <View style={{ flex: 1 }}><BtnPrimary title="حفظ" onPress={rename} /></View>
          </Row>
        </View>
      ) : perm.add ? (
        <View style={{ marginTop: 12 }}>
          <Field label="مركز جديد" value={name} onChange={setName} placeholder="مثل: تشغيل، تسويق، صيانة" />
          {name.trim().length >= 2 ? <BtnPrimary title="إضافة" onPress={add} /> : null}
        </View>
      ) : null}
    </Sheet>
  );
}

/** أبعاد القيود القديمة · تُعرض قبل التنفيذ، وتُطبَّق بكلمة المالك وحده، وما لا يُعرف مصدره يُسرد */
export function DimsBackfillSheet({ onClose }: { onClose: () => void }) {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const plan = useMemo(() => planDimsBackfill(db),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const apply = () => dialog({
    title: 'ملء أبعاد القيود القديمة',
    body: 'تُملأ أبعاد ' + plan.known.length + ' قيداً من مستنداتها (الدفعة ← العقد ← الوحدة ← العقار) بمركز «عام»، ولا يتغير مبلغ ولا حساب. وما لا يُعرف مصدره (' + plan.unknown.length + ') يبقى فارغاً.',
    actions: [
      { label: 'تراجع', variant: 'ghost' },
      { label: 'تنفيذ', variant: 'primary', onPress: () => {
        try {
          const n = applyDimsBackfill(db, plan);
          logAudit(db, 'الدفتر', 'update', 'أبعاد القيود القديمة', n + ' قيداً');
          bump(); toast('مُلئت أبعاد ' + n + ' قيداً');
        } catch (e) { reportFailure({ title: 'تعذّر الملء', e }); }
      } },
    ],
  });
  const keep = () => dialog({
    title: 'إبقاؤها بلا أبعاد',
    body: plan.unknown.length + ' قيداً لا مصدر لها في التطبيق تبقى بلا عقار ولا وحدة ولا عقد، ومركزها «عام»، وتخرج من المراجعة.',
    actions: [
      { label: 'تراجع', variant: 'ghost' },
      { label: 'إبقاء', variant: 'primary', onPress: () => {
        try {
          const n = acknowledgeUnknownDims(db, plan.unknown.map((u) => u.entryId));
          logAudit(db, 'الدفتر', 'update', 'قيود قديمة بلا أبعاد', n + ' قيداً');
          bump(); toast('بقيت ' + n + ' قيداً بلا أبعاد');
        } catch (e) { reportFailure({ title: 'تعذّر الحفظ', e }); }
      } },
    ],
  });
  return (
    <Sheet visible onClose={onClose} title="أبعاد القيود القديمة" tall
      footer={plan.known.length ? <View style={{ flex: 1 }}><BtnPrimary title={'ملء ' + plan.known.length + ' قيداً'} onPress={apply} /></View>
        : plan.unknown.length ? <View style={{ flex: 1 }}><BtnGhost title="إبقاؤها بلا أبعاد" onPress={keep} /></View> : undefined}>
      <Note>القيود قبل الأبعاد بلا عقار ولا وحدة ولا عقد. تُملأ من مستنداتها بعد عرضها هنا، ولا يُطبَّق شيء قبل «ملء».</Note>
      <T size={TYPE.body} bold>{'يُعرف مصدرها: ' + plan.known.length}</T>
      <T size={TYPE.body} bold style={{ marginTop: 6 }}>{'لا يُعرف مصدرها (تبقى فارغة): ' + plan.unknown.length}</T>
      {plan.unknown.slice(0, 60).map((u) => (
        <Row key={u.entryId} style={{ justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
          <T size={TYPE.caption}>{u.no + ' · ' + u.memo.slice(0, 40)}</T>
          <T size={TYPE.caption} color={C.muted}>{dfmt(u.date)}</T>
        </Row>
      ))}
      {plan.unknown.length > 60 ? <T size={TYPE.caption} color={C.muted}>{'و' + (plan.unknown.length - 60) + ' غيرها'}</T> : null}
    </Sheet>
  );
}
