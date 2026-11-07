/**
 * التوجيه الثالث · ١ · أبعاد قيد التحصيل (قرار المالك 2026-11-07): rentEntryIssue كان يطابق الحساب والمبلغ ولا يطابق أبعاد السطور
 * (contract_id وproperty_id وunit_id)، فعضوٌ يضع فائض 2410 على عقد مستأجرٍ آخر، و«الرصيد المتاح» يُحسب منه فيُسدَّد به قسط غيره.
 * الأبعاد تُشتق من الدفعة وعقدها وتُطابق كالحساب والمبلغ: العقد عقد الدفعة، والوحدة وحدته، والعقار عقارها (أو عقارٌ نُقلت منه الوحدة
 * بعد أن كتب العضو قيده، فلا يُرفض تحصيلٌ مشروع سبق النقل). بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import { confirmContract, recordRentPayment, recordBulkRentPayment, applyTenantCredit, tenantCreditOf } from '@/domain/contracts/service';
import { saveUnit } from '@/domain/propertiesService';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

const UID = 'owner-d3';
const MEMBER = 'member-d3';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const reasonOf = (db: DB, pk: string) => db.get<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE pk = ? ORDER BY id DESC`, [pk])?.reason ?? '';
const has = (db: DB, id: string) => !!db.get(`SELECT 1 FROM journal_entries WHERE id = ? AND status = 'مرحّل'`, [id]);

/** جهاز المالك وجهازٌ ثانٍ · عقدان لمستأجرين في عقارين · الثاني يحصّل ثم يرفع، وقيده يُعلَّم بكاتبه العضو */
async function setup() {
  const r = new MemoryRemote();
  const owner = memDb();
  const dev = memDb();
  enableSync(owner, UID);
  enableSync(dev, UID);
  const pa = addProperty(owner, { name: 'عقار أبعاد أ مصطنع' });
  const pb = addProperty(owner, { name: 'عقار أبعاد ب مصطنع' });
  const ua = addUnit(owner, pa, { unit_no: 'DA-1', rent: 100000 });
  const ub = addUnit(owner, pb, { unit_no: 'DB-1', rent: 100000 });
  const a = confirmContract(owner, contractInput(ua, { tenant: 'مستأجر أبعاد أ مصطنع', idNumber: '1000001001', phone: '0500001001',
    start: '2026-01-01', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
  const b = confirmContract(owner, contractInput(ub, { tenant: 'مستأجر أبعاد ب مصطنع', idNumber: '1000001002', phone: '0500001002',
    start: '2026-01-01', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
  await sync(owner, r);
  await sync(dev, r);
  const insts = (cid: string) => dev.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((x) => x.id);
  return { r, owner, dev, a, b, pa, pb, ua, ub, ia: insts(a), ib: insts(b) };
}
function lastRent(r: MemoryRemote): RemoteDoc {
  const docs = [...r.docs.values()].filter((d) => d.t === 'journal_entries' && d.d?.src_type === 'rent');
  return docs[docs.length - 1];
}
/** قيد التحصيل الأخير في الحساب بكاتبه العضو · وسطوره بعد التعديل */
function asMember(r: MemoryRemote, edit?: (lines: NonNullable<RemoteDoc['lines']>) => NonNullable<RemoteDoc['lines']>): string {
  const o = lastRent(r);
  r.inject({ ...o, by: MEMBER, lines: edit ? edit(o.lines!) : o.lines });
  return o.k;
}

describe('١ · أبعاد قيد التحصيل تُطابق كالحساب والمبلغ', () => {
  test('١ سلبي · فائض التحصيل الجماعي على عقد مستأجرٍ آخر: يُرفض · ولا يصير رصيداً للآخر يُسدَّد به قسطه', async () => {
    const s = await setup();
    // ١٬٢٠٠ ريال على قسطٍ بألف من عقد أ: الفائض ٢٠٠ ريال
    recordBulkRentPayment(s.dev, s.a, { installmentIds: [s.ia[0]], date: '2026-02-01', notes: '', lines: [{ method: 'cash', amountHalalas: 120000 }] });
    await sync(s.dev, s.r);
    const k = asMember(s.r, (ls) => ls.map((l) => (l.account_code === '2410' ? { ...l, contract_id: s.b, property_id: s.pb, unit_id: s.ub } : l)));
    await sync(s.owner, s.r);
    await sync(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/بُعد/);
    expect(tenantCreditOf(s.owner, s.b)).toBe(0);
    s.owner.close(); s.dev.close();
  });

  test('١ سلبي · تحصيل قسطٍ بسطورٍ على عقار الآخر ووحدته: يُرفض', async () => {
    const s = await setup();
    recordRentPayment(s.dev, s.a, { installmentId: s.ia[0], period: 'الأول', date: '2026-02-01', lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
    await sync(s.dev, s.r);
    const k = asMember(s.r, (ls) => ls.map((l) => ({ ...l, property_id: s.pb, unit_id: s.ub })));
    await sync(s.owner, s.r);
    await sync(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/بُعد/);
    s.owner.close(); s.dev.close();
  });

  test('١ سلبي · وسطرٌ بلا عقد (شكلٌ قديم يُفلت الرصيد من مستأجره): يُرفض', async () => {
    const s = await setup();
    recordBulkRentPayment(s.dev, s.a, { installmentIds: [s.ia[0]], date: '2026-02-01', notes: '', lines: [{ method: 'cash', amountHalalas: 120000 }] });
    await sync(s.dev, s.r);
    const k = asMember(s.r, (ls) => ls.map((l) => (l.account_code === '2410' ? { ...l, contract_id: null } : l)));
    await sync(s.owner, s.r);
    await sync(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    s.owner.close(); s.dev.close();
  });

  test('١ سلبي · والمسار النظير: عاكس إلغاء دفعةٍ بسطورٍ على عقد مستأجرٍ آخر يُرفض (ليس مرآة أصله) · والعاكس الأمين يُقبل', async () => {
    const s = await setup();
    const pay = recordBulkRentPayment(s.dev, s.a, { installmentIds: [s.ia[0]], date: '2026-02-01', notes: '', lines: [{ method: 'cash', amountHalalas: 120000 }] });
    await sync(s.dev, s.r);
    asMember(s.r);
    await sync(s.owner, s.r);
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    cancelPayment(s.dev, pay, { date: '2026-02-10', reason: 'إلغاء مصطنع' });
    await sync(s.dev, s.r);
    const revDoc = [...s.r.docs.values()].filter((d) => d.t === 'journal_entries' && d.d?.src_type === 'rent_rev').pop()!;
    s.r.inject({ ...revDoc, by: MEMBER, lines: revDoc.lines!.map((l) => (l.account_code === '2410' ? { ...l, contract_id: s.b, property_id: s.pb, unit_id: s.ub } : l)) });
    await sync(s.owner, s.r);
    await sync(s.owner, s.r);
    expect(has(s.owner, revDoc.k)).toBe(false);
    expect(reasonOf(s.owner, revDoc.k)).toMatch(/مرآة/);
    // والعاكس كما كتبه التطبيق يُقبل
    s.r.inject({ ...revDoc, by: MEMBER });
    await sync(s.owner, s.r);
    await sync(s.owner, s.r);
    expect(has(s.owner, revDoc.k)).toBe(true);
    s.owner.close(); s.dev.close();
  });

  test('١ إيجابي · المسارات الثلاثة بأبعاد عقدها تُقبل: تحصيل قسط، وتحصيل جماعي بفائض، وسدادٌ من الرصيد الدائن', async () => {
    const s = await setup();
    recordRentPayment(s.dev, s.a, { installmentId: s.ia[0], period: 'الأول', date: '2026-02-01', lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
    await sync(s.dev, s.r);
    const k1 = asMember(s.r);
    recordBulkRentPayment(s.dev, s.a, { installmentIds: [s.ia[1]], date: '2026-03-01', notes: '', lines: [{ method: 'cash', amountHalalas: 125000 }] });
    await sync(s.dev, s.r);
    const k2 = asMember(s.r);
    await sync(s.owner, s.r);
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    applyTenantCredit(s.dev, s.a, { installmentId: s.ia[2], amountHalalas: 25000, date: '2026-03-05' });
    await sync(s.dev, s.r);
    const k3 = asMember(s.r);
    await sync(s.owner, s.r);
    await sync(s.owner, s.r);
    expect([has(s.owner, k1), has(s.owner, k2), has(s.owner, k3)]).toEqual([true, true, true]);
    expect([reasonOf(s.owner, k1), reasonOf(s.owner, k2), reasonOf(s.owner, k3)]).toEqual(['', '', '']);
    expect(tenantCreditOf(s.owner, s.a)).toBe(0);
    s.owner.close(); s.dev.close();
  });

  test('١ إيجابي · الوحدة نُقلت إلى عقارٍ آخر بعد أن كتب العضو قيده: يُقبل بعقارها القديم', async () => {
    const s = await setup();
    recordRentPayment(s.dev, s.a, { installmentId: s.ia[0], period: 'الأول', date: '2026-02-01', lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
    await sync(s.dev, s.r);
    const k = asMember(s.r);
    // المالك ينقل وحدة العقد أ إلى عقارٍ ثالث قبل أن يطبّق قيد العضو
    const pc = addProperty(s.owner, { name: 'عقار أبعاد ج مصطنع' });
    const u = s.owner.get<Record<string, unknown>>(`SELECT * FROM units WHERE id = ?`, [s.ua])!;
    saveUnit(s.owner, { propertyId: pc, unitNo: String(u.unit_no), floor: String(u.floor ?? ''), type: String(u.type ?? 'سكني'),
      subtype: String(u.subtype ?? ''), rentMonthlyHalalas: Number(u.rent_monthly_halalas ?? 100000), rooms: [], meters: [] }, s.ua);
    expect(s.owner.get<{ p: string }>(`SELECT property_id AS p FROM units WHERE id = ?`, [s.ua])!.p).toBe(pc);
    await sync(s.owner, s.r);
    await sync(s.owner, s.r);
    expect([has(s.owner, k), reasonOf(s.owner, k)]).toEqual([true, '']);
    s.owner.close(); s.dev.close();
  });
});
