/**
 * ملف المستأجر · الشخص لا النص: كل عقوده عبر عقاراته، أرصدته، مطالباته،
 * والتزامه بالسداد · وتعديل اسمه هنا في مصدره فتتبعه عقوده كلها.
 * أقسامه مطوية: الفارغ لا يُعرض، والمملوء لا يُجلب محتواه إلا عند فتحه.
 * ومعه أداة «المتشابهون»: مجموعات الأسماء المتقاربة تُعرض ليقرّر المستخدم دمجها.
 */
import React, { useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Sheet } from './Sheet';
import { T, Num, Money, Row, KpiCard, BtnGhost, BtnPrimary, BtnIcon, Field, EmptyState, Badge } from './components';
import { CollapsibleSection } from './Collapsible';
import { useApp } from './store';
import { AttachStrip } from './AttachStrip';
import { attachPicked, pickFile } from './attach';
import { useToast } from './Toast';
import { useDialog } from './AppDialog';
import { C, TYPE } from './theme';
import { tenantProfile, renameTenant, similarTenantGroups, mergeTenants } from '../domain/tenants';
import { contractStatusKind, contractStatusLabel } from '../domain/contracts/rules';
import { today, dfmt } from '../domain/dates';
import { fmt } from '../domain/money';
import { useLang } from '../i18n';
import { reportFailure } from './failureDialog';
import { useAccess, usePerm } from './access';
import { routeAllowed } from '../domain/access/routes';
import { canMergeTenants } from '../domain/access/access';
import { useSaveAttempt } from './formAttempt';

export function TenantProfileSheet({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const router = useRouter();
  const perm = usePerm('tenants');
  const access = useAccess();
  const openContracts = routeAllowed(access, '/contracts');
  const openClaims = routeAllowed(access, '/claims');
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const renameTry = useSaveAttempt();
  const { t } = useLang();
  const p = useMemo(() => tenantProfile(db, tenantId, today()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, tenantId]);
  /** عدّاد قسم المستندات · استعلام COUNT خفيف قبل الفتح */
  const attCount = useMemo(() => Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attachments WHERE entity_type = 'tenant' AND entity_id = ? AND deleted_at IS NULL`,
    [tenantId])?.n ?? 0),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, version, tenantId]);

  const addDoc = async () => {
    const f = await pickFile();
    if (!f) return;
    attachPicked(db, f, 'tenant', tenantId, 'tenant_id')
      .then(() => { bump(); toast('أُرفق وظهر في المكتبة تحت تصنيفه'); })
      .catch((e) => reportFailure({ title: 'تعذّر الإرفاق', e }));
  };

  if (!p) return null;
  return (
    <Sheet visible onClose={onClose} title={p.tenant.name} tall>
      {p.tenant.national_id || p.tenant.phone ? (
        <Row gap={8} style={{ marginBottom: 8 }}>
          {p.tenant.national_id ? <Num size={TYPE.caption} color={C.muted}>الهوية: {p.tenant.national_id}</Num> : null}
          {p.tenant.phone ? <Num size={TYPE.caption} color={C.muted}>{p.tenant.national_id ? '· ' : ''}الجوال: {p.tenant.phone}</Num> : null}
        </Row>
      ) : null}
      <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <KpiCard label="المستحق حتى اليوم" tone="neu" value={<Money halalas={p.totals.dueToDate} />} />
        <KpiCard label="المحصَّل" tone="pos" value={<Money halalas={p.totals.collected} />} />
      </Row>
      <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <KpiCard label="المتبقي عليه" tone={p.totals.outstanding > 0 ? 'neg' : 'pos'}
          value={<Money halalas={p.totals.outstanding} />} />
        <KpiCard label="الالتزام بالسداد" tone={p.onTimePct == null ? 'neu' : p.onTimePct >= 80 ? 'pos' : 'neg'}
          value={p.onTimePct == null ? '' : <Num>{p.onTimePct + '٪'}</Num>}
          sub={p.claims.count ? `${p.claims.count} مطالبة بمبلغ ${fmt(p.claims.amountHalalas)}` : 'لا مطالبات'} />
      </Row>

      {/* أفعال الملف · الإرفاق أيقونة عارية بمحاذاة زر تعديل الاسم */}
      {perm.add ? (
        <Row style={{ justifyContent: 'flex-end', marginBottom: 4 }}>
          {perm.manage ? (
            <BtnGhost small title="تعديل الاسم" onPress={() => { setNewName(p.tenant.name); renameTry.reset(); setRenaming(true); }} />
          ) : null}
          <BtnIcon icon="attach" accessibilityLabel="إضافة مستند" onPress={addDoc} />
        </Row>
      ) : null}

      <CollapsibleSection title="عقوده" count={p.contracts.length} icon="contract" pageKey="tenantContracts">
        {(page) => p.contracts.slice(page.offset, page.offset + page.limit).map((c) => (
          <Pressable key={c.id} disabled={!openContracts} onPress={() => { onClose(); router.push(`/contracts?detail=${c.id}`); }}>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <View style={{ flex: 1 }}>
                <T size={TYPE.cardTitle} bold>{c.unit_label}</T>
                {/* ما غاب من الأجزاء غاب بفاصله · لا «لا يوجد» */}
                {[c.contract_no, c.start && c.end ? dfmt(c.start) + ' إلى ' + dfmt(c.end) : c.start ? 'من ' + dfmt(c.start) : ''].filter(Boolean).length
                  ? <Num size={TYPE.caption} color={C.muted}>{[c.contract_no, c.start && c.end ? dfmt(c.start) + ' إلى ' + dfmt(c.end) : c.start ? 'من ' + dfmt(c.start) : ''].filter(Boolean).join(' · ')}</Num>
                  : null}
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Money halalas={Number(c.total_halalas)} size={TYPE.cardTitle} bold />
                {/* التفصيل حين يكون في العقد خدمات أو مواقف (المراجعة #5) */}
                {Number(c.services_halalas) || Number(c.parking_halalas) ? (
                  <T size={TYPE.caption} color={C.muted}>{t('lease.splitLine', { rent: fmt(Number(c.value_halalas)), services: fmt(Number(c.services_halalas)), parking: fmt(Number(c.parking_halalas)) })}</T>
                ) : null}
                {/* الحالة محسوبة من التواريخ لا مخزّنة · فعقد يبدأ غداً «موثَّق ولم يبدأ» لا «سارٍ» */}
                <Badge kind={contractStatusKind(c)} label={contractStatusLabel(c)} />
              </View>
            </Row>
          </Pressable>
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="مطالباته" count={p.claims.count} icon="claim" pageKey="tenantClaims">
        {(page) => db.all<{ id: string; date: string; amount_halalas: number; reason: string; status: string; contract_no: string | null }>(
          `SELECT cl.id, cl.date, cl.amount_halalas, cl.reason, cl.status, c.contract_no
           FROM claims cl JOIN contracts c ON c.id = cl.contract_id
           WHERE c.tenant_id = ? AND cl.deleted_at IS NULL
           ORDER BY cl.date DESC, cl.created_at DESC LIMIT ? OFFSET ?`,
          [tenantId, page.limit, page.offset]
        ).map((cl) => (
          <Pressable key={cl.id} disabled={!openClaims} onPress={() => { onClose(); router.push(`/claims?detail=${cl.id}`); }}>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <View style={{ flex: 1 }}>
                {cl.reason ? <T size={TYPE.cardTitle}>{cl.reason}</T> : null}
                <Num size={TYPE.caption} color={C.muted}>{[cl.contract_no, dfmt(cl.date)].filter(Boolean).join(' · ')}</Num>
              </View>
              <Row gap={8}>
                <Badge kind={cl.status === 'مفتوحة' ? 'overdue' : 'paid'} label={cl.status} />
                <Money halalas={Number(cl.amount_halalas)} size={TYPE.cardTitle} bold />
              </Row>
            </Row>
          </Pressable>
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="هويته ومستنداته" count={attCount} icon="attach">
        {() => (
          <AttachStrip entityType="tenant" entityId={tenantId} kind="tenant_id"
            linked={p.tenant.name} title="هويته ومستنداته" hideAdd canManage={perm.manage} />
        )}
      </CollapsibleSection>

      {/* تعديل الاسم في ورقته الخاصة (قرار المالك 2026-10-07) · الحفظ ظاهر والأحمر بعد المحاولة */}
      {renaming ? (
        <Sheet visible onClose={() => setRenaming(false)} title="تعديل الاسم"
          footer={<View style={{ flex: 1 }}><BtnPrimary title="حفظ · عقوده تتبعه" onPress={() => renameTry.attempt(!!newName.trim(), () => {
            try {
              renameTenant(db, tenantId, newName);
              setRenaming(false); bump();
              toast('عُدّل الاسم في مصدره وتبعته عقوده كلها');
            } catch (e) {
              reportFailure({ title: 'تعذّر تعديل الاسم', e });
            }
          })} /></View>}>
          <Field label="الاسم" value={newName} onChange={setNewName} error={renameTry.missing(newName)} />
        </Sheet>
      ) : null}
      <View style={{ height: 10 }} />
    </Sheet>
  );
}

/** المتشابهون · الدمج قرار المستخدم لا التطبيق */
export function SimilarTenantsSheet({ onClose }: { onClose: () => void }) {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  // الدمج يعدّل العقود ويحذف المستأجرين · كامل في كل العقارات وحده
  const canMerge = canMergeTenants(useAccess());
  const groups = useMemo(() => similarTenantGroups(db),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  return (
    <Sheet visible onClose={onClose} title="مستأجرون متشابهون" tall>
      {groups.length ? groups.map((g) => (
        <View key={g.key} style={{ borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 10, marginBottom: 10 }}>
          {g.tenants.map((t, i) => (
            <Row key={t.id} style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
              <T size={TYPE.cardTitle} bold={i === 0}>{t.name}{i === 0 ? ' (الوجهة)' : ''}</T>
              <Num size={TYPE.caption} color={C.muted}>{[t.national_id, t.contracts + ' عقد'].filter(Boolean).join(' · ')}</Num>
            </Row>
          ))}
          {canMerge ? <View style={{ marginTop: 6 }}>
            <BtnGhost small title={'دمج الكل في «' + g.tenants[0].name + '»'} onPress={() => {
              dialog({
                title: 'دمج المستأجرين',
                body: 'تُنقل كل العقود إلى «' + g.tenants[0].name + '» ويُحذف الباقون إلى سلة المحذوفات. متابعة؟',
                tone: 'danger',
                actions: [
                  { label: 'تراجع', variant: 'ghost' },
                  {
                    label: 'دمج', variant: 'danger',
                    onPress: () => {
                      try {
                        mergeTenants(db, g.tenants[0].id, g.tenants.slice(1).map((x) => x.id));
                        bump(); toast('دُمجوا في سجل واحد وتبعته العقود');
                      } catch (e) {
                        reportFailure({ title: 'تعذّر الدمج', e });
                      }
                    },
                  },
                ],
              });
            }} />
          </View> : null}
        </View>
      )) : <EmptyState>لا أسماء متشابهة · كل مستأجر سجل واحد</EmptyState>}
      <View style={{ height: 10 }} />
    </Sheet>
  );
}
