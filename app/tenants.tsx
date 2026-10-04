/**
 * المستأجرون · الشاشة الأم لكيان المستأجر: الجميع بعقودهم وأرصدتهم،
 * والضغط يفتح الملف الكامل، وزر «+ مستأجر» هنا وحده في التطبيق كله.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Pressable, FlatList } from 'react-native';
import { Screen } from '../src/ui/Screen';
import { Card, T, Num, Money, EmptyState, Row, SearchBox, BtnPrimary, BtnGhost, Field, Divider } from '../src/ui/components';
import { Sheet, SelectField } from '../src/ui/Sheet';
import { TenantProfileSheet, SimilarTenantsSheet } from '../src/ui/TenantProfileSheet';
import { FilterBar, FilterSheet, useFilterSheet, type ActiveChip } from '../src/ui/FilterSheet';
import { usePager, Pager } from '../src/ui/Pager';
import { useDeferredReady } from '../src/ui/useDeferredReady';
import { Skeleton } from '../src/ui/Skeleton';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { C, TYPE } from '../src/ui/theme';
import { allInstallments } from '../src/domain/stats';
import { today } from '../src/domain/dates';
import { toHalalas } from '../src/domain/money';
import { uid } from '../src/domain/ids';
import { logAudit } from '../src/domain/audit';
import { usePerm } from '../src/ui/access';

interface TenantRow {
  id: string; name: string; phone: string; national_id: string;
  contracts: number; outstanding: number; credit: number;
}

const EMPTY_TENANTS: TenantRow[] = [];

const MONEY_LABELS: Record<string, string> = {
  due: 'عليه متأخرات', clear: 'لا متأخرات عليه', credit: 'له رصيد دائن',
};
const MONEY_OPTIONS = [{ value: '', label: 'كل الحالات المالية' },
  ...Object.entries(MONEY_LABELS).map(([value, label]) => ({ value, label }))];
const CONTRACT_LABELS: Record<string, string> = { has: 'له عقود', none: 'بلا عقود' };
const CONTRACT_OPTIONS = [{ value: '', label: 'الكل' },
  ...Object.entries(CONTRACT_LABELS).map(([value, label]) => ({ value, label }))];

/**
 * مفتاح تشابه الأسماء · بلا مسافات ولا «ال» التعريف · يُحسب على الأسماء وحدها
 * بلا استعلام لكل مستأجر، وبه يُعرف: هل هناك متشابهون يستحقون زر الدمج أصلاً؟
 */
const similarKey = (name: string): string =>
  name.trim().replace(/\s+/g, '').replace(/^ال/, '').replace(/ال(?=[؀-ۿ]{2,})/g, '');

const TenantCard = React.memo(function TenantCard({
  id, name, phone, contracts, outstanding, credit, showMoney, onOpen,
}: {
  id: string; name: string; phone: string; contracts: number;
  outstanding: number; credit: number;
  /** المتأخرات والرصيد من التحصيل · لا تُعرض لمن لا يرى التحصيل */
  showMoney: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <Pressable onPress={() => onOpen(id)}>
      <Card style={{ paddingVertical: 10 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T size={TYPE.sectionTitle} bold style={{ flex: 1 }}>{name}</T>
          {showMoney ? <Money halalas={outstanding} size={TYPE.cardTitle} bold color={outstanding > 0 ? C.rose : C.emerald} /> : null}
        </Row>
        <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
          <Row gap={8}>
            {phone ? <Num size={TYPE.caption} color={C.muted}>{phone}</Num> : null}
            <T size={TYPE.caption} color={C.muted}>· {contracts} عقود</T>
          </Row>
          {showMoney && credit > 0 ? <Row gap={4}><T size={TYPE.caption} color={C.emerald}>رصيد دائن</T><Money halalas={credit} size={TYPE.caption} color={C.emerald} /></Row> : null}
        </Row>
        <Divider />
      </Card>
    </Pressable>
  );
});

export default function Tenants() {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const perm = usePerm('tenants');
  // المتأخرات والرصيد الدائن بيانات مرتبطة · لمن يرى التحصيل وحده (الحد اللازم)
  const seesMoney = usePerm('collect').view;
  const [q, setQ] = useState('');
  const [fMoney, setFMoney] = useState('');
  const [fContracts, setFContracts] = useState('');
  const [profileId, setProfileId] = useState<string | null>(null);
  const [similarOpen, setSimilarOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [tName, setTName] = useState('');
  const [tVat, setTVat] = useState('');
  const [tPhone, setTPhone] = useState('');
  const [tCredit, setTCredit] = useState('');
  const pager = usePager('tenants');
  const fsheet = useFilterSheet();
  const ready = useDeferredReady();

  const needle = q.trim();
  useEffect(() => { pager.reset(); /* البحث أو المرشِّحات تغيّرت · نعود للصفحة الأولى */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, fMoney, fContracts]);

  // هل بين المستأجرين أسماء متشابهة أصلاً؟ استعلام أسماء واحد لا استعلام لكل اسم ·
  // فإن لم يكن فلا يُعرض زر «المتشابهون · دمج» إطلاقاً
  const hasSimilar = useMemo(() => {
    if (!ready) return false;
    const seen = new Set<string>();
    for (const t of db.all<{ name: string }>(`SELECT name FROM tenants WHERE deleted_at IS NULL`)) {
      const k = similarKey(t.name);
      if (!k) continue;
      if (seen.has(k)) return true;
      seen.add(k);
    }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready]);

  // الأساس الثقيل: تجميع الأقساط والعقود لكل المستأجرين · لا يتأثر بالبحث ولا بالصفحة
  const base = useMemo<TenantRow[]>(() => {
    if (!ready) return EMPTY_TENANTS;
    const T_ = today();
    const insts = allInstallments(db, T_);
    const outstanding = new Map<string, number>();
    for (const x of insts) {
      if (x.remaining > 0 && x.status !== 'ملغية' && x.contractStatus !== 'ملغى') {
        const k = x.tenant.trim();
        outstanding.set(k, (outstanding.get(k) || 0) + x.remaining);
      }
    }
    const counts = new Map(
      db.all<{ t: string; n: number }>(
        `SELECT TRIM(tenant_name) AS t, COUNT(*) AS n FROM contracts
         WHERE status != 'مسودة' AND deleted_at IS NULL GROUP BY TRIM(tenant_name)`
      ).map((r) => [r.t, Number(r.n)])
    );
    return db.all<{ id: string; name: string; phone: string; national_id: string; credit_halalas: number }>(
      `SELECT id, name, phone, COALESCE(national_id, '') AS national_id, COALESCE(credit_halalas, 0) AS credit_halalas
       FROM tenants WHERE archived = 0 AND deleted_at IS NULL ORDER BY name`
    ).map((t) => ({
      id: t.id, name: t.name, phone: t.phone, national_id: t.national_id,
      contracts: counts.get(t.name.trim()) ?? 0,
      outstanding: outstanding.get(t.name.trim()) ?? 0,
      credit: Number(t.credit_halalas),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready]);

  // الترشيح والصفحة فقط · البحث في SQL على جدول المستأجرين لقائمة المعرّفات
  const { rows, total } = useMemo(() => {
    let list = base;
    if (needle) {
      const ids = new Set(
        db.all<{ id: string }>(
          `SELECT id FROM tenants
           WHERE archived = 0 AND deleted_at IS NULL
             AND (name LIKE '%'||?||'%' OR phone LIKE '%'||?||'%' OR COALESCE(national_id,'') LIKE '%'||?||'%')`,
          [needle, needle, needle]
        ).map((r) => r.id)
      );
      list = base.filter((t) => ids.has(t.id));
    }
    if (fMoney === 'due') list = list.filter((t) => t.outstanding > 0);
    else if (fMoney === 'clear') list = list.filter((t) => t.outstanding <= 0);
    else if (fMoney === 'credit') list = list.filter((t) => t.credit > 0);
    if (fContracts === 'has') list = list.filter((t) => t.contracts > 0);
    else if (fContracts === 'none') list = list.filter((t) => t.contracts === 0);
    return { rows: list.slice(pager.offset, pager.offset + pager.limit), total: list.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, needle, fMoney, fContracts, pager.offset, pager.limit]);

  const saveTenant = () => {
    if (!tName.trim()) { toast('الرجاء إدخال اسم المستأجر'); return; }
    const dup = db.get(
      `SELECT id FROM tenants WHERE deleted_at IS NULL AND (TRIM(name) = TRIM(?) OR (? != '' AND TRIM(vat) = TRIM(?)))`,
      [tName, tVat, tVat]
    );
    if (dup) { toast('يوجد مستأجر مسجَّل بنفس الاسم أو الرقم الضريبي بالفعل · تحقق من القائمة قبل الإضافة'); return; }
    db.transaction(() => {
      db.run(`INSERT INTO tenants (id, name, vat, phone, credit_halalas, created_at) VALUES (?,?,?,?,?,?)`, [
        uid(), tName.trim(), tVat.trim(), tPhone.trim(), toHalalas(tCredit), new Date().toISOString(),
      ]);
      logAudit(db, 'العملاء', 'create', 'مستأجر', tName.trim());
    });
    setFormOpen(false); setTName(''); setTVat(''); setTPhone(''); setTCredit('');
    bump();
    toast(`تمت إضافة المستأجر "${tName.trim()}" بنجاح`);
  };

  const openProfile = useCallback((id: string) => setProfileId(id), []);

  const renderTenant = useCallback(({ item }: { item: TenantRow }) => (
    <TenantCard
      id={item.id} name={item.name} phone={item.phone} contracts={item.contracts}
      outstanding={item.outstanding} credit={item.credit} showMoney={seesMoney} onOpen={openProfile}
    />
  ), [openProfile, seesMoney]);

  const clearFilters = useCallback(() => { setQ(''); setFMoney(''); setFContracts(''); }, []);
  const chips: ActiveChip[] = [
    ...(fMoney ? [{ key: 'money', label: MONEY_LABELS[fMoney] ?? fMoney, onClear: () => setFMoney('') }] : []),
    ...(fContracts ? [{ key: 'contracts', label: CONTRACT_LABELS[fContracts] ?? fContracts, onClear: () => setFContracts('') }] : []),
  ];

  return (
    <Screen title="المستأجرون" icon="collect" scroll={false}
      actions={perm.add ? <BtnPrimary small title="+ مستأجر" onPress={() => setFormOpen(true)} /> : undefined}>
      <FilterBar chips={chips} onOpen={fsheet.show} onClearAll={clearFilters}
        resultCount={total} total={base.length} filtered={total} itemName="مستأجراً"
        search={<SearchBox value={q} onChange={setQ} />} />
      {/* لا أسماء متشابهة فلا زر دمج · لا يُعرض ثم يقول «لا يوجد» · والدمج تعديل فلصاحب «كامل» */}
      {hasSimilar && perm.manage ? (
        <Row style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
          <BtnGhost small title="المتشابهون · دمج" onPress={() => setSimilarOpen(true)} />
        </Row>
      ) : null}
      {!ready ? <Skeleton /> : (
        <FlatList
          data={rows}
          keyExtractor={(t) => t.id}
          renderItem={renderTenant}
          ListEmptyComponent={<Card><EmptyState>{base.length ? 'لا يوجد مستأجرون مطابقون' : perm.add ? 'أضف مستأجراً بزر «+ مستأجر»' : 'لا يوجد مستأجرون'}</EmptyState></Card>}
          ListFooterComponent={<Pager pager={pager} total={total} />}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
        />
      )}

      <FilterSheet open={fsheet.open} onClose={fsheet.hide} onClearAll={clearFilters} resultCount={total}>
        {/* المرشِّح المالي يكشف المتأخرات · لمن يرى التحصيل وحده */}
        {seesMoney ? <SelectField label="الحالة المالية" value={fMoney} options={MONEY_OPTIONS} onPick={setFMoney} /> : null}
        <SelectField label="العقود" value={fContracts} options={CONTRACT_OPTIONS} onPick={setFContracts} />
      </FilterSheet>

      <Sheet
        visible={formOpen}
        onClose={() => setFormOpen(false)}
        title="مستأجر جديد"
        footer={
          <>
            <View style={{ flex: 1 }}><BtnPrimary title="إضافة المستأجر" onPress={saveTenant} /></View>
          </>
        }
      >
        <Field label="اسم المستأجر" value={tName} onChange={setTName} />
        <Field label="الرقم الضريبي" value={tVat} onChange={setTVat} keyboard="numeric" ltr placeholder="300XXXXXXXXXXX" />
        <Row>
          <View style={{ flex: 1 }}>
            <Field label="رقم الجوال" value={tPhone} onChange={setTPhone} keyboard="phone-pad" ltr placeholder="05XXXXXXXX" />
          </View>
          {/* الرصيد مبلغ من التحصيل · لمن يرى التحصيل وحده */}
          {seesMoney ? (
            <View style={{ flex: 1 }}>
              <Field label="حد الائتمان" value={tCredit} onChange={setTCredit} keyboard="numeric" ltr />
            </View>
          ) : null}
        </Row>
      </Sheet>
      {profileId && <TenantProfileSheet tenantId={profileId} onClose={() => setProfileId(null)} />}
      {similarOpen && <SimilarTenantsSheet onClose={() => setSimilarOpen(false)} />}
    </Screen>
  );
}
