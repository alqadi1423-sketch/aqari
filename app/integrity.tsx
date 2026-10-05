/** فحص المطابقة · الفحوص تربط الدفتر بالعمليات، وأدوات البيانات السابقة تُعاين ثم تُطبَّق بقرار المالك */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Screen } from '../src/ui/Screen';
import { Card, CardTitle, T, Num, Row, BtnPrimary, BtnGhost } from '../src/ui/components';
import { useApp } from '../src/ui/store';
import { C } from '../src/ui/theme';
import { Icon } from '../src/ui/icons';
import { useAccess } from '../src/ui/access';
import { useDialog } from '../src/ui/AppDialog';
import { useToast } from '../src/ui/Toast';
import { reportFailure } from '../src/ui/failureDialog';
import { integrityChecks } from '../src/domain/accounting/integrity';
import { previewRepairs, applyRepair, type RepairPreview } from '../src/domain/reviewRepairs';
import { previewEjarSchedules, applyEjarSchedules, contractsWithLease, type EjarScheduleDiff } from '../src/domain/ejarScheduleRepair';
import { readLeaseText } from '../src/services/contractScan';
import { dfmt } from '../src/domain/dates';

export default function Integrity() {
  const { db, version, bump } = useApp();
  const access = useAccess();
  const dialog = useDialog();
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const checks = useMemo(() => integrityChecks(db),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, tick]);
  // المعاينة قراءة فقط · والتطبيق للمالك وحده، فالأداة لا تظهر لغيره
  const repairs = useMemo(() => (access.owner ? previewRepairs(db).filter((r) => r.items.length) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, tick, access.owner]);
  const ok = checks.every((c) => c.ok);
  // أقساط عقود إيجار مقابل جدول ملفها (قرار المالك ٢٠٢٦-١٠-٠٥) · القراءة من الملفات بطلب لا عند الفتح
  const leaseCount = useMemo(() => (access.owner ? contractsWithLease(db).length : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, access.owner]);
  const [ejar, setEjar] = useState<EjarScheduleDiff[] | null>(null);
  const [reading, setReading] = useState(false);

  const apply = (r: RepairPreview) => {
    const ready = r.items.filter((i) => !i.blocked).length;
    dialog({
      title: r.title,
      body: 'يُطبَّق على ' + ready + ' من ' + r.items.length + '، بقيود عاكسة وتعديلات مسجّلة في سجل العمليات. هل تطبّقه؟',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'تطبيق', variant: 'primary',
          onPress: () => {
            try { const n = applyRepair(db, r.key); bump(); toast('طُبّق على ' + n); }
            catch (e) { reportFailure({ title: 'تعذّر التطبيق', e }); }
          },
        },
      ],
    });
  };

  return (
    <Screen title="فحص المطابقة"
      actions={<BtnPrimary small title="أعد الفحص" onPress={() => setTick((t) => t + 1)} />}>
      <Card>
        <View style={{
          borderRadius: 8, padding: 11, alignItems: 'center', marginBottom: 10,
          backgroundColor: ok ? C.emeraldSoft : C.roseSoft,
        }}>
          <T size={13} bold color={ok ? C.emerald : C.rose}>
            {ok ? 'الدفتر يطابق العمليات' : 'يوجد انفصال بين الدفتر والعمليات'}
          </T>
        </View>
        {/* سطران لكل فحص: الاسم يلتف كاملاً والرقم تحته كاملاً · لا يُقصّ رقم في أي شاشة */}
        {checks.map((c) => (
          <View key={c.name} style={{ paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <Row gap={6} style={{ alignItems: 'flex-start' }}>
              <Icon name={c.ok ? 'check' : 'cancel'} size={14} color={c.ok ? C.emerald : C.rose} />
              <T size={12.5} style={{ flex: 1 }}>{c.name}</T>
            </Row>
            <Num size={12.5} bold color={c.ok ? C.emerald : C.rose}
              style={{ marginTop: 4, marginStart: 20, textAlign: 'left' }}>
              {c.value}
            </Num>
          </View>
        ))}
      </Card>
      {access.owner && leaseCount ? (
        <Card>
          <CardTitle>أقساط عقود إيجار مقابل جدول ملفها</CardTitle>
          <T size={12} color={C.muted} style={{ marginBottom: 8 }}>
            {'يقرأ جدول الدفعات من ملف كل عقد مرفق (' + leaseCount + ') ويقارنه بتواريخ أقساطه · المبالغ والمسدَّد لا تُمسّ، والتطبيق بضغطتك.'}
          </T>
          {ejar === null ? (
            <BtnGhost title={reading ? 'جاري قراءة الملفات' : 'اقرأ الملفات وقارن'} onPress={async () => {
              if (reading) return;
              setReading(true);
              try { setEjar(await previewEjarSchedules(db, (id) => readLeaseText(db, id))); }
              catch (e) { reportFailure({ title: 'تعذّرت المقارنة', e }); }
              setReading(false);
            }} />
          ) : !ejar.length ? (
            <T size={12.5} color={C.emerald}>كل الأقساط تطابق جداول ملفاتها</T>
          ) : (
            <>
              {ejar.map((d) => (
                <View key={d.contractId} style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
                  <T size={12.5}>{d.label}</T>
                  {d.blocked ? <T size={11.5} color={C.rose}>{d.blocked}</T> : (
                    <T size={11.5} color={C.muted}>{d.changes.length + ' قسط · مثل ' + dfmt(d.changes[0].from) + ' ← ' + dfmt(d.changes[0].to)}</T>
                  )}
                </View>
              ))}
              {ejar.some((d) => !d.blocked) ? (
                <View style={{ marginTop: 10 }}>
                  <BtnGhost title="طبّق تواريخ الملفات" onPress={() => dialog({
                    title: 'تواريخ الأقساط من ملفات إيجار',
                    body: 'تُصحَّح تواريخ استحقاق ' + ejar.filter((d) => !d.blocked).length + ' عقداً كما في جداول ملفاتها، والمبالغ والمسدَّد كما هي. هل تطبّقه؟',
                    actions: [
                      { label: 'تراجع', variant: 'ghost' },
                      { label: 'تطبيق', variant: 'primary', onPress: () => {
                        try { const n = applyEjarSchedules(db, ejar); setEjar(null); bump(); toast('طُبّق على ' + n + ' عقداً'); }
                        catch (e) { reportFailure({ title: 'تعذّر التطبيق', e }); }
                      } },
                    ],
                  })} />
                </View>
              ) : null}
            </>
          )}
        </Card>
      ) : null}
      {repairs.map((r) => (
        <Card key={r.key}>
          <CardTitle>{r.title} · {r.items.length}</CardTitle>
          <T size={12} color={C.muted} style={{ marginBottom: 8 }}>{r.explain}</T>
          {r.items.map((i) => (
            <View key={i.id} style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <T size={12.5}>{i.label}</T>
              <T size={11.5} color={C.muted}>{i.detail}</T>
              {i.blocked ? <T size={11.5} color={C.rose}>{i.blocked}</T> : null}
            </View>
          ))}
          {r.items.some((i) => !i.blocked) ? (
            <View style={{ marginTop: 10 }}><BtnGhost title="تطبيق التصحيح" onPress={() => apply(r)} /></View>
          ) : null}
        </Card>
      ))}
    </Screen>
  );
}
