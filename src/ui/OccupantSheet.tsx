/**
 * إضافة ساكن أو تعديله في ورقة مستقلة فوق العقد (قرار المالك 2026-10-07): زر ✕ في رأسها وزر «حفظ» ظاهر،
 * والخانة الإلزامية (الاسم والهوية) لا تُظلَّل إلا بعد محاولة حفظ ناقصة، ولا قيمة مختارة سلفاً في الخانات.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { Field, Row, BtnPrimary } from './components';
import { Sheet, SelectField } from './Sheet';
import { useApp } from './store';
import { useToast } from './Toast';
import { reportFailure } from './failureDialog';
import { useLang } from '../i18n';
import { useSaveAttempt } from './formAttempt';
import { addOccupant, updateOccupant, OCCUPANT_RELATIONS, type OccupantRow } from '../domain/occupants';

export function OccupantSheet({ contractId, editing, onClose }: {
  contractId: string;
  /** الساكن الذي يُعدَّل · وغيابه إضافة */
  editing: OccupantRow | null;
  onClose: () => void;
}) {
  const { db, bump } = useApp();
  const { t } = useLang();
  const toast = useToast();
  const f = useSaveAttempt();
  const [name, setName] = useState(editing?.name ?? '');
  const [nat, setNat] = useState(editing?.national_id ?? '');
  const [phone, setPhone] = useState(editing?.phone ?? '');
  const [relation, setRelation] = useState<string>(editing?.relation ?? '');
  const [nationality, setNationality] = useState(editing?.nationality ?? '');

  const save = () => {
    try {
      const input = { name, nationalId: nat, phone, relation: relation || undefined, nationality };
      if (editing) updateOccupant(db, editing.id, input);
      else addOccupant(db, contractId, input);
      bump();
      toast(t(editing ? 'occupant.edited' : 'occupant.added'));
      onClose();
    } catch (e) {
      reportFailure({ title: t('occupant.saveFailed'), e });
    }
  };

  return (
    <Sheet visible onClose={onClose} title={t(editing ? 'occupant.editTitle' : 'occupant.addTitle')}
      footer={<View style={{ flex: 1 }}><BtnPrimary title={t('common.save')} onPress={() => f.attempt(!!(name.trim() && nat.trim()), save)} /></View>}>
      <Field label={t('occupant.name')} value={name} onChange={setName} error={f.missing(name)} />
      <Row>
        <View style={{ flex: 1 }}><Field label={t('occupant.nationalId')} value={nat} onChange={setNat} keyboard="numeric" ltr error={f.missing(nat)} /></View>
        <View style={{ flex: 1 }}><Field label={t('occupant.phone')} value={phone} onChange={setPhone} keyboard="phone-pad" ltr /></View>
      </Row>
      <SelectField label={t('occupant.relation')} value={relation || null}
        options={OCCUPANT_RELATIONS.map((r) => ({ value: r, label: r }))} onPick={setRelation} />
      <Field label={t('occupant.nationality')} value={nationality} onChange={setNationality} />
    </Sheet>
  );
}
