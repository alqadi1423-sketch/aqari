/** بيانات المنشأة · الاسم والأرقام والشعار والمستندات الرسمية والإضافية */
import React, { useMemo, useState } from 'react';
import { View, Image } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Screen } from '../src/ui/Screen';
import { Card, CardTitle, T, Num, EmptyState, Row, Badge, BtnPrimary, BtnGhost, Field } from '../src/ui/components';
import { Sheet } from '../src/ui/Sheet';
import { DateField } from '../src/ui/DateField';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { useDialog } from '../src/ui/AppDialog';
import { C } from '../src/ui/theme';
import { Icon } from '../src/ui/icons';
import { ErrorBoundary } from '../src/ui/ErrorBoundary';
import { appFilesEnv } from '../src/services/filesEnv';
import { putAttachment, attachmentsFor, attachmentPath, softDeleteAttachment } from '../src/files/store';
import { daysBetween, dfmt, today } from '../src/domain/dates';
import { uid } from '../src/domain/ids';
import { logAudit } from '../src/domain/audit';
import { reportFailure } from '../src/ui/failureDialog';

const OFFICIAL_DOCS: Array<{ kind: string; label: string; numberField: 'vatno' | 'cr' | null; numberLabel: string | null; expField: boolean }> = [
  { kind: 'vat_cert', label: 'شهادة الرقم الضريبي', numberField: 'vatno', numberLabel: 'الرقم الضريبي (15 رقماً)', expField: false },
  { kind: 'cr_cert', label: 'السجل التجاري', numberField: 'cr', numberLabel: 'رقم السجل التجاري', expField: true },
  { kind: 'addr_cert', label: 'شهادة العنوان الوطني', numberField: null, numberLabel: null, expField: false },
];

function CompanyBody() {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const co = useMemo(
    () => db.get<{ name: string; vatno: string; cr: string; phone: string; address: string; cr_exp: string | null }>(
      `SELECT * FROM company WHERE id = 1`
      // الصف مضمون بالترحيل ١٦ · والبديل الفارغ حزام أمان لقاعدة لم تُرحَّل بعد
    ) ?? { name: '', vatno: '', cr: '', phone: '', address: '', cr_exp: null },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]
  );
  const [name, setName] = useState(co.name ?? '');
  const [phone, setPhone] = useState(co.phone ?? '');
  const [vatno, setVatno] = useState(co.vatno ?? '');
  const [cr, setCr] = useState(co.cr ?? '');
  const [crExp, setCrExp] = useState(co.cr_exp ?? '');
  const [address, setAddress] = useState(co.address ?? '');
  const [docOpen, setDocOpen] = useState(false);
  const [docName, setDocName] = useState('');
  const [docExp, setDocExp] = useState('');
  const [docFile, setDocFile] = useState<{ uri: string; name: string; mime: string } | null>(null);

  const env = appFilesEnv(db);
  const logo = attachmentsFor(db, 'company', '1', 'logo')[0];
  const extraDocs = db.all<{ id: string; name: string; expiry: string | null }>(
    `SELECT id, name, expiry FROM company_docs WHERE deleted_at IS NULL ORDER BY created_at DESC`
  );

  const save = () => {
    db.transaction(() => {
      db.run(`UPDATE company SET name=?, vatno=?, cr=?, phone=?, address=?, cr_exp=? WHERE id=1`, [
        name.trim(), vatno.trim(), cr.trim(), phone.trim(), address.trim(), crExp.trim() || null,
      ]);
      logAudit(db, 'بيانات المنشأة', 'update', 'منشأة', name.trim());
    });
    bump();
    toast('تم حفظ بيانات المنشأة');
  };

  const pickLogo = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
    if (res.canceled || !res.assets?.length) return;
    const a = res.assets[0];
    try {
      const bytes = new File(a.uri).bytesSync();
      if (logo) softDeleteAttachment(db, logo.id);
      await putAttachment(env, bytes, {
        entityType: 'company', entityId: '1', kind: 'logo',
        originalName: a.fileName ?? 'logo.png', mime: a.mimeType ?? 'image/png',
      });
      bump();
      toast('تم رفع الشعار');
    } catch (e) { reportFailure({ title: 'تعذّر حفظ الملف', e }); }
  };

  const uploadOfficial = async (kind: string) => {
    const res = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/*'] });
    if (res.canceled || !res.assets?.length) return;
    const a = res.assets[0];
    try {
      const bytes = new File(a.uri).bytesSync();
      const prev = attachmentsFor(db, 'company', '1', kind)[0];
      if (prev) softDeleteAttachment(db, prev.id);
      await putAttachment(env, bytes, {
        entityType: 'company', entityId: '1', kind,
        originalName: a.name ?? 'ملف', mime: a.mimeType ?? '',
      });
      bump();
      toast('تم رفع الملف');
    } catch (e) { reportFailure({ title: 'تعذّر حفظ الملف', e }); }
  };

  const saveDoc = async () => {
    if (!docName.trim()) { toast('الرجاء إدخال اسم المستند'); return; }
    const docId = uid();
    db.transaction(() => {
      db.run(`INSERT INTO company_docs (id, name, expiry, created_at) VALUES (?,?,?,?)`, [
        docId, docName.trim(), docExp.trim() || null, new Date().toISOString(),
      ]);
      logAudit(db, 'بيانات المنشأة', 'create', 'مستند', docName.trim());
    });
    if (docFile) {
      try {
        const bytes = new File(docFile.uri).bytesSync();
        await putAttachment(env, bytes, {
          entityType: 'company_doc', entityId: docId, kind: 'company',
          originalName: docFile.name, mime: docFile.mime,
        });
      } catch (e) { reportFailure({ title: 'تعذّر حفظ الملف', e }); }
    }
    setDocOpen(false); setDocName(''); setDocExp(''); setDocFile(null);
    bump();
    toast('أُضيف المستند');
  };

  const expiryBadge = (exp: string | null) => {
    if (!exp) return <Badge kind="paid" label="بلا تاريخ" />;
    const days = daysBetween(exp, today());
    if (days < 0) return <Badge kind="overdue" label={'منتهي منذ ' + dfmt(exp)} />;
    if (days <= 60) return <Badge kind="due" label={'ينتهي خلال ' + days + ' يوماً'} />;
    return <Badge kind="paid" label={'ساري حتى ' + dfmt(exp)} />;
  };

  return (
    <Screen title="بيانات المنشأة"
      actions={<BtnPrimary small title="حفظ البيانات" onPress={save} />}>
      <Card>
        <CardTitle>بيانات المنشأة</CardTitle>
        <Row style={{ marginBottom: 10 }}>
          <View style={{
            width: 64, height: 64, borderWidth: 1, borderColor: C.line, borderRadius: 8,
            alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: C.paper,
          }}>
            {logo && env.fs.exists(attachmentPath(env, logo)) ? (
              <Image source={{ uri: 'file://' + attachmentPath(env, logo).replace(/^file:\/\//, '') }} style={{ width: 64, height: 64 }} resizeMode="contain" />
            ) : <Icon name="building" size={24} color={C.muted} />}
          </View>
          <View style={{ flex: 1 }}><BtnGhost small title="رفع شعار المنشأة" onPress={pickLogo} /></View>
        </Row>
        <Row>
          <View style={{ flex: 1 }}><Field label="اسم المنشأة" value={name} onChange={setName} /></View>
          <View style={{ flex: 1 }}><Field label="الجوال" value={phone} onChange={setPhone} keyboard="phone-pad" ltr /></View>
        </Row>
        <Field label="العنوان" value={address} onChange={setAddress} />
      </Card>

      <Card>
        <CardTitle>المستندات الرسمية</CardTitle>
        {OFFICIAL_DOCS.map((d) => {
          const file = attachmentsFor(db, 'company', '1', d.kind)[0];
          return (
            <View key={d.kind} style={{ borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 11, marginBottom: 10 }}>
              <T size={12.5} bold style={{ marginBottom: 6 }}>{d.label}</T>
              {d.numberField === 'vatno' && (
                <Field label={d.numberLabel!} value={vatno} onChange={setVatno} keyboard="numeric" ltr placeholder="300XXXXXXXXXXX" />
              )}
              {d.numberField === 'cr' && (
                <Field label={d.numberLabel!} value={cr} onChange={setCr} keyboard="numeric" ltr placeholder="1013" />
              )}
              {d.expField && <DateField label="تاريخ الانتهاء" value={crExp} onChange={setCrExp} />}
              <Row>
                <BtnGhost small icon={file ? 'reload' : 'export'} title={file ? 'استبدال الملف' : 'رفع الملف'} onPress={() => uploadOfficial(d.kind)} />
                {!file && <T size={10.5} color={C.muted}>لم يُرفع ملف بعد</T>}
              </Row>
            </View>
          );
        })}
      </Card>

      <Card>
        <CardTitle action={<BtnPrimary small title="+ إضافة مستند" onPress={() => setDocOpen(true)} />}>
          مستندات إضافية
        </CardTitle>
        {extraDocs.length ? extraDocs.map((d) => (
          <View key={d.id} style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={12.5} med>{d.name}</T>
              {expiryBadge(d.expiry)}
            </Row>
            <Row style={{ justifyContent: 'flex-end', marginTop: 5 }}>
              <BtnGhost small danger icon="trash" title="حذف"
                onPress={() => dialog({
                  title: 'حذف المستند',
                  body: 'حذف هذا المستند؟',
                  tone: 'danger',
                  actions: [
                    { label: 'تراجع', variant: 'ghost' },
                    {
                      label: 'حذف', variant: 'danger',
                      onPress: () => {
                        db.transaction(() => db.run(`UPDATE company_docs SET deleted_at=? WHERE id=?`, [new Date().toISOString(), d.id]));
                        bump(); toast('تم الحذف');
                      },
                    },
                  ],
                })} />
            </Row>
          </View>
        )) : <EmptyState>لا توجد مستندات إضافية</EmptyState>}
      </Card>

      <Sheet visible={docOpen} onClose={() => setDocOpen(false)} title="مستند جديد"
        footer={
          <>
            <View style={{ flex: 1 }}><BtnPrimary title="إضافة المستند" onPress={saveDoc} /></View>
          </>
        }>
        <Field label="اسم المستند" value={docName} onChange={setDocName} />
        <DateField label="تاريخ الانتهاء" value={docExp} onChange={setDocExp} />
        <BtnGhost small icon="attach" title={docFile ? docFile.name : 'اختيار الملف'}
          onPress={async () => {
            const res = await DocumentPicker.getDocumentAsync({});
            if (!res.canceled && res.assets?.length) {
              const a = res.assets[0];
              setDocFile({ uri: a.uri, name: a.name ?? 'ملف', mime: a.mimeType ?? '' });
            }
          }} />
      </Sheet>
    </Screen>
  );
}

/**
 * حدود الخطأ حول الشاشة كلها: أي استثناء يعرض بطاقة خطأ بنصّه القابل
 * للنسخ والإرسال ويُسجَّل في سجل العمليات · ولا يُغلق التطبيق أبداً.
 */
export default function Company() {
  return (
    <ErrorBoundary where="بيانات المنشأة">
      <CompanyBody />
    </ErrorBoundary>
  );
}
