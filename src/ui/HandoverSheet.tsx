/**
 * نموذج الاستلام والتسليم · واحد لكل عقد، يُنشأ تلقائياً من تفاصيل الوحدة،
 * يُعبَّأ تدريجياً (خانتا الاستلام والتسليم)، وبعد الإقفال لا يُعدَّل · عرض وطباعة فقط.
 * بيانات المستأجر تُقرأ من العقد ولا تُعدَّل هنا، والطباعة بترويسة المنشأة.
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Sheet } from './Sheet';
import { Field, Row, T, Num, BtnGhost, BtnPrimary, Badge } from './components';
import { CollapsibleSection } from './Collapsible';
import { DateField } from './DateField';
import { useApp } from './store';
import { useToast } from './Toast';
import { useDialog } from './AppDialog';
import { C, TYPE } from './theme';
import { type HandoverSection, sectionsFromTemplate, HANDOVER_LEGAL_FOOTER, NO_HANDOVER_SOURCE } from '../domain/handover/build';
import { NeedsTemplate } from './NeedsTemplate';
import {
  getContractHandover, createHandoverForContract, updateHandover, lockHandover,
} from '../domain/handover/service';
import { today } from '../domain/dates';
import { uid } from '../domain/ids';
import { logAudit } from '../domain/audit';
import { printHandoverDoc } from '../services/print';
import { reportFailure } from './failureDialog';
import { usePerm } from './access';

/** عنوان قسم داخل النموذج */
function Head({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <View style={{
      marginTop: first ? 0 : 6, marginBottom: 9, paddingTop: first ? 0 : 12,
      borderTopWidth: first ? 0 : 1, borderTopColor: C.line,
    }}>
      <T size={TYPE.sectionTitle} bold color={C.ink}>{children}</T>
    </View>
  );
}

/** سطر قراءة فقط · بلا حقل إدخال */
function ReadRow({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  // الخانة الفارغة لا تظهر هي ولا عنوانها
  if (!value) return null;
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
      <T size={TYPE.body} color={C.muted}>{label}</T>
      {ltr
        ? <Num size={TYPE.body} bold>{value}</Num>
        : <T size={TYPE.body} bold color={C.charcoal}>{value}</T>}
    </Row>
  );
}

export function HandoverSheet({
  contractId, templateId, onClose, onSaved,
}: {
  /** null = نموذج مستقل من قالب (شاشة إنشاء النماذج) */
  contractId: string | null;
  type?: 'استلام' | 'تسليم';
  templateId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { db, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const perm = usePerm('handover');

  // نموذج العقد الواحد · يُنشأ تلقائياً إن لم يوجد (لعقود ما قبل هذه السياسة) · والإنشاء لمن له الإضافة
  const record = useMemo(() => {
    if (!contractId) return undefined;
    let h = getContractHandover(db, contractId);
    if (!h && perm.add) {
      createHandoverForContract(db, contractId);
      h = getContractHandover(db, contractId);
    }
    return h;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, contractId, perm.add]);

  // بيانات المستأجر مصدرها العقد وحده · تُعرض للقراءة ولا تُعدَّل من هنا
  const fromContract = useMemo(() => {
    if (!contractId) return undefined;
    return db.get<{ tenant_name: string; id_number: string; phone: string }>(
      `SELECT tenant_name, id_number, phone FROM contracts WHERE id = ?`, [contractId]
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, contractId]);

  const locked = !!record && !!Number(record.locked);
  // حفظ النموذج القائم تعديلٌ (كامل) · والنموذج المستقل الجديد إضافة · ومن لا يملك الحفظ يرى ويطبع فقط
  const canSave = record ? perm.manage : perm.add;
  const readOnly = locked || !canSave;

  const [employee, setEmployee] = useState(record?.employee_name ?? '');
  const [tenant, setTenant] = useState(fromContract?.tenant_name ?? record?.tenant_name ?? '');
  const [idNumber, setIdNumber] = useState(fromContract?.id_number ?? record?.id_number ?? '');
  const [phone, setPhone] = useState(fromContract?.phone ?? record?.phone ?? '');
  const [address, setAddress] = useState(record?.address ?? '');
  const [unitFloor, setUnitFloor] = useState(record?.unit_floor ?? '');
  const [period, setPeriod] = useState(record?.contract_period ?? '');
  const [date, setDate] = useState(record?.date ?? today());
  const [otherNotes, setOtherNotes] = useState(record?.other_notes ?? '');
  const [tenantSign, setTenantSign] = useState(record?.tenant_sign ?? '');
  const [companySign, setCompanySign] = useState(record?.company_sign ?? '');
  const [sections, setSections] = useState<HandoverSection[]>(() =>
    record
      ? (JSON.parse(record.sections_json) as HandoverSection[])
      : sectionsFromTemplate(db, templateId ?? null)
  );

  const setItem = (si: number, ii: number, field: 'count' | 'receiveCondition' | 'deliverCondition' | 'notes', v: string) => {
    setSections((p) =>
      p.map((s, i) => i !== si ? s : { ...s, items: s.items.map((it, j) => (j !== ii ? it : { ...it, [field]: v })) })
    );
  };

  const values = () => ({
    employeeName: employee, tenantName: tenant, idNumber, phone, address, unitFloor,
    contractPeriod: period, date, otherNotes, tenantSign, companySign, sections,
  });

  const save = (thenLock = false) => {
    if (!tenant.trim()) { toast('الرجاء إدخال اسم المستأجر'); return; }
    try {
      if (record) {
        updateHandover(db, record.id, values());
        if (thenLock) lockHandover(db, record.id);
      } else {
        // نموذج مستقل من قالب (بلا عقد)
        db.transaction(() => {
          const id = uid();
          db.run(
            `INSERT INTO handovers (id, contract_id, unit_id, type, employee_name, tenant_name, id_number,
              phone, address, unit_floor, contract_period, date, other_notes, tenant_sign, company_sign,
              sections_json, locked, created_at)
             VALUES (?,NULL,NULL,'استلام',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [id, employee.trim(), tenant.trim(), idNumber.trim(), phone.trim(), address.trim(),
             unitFloor.trim(), period.trim(), date, otherNotes.trim(), tenantSign.trim(),
             companySign.trim(), JSON.stringify(sections), thenLock ? 1 : 0, new Date().toISOString()]
          );
          logAudit(db, 'نماذج الاستلام والتسليم', 'create', 'نموذج مستقل', tenant.trim());
        });
      }
      bump();
      toast(thenLock ? 'حُفظ النموذج وأُقفل · صار وثيقة نهائية' : 'تم حفظ النموذج');
      onSaved();
    } catch (e) { reportFailure({ title: 'تعذّر الحفظ', e }); }
  };

  const confirmLock = () => {
    dialog({
      title: 'إقفال النموذج',
      body: 'إقفال النموذج؟ بعد الإقفال لا يمكن تعديله أبداً · يبقى للعرض والطباعة فقط.',
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        { label: 'حفظ وإقفال', variant: 'danger', onPress: () => save(true) },
      ],
    });
  };

  // الطباعة تمر بترويسة المنشأة (اسمها ورقمها الضريبي) عبر printHandoverDoc
  const printDoc = () => {
    const data = {
      type: 'استلام وتسليم', tenantName: tenant, idNumber, phone, address, unitFloor,
      contractPeriod: period, date, tenantSign, companySign, sections,
      contractId: contractId ?? undefined,
    };
    dialog({
      title: 'محضر الاستلام والتسليم',
      body: 'أي نسخة تُصدر؟',
      tone: 'normal',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        { label: 'نسخة المستأجر', variant: 'primary', onPress: () => { printHandoverDoc(db, data, 'tenant').catch(() => toast('تعذّرت الطباعة')); } },
        { label: 'نسخة المكتب', variant: 'primary', onPress: () => { printHandoverDoc(db, data, 'office').catch(() => toast('تعذّرت الطباعة')); } },
        { label: 'كلاهما', variant: 'primary', onPress: () => { printHandoverDoc(db, data, 'both').catch(() => toast('تعذّرت الطباعة')); } },
      ],
    });
  };

  // عقدٌ بلا نموذج ولا ما يُبنى منه: السبب ورابط القالب مكان نموذجٍ فارغ
  if (contractId && !record) {
    return (
      <Sheet visible onClose={onClose} title="نموذج استلام وتسليم">
        <NeedsTemplate reason={NO_HANDOVER_SOURCE} linkLabel="أنشئ قالب استلام وتسليم" route="/form-templates" onNavigate={onClose} />
      </Sheet>
    );
  }

  return (
    <Sheet visible onClose={onClose}
      title="نموذج استلام وتسليم" tall
      footer={
        readOnly ? (
          <View style={{ flex: 1 }}><BtnPrimary icon="print" title="طباعة الوثيقة" onPress={printDoc} /></View>
        ) : (
          <>
            <View style={{ flex: 1 }}><BtnGhost icon="print" title="طباعة" onPress={printDoc} /></View>
            <View style={{ flex: 1 }}><BtnGhost title="حفظ" onPress={() => save(false)} /></View>
            <View style={{ flex: 1 }}><BtnPrimary title="حفظ وإقفال" onPress={confirmLock} /></View>
          </>
        )
      }>
      {locked ? (
        <View style={{ marginBottom: 12 }}>
          <Badge kind="paid" label="مُقفل · وثيقة نهائية لا تُعدَّل" />
        </View>
      ) : null}

      <Head first>بيانات المستأجر</Head>
      {contractId ? (
        <View style={{ backgroundColor: C.paper, borderRadius: 9, paddingVertical: 4, paddingHorizontal: 11, marginBottom: 6 }}>
          <ReadRow label="اسم المستأجر" value={tenant} />
          <ReadRow label="رقم الهوية / الإقامة" value={idNumber} ltr />
          <ReadRow label="رقم الجوال" value={phone} ltr />
        </View>
      ) : (
        <>
          <Field label="اسم المستأجر / المستلم" value={tenant} onChange={setTenant} disabled={readOnly} />
          <Row>
            <View style={{ flex: 1 }}><Field label="رقم الهوية / الإقامة" value={idNumber} onChange={setIdNumber} keyboard="numeric" ltr disabled={readOnly} /></View>
            <View style={{ flex: 1 }}><Field label="رقم الجوال" value={phone} onChange={setPhone} keyboard="phone-pad" ltr disabled={readOnly} /></View>
          </Row>
        </>
      )}

      <Head>بيانات الوحدة والعقد</Head>
      <Row>
        <View style={{ flex: 1 }}><Field label="عنوان الشقة بالكامل" value={address} onChange={setAddress} disabled={readOnly} /></View>
        <View style={{ flex: 1 }}><Field label="رقم الوحدة / الطابق" value={unitFloor} onChange={setUnitFloor} disabled={readOnly} /></View>
      </Row>
      <Row>
        <View style={{ flex: 1 }}><Field label="مدة العقد" value={period} onChange={setPeriod} disabled={readOnly} /></View>
        <View style={{ flex: 1 }}>
          {readOnly
            ? <Field label="التاريخ" value={date} disabled ltr />
            : <DateField label="التاريخ" value={date} onChange={setDate} />}
        </View>
      </Row>

      <Head>بيانات المحضر</Head>
      <Field label="اسم الموظف" value={employee} onChange={setEmployee} disabled={readOnly} />
      <Field label="أخرى" value={otherNotes} onChange={setOtherNotes} disabled={readOnly} />

      <Head>محتويات الوحدة</Head>
      {sections.map((s, si) => (
        <CollapsibleSection key={s.section + si} title={s.section} count={s.items.length}>
          {() => (
            <View>
              {s.items.map((it, ii) => (
                <View key={ii} style={{ marginBottom: 10, borderBottomWidth: 1, borderBottomColor: C.line, paddingBottom: 8 }}>
                  <T size={TYPE.cardTitle} bold style={{ marginBottom: 6 }}>{it.name}</T>
                  <Row>
                    <View style={{ flex: 1 }}>
                      <Field label="العدد" value={it.count} onChange={(v) => setItem(si, ii, 'count', v)} keyboard="numeric" ltr disabled={readOnly} />
                    </View>
                    <View style={{ flex: 2 }}>
                      <Field label="الحالة عند الاستلام" value={it.receiveCondition} onChange={(v) => setItem(si, ii, 'receiveCondition', v)} disabled={readOnly} />
                    </View>
                  </Row>
                  <Row>
                    <View style={{ flex: 1 }}>
                      <Field label="الحالة عند التسليم" value={it.deliverCondition} onChange={(v) => setItem(si, ii, 'deliverCondition', v)} disabled={readOnly} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Field label="ملاحظات" value={it.notes} onChange={(v) => setItem(si, ii, 'notes', v)} disabled={readOnly} />
                    </View>
                  </Row>
                </View>
              ))}
            </View>
          )}
        </CollapsibleSection>
      ))}

      <Head>الإقرار والتوقيعات</Head>
      <T size={TYPE.body} color={C.muted} style={{ marginBottom: 10, lineHeight: 21 }}>{HANDOVER_LEGAL_FOOTER}</T>
      <Row>
        <View style={{ flex: 1 }}><Field label="اسم المستأجر / المستلم (توقيع)" value={tenantSign} onChange={setTenantSign} disabled={readOnly} /></View>
        <View style={{ flex: 1 }}><Field label="اسم ممثل الشركة / المالك (توقيع)" value={companySign} onChange={setCompanySign} disabled={readOnly} /></View>
      </Row>
    </Sheet>
  );
}
