/**
 * التوجيه الرابع · ٣ · ١ (قرار المالك 2026-11-07 «موافق رأيك»): «قيد عمولة التقبيل يُرحّل بعد صف الصفقة فيحمل أبعادها، وتحقق جهاز
 * المالك يرفض القيد بلا أبعاد.» · كان القيد يُرحَّل قبل صفّ صفقته فلا يجد dimsFromSource مستنده وتُكتب سطوره بلا عقارٍ ولا وحدة،
 * وكان جهاز المالك يقبل قيد العضو بلا أبعاد · بيانات مصطنعة.
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { pair, sync, ownerPulls, asMember, has, reasonOf, otherDims } from './helpers/rederive';
import type { DB } from '@/db/adapter';

const deal = (db: DB, unit: string, n: number, contractId: string | null = null) => recordKeyMoneyDeal(db, { unitId: unit, contractId,
  outgoing: 'متنازل مصطنع ' + n, incoming: 'متنازل له مصطنع ' + n, amountHalalas: 5000000, date: '2026-11-01',
  commissionHalalas: 230000, method: 'cash', notes: '' });

const linesOf = (db: DB, dealId: string) => db.all<{ account_code: string; property_id: string | null; unit_id: string | null; contract_id: string | null }>(
  `SELECT l.account_code, l.property_id, l.unit_id, l.contract_id FROM journal_lines l
   JOIN journal_entries e ON e.id = l.entry_id WHERE e.src_type = 'key_money' AND e.src_id = ?`, [dealId]);

describe('قيد عمولة التقبيل يحمل أبعاد صفقته', () => {
  test('بلا عقد: كل سطر بوحدة الصفقة وعقارها، وصفّ الصفقة يسمّي قيده', async () => {
    const db = memDb();
    const p = addProperty(db, { name: 'عقار تقبيل مصطنع' });
    const u = addUnit(db, p, { unit_no: 'KD-1' });
    const id = deal(db, u, 1);
    const ls = linesOf(db, id);
    expect(ls.length).toBeGreaterThan(0);
    for (const l of ls) {
      expect(l.unit_id).toBe(u);
      expect(l.property_id).toBe(p);
    }
    const k = db.get<{ journal_entry_id: string | null }>(`SELECT journal_entry_id FROM key_money_deals WHERE id = ?`, [id]);
    const e = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'key_money' AND src_id = ?`, [id]);
    expect(k?.journal_entry_id).toBe(e?.id);
  });

  test('بعقد: كل سطر بعقد الصفقة ووحدته وعقاره', async () => {
    const db = memDb();
    const p = addProperty(db, { name: 'عقار تقبيل بعقد مصطنع' });
    const u = addUnit(db, p, { unit_no: 'KD-2' });
    const c = confirmContract(db, contractInput(u));
    const id = deal(db, u, 2, c);
    const ls = linesOf(db, id);
    expect(ls.length).toBeGreaterThan(0);
    for (const l of ls) {
      expect(l.contract_id).toBe(c);
      expect(l.unit_id).toBe(u);
      expect(l.property_id).toBe(p);
    }
  });
});

describe('جهاز المالك يرفض قيد العمولة بلا أبعاد', () => {
  async function setup() {
    const p = await pair();
    const pa = addProperty(p.owner, { name: 'عقار تقبيل أ مصطنع' });
    const ua = addUnit(p.owner, pa, { unit_no: 'KD-A' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    return { ...p, pa, ua };
  }

  test('سلبي · قيد عضوٍ بلا عقارٍ ولا وحدة ولا عقد: يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    deal(s.dev, s.ua, 3);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'key_money', otherDims({ unit_id: null, property_id: null, contract_id: null }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/بُعد/);
    s.close();
  });

  test('إيجابي · قيد العضو كما يكتبه التطبيق (بأبعاد صفقته) يُقبل', async () => {
    const s = await setup();
    deal(s.dev, s.ua, 4);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'key_money');
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, k)).toBe(true);
    s.close();
  });
});
