/**
 * اختبارات المدقق الخارجي أُبقيت حارساً بعد إصلاح ما أثبتته (التوجيه الرابع ٣ · الجولة الأولى) ·
 * مدقق خارجي (أ) · عمولة التقبيل بعد 8a9b3de: مسارات الإلغاء والاستعادة والعقد والأبعاد · بيانات مصطنعة.
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { restoreFromTrash } from '@/domain/trash';
import { confirmContract } from '@/domain/contracts/service';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, reasonOf, otherDims, net, lastEntry, MEMBER } from './helpers/rederive';
import type { DB } from '@/db/adapter';

async function setup(vat = false) {
  const p = await pair();
  if (vat) for (const db of [p.owner, p.dev]) db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
  const pa = addProperty(p.owner, { name: 'عقار تدقيق أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار تدقيق ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'AU-A' });
  const ua2 = addUnit(p.owner, pa, { unit_no: 'AU-A2' });
  const ub = addUnit(p.owner, pb, { unit_no: 'AU-B' });
  const ca = confirmContract(p.owner, contractInput(ua, { tenant: 'مستأجر تدقيق مصطنع', idNumber: '1000000011', phone: '0555550011' }));
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ua2, ub, ca };
}
const deal = (db: DB, unit: string, n: number, contractId: string | null = null, bankId: string | null = null) => recordKeyMoneyDeal(db, {
  unitId: unit, contractId, outgoing: 'متنازل تدقيق ' + n, incoming: 'متنازل له تدقيق ' + n, amountHalalas: 5000000, date: '2026-11-01',
  commissionHalalas: 230000, method: bankId ? 'bank' : 'cash', bankId, notes: '' });

describe('مدقق أ · التقبيل', () => {
  test('الاستعادة من السلة على جهاز العضو: نسخة قيد العمولة يقبلها جهاز المالك', async () => {
    const s = await setup();
    const id = deal(s.dev, s.ua, 1, s.ca);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'key_money');
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(true);
    const a = entrySourceAction(s.dev, k);
    if (a?.kind !== 'op') throw new Error('op');
    a.run('2026-11-02', 'إلغاء تدقيق');
    await sync(s.dev, s.r);
    asMember(s.r, 'key_money_rev');
    await ownerPulls(s.owner, s.r);
    restoreFromTrash(s.dev, 'key_money_deals', id);
    await sync(s.dev, s.r);
    const copy = s.dev.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'key_money' AND src_id = ? AND reversed_by IS NULL`, [id])!.id;
    const doc = [...s.r.docs.values()].find((d) => d.t === 'journal_entries' && d.k === copy)!;
    s.r.inject({ ...doc, by: 'member-rd' });
    await ownerPulls(s.owner, s.r);
    // الجهاز الكاتب يرى الإيراد قائماً بعد الاستعادة
    expect(net(s.dev, '4300')).toBe(-230000);
    expect(reasonOf(s.owner, copy)).toBe('');
    expect(has(s.owner, copy)).toBe(true);
    expect(net(s.owner, '4300')).toBe(net(s.dev, '4300'));
    s.close();
  });

  test('سلبي · قيد العضو بأبعاد وحدةٍ أخرى في العقار نفسه (بلا عقد): يُرفض', async () => {
    const s = await setup();
    deal(s.dev, s.ua, 2);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'key_money', otherDims({ unit_id: s.ua2 }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    s.close();
  });

  test('سلبي · صفقةٌ بلا عقد وقيدها بعقدٍ على وحدتها: يُرفض', async () => {
    const s = await setup();
    deal(s.dev, s.ua, 3);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'key_money', otherDims({ contract_id: s.ca }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    s.close();
  });

  test('سلبي · سطرٌ واحد بلا أبعاد والآخر بأبعاد الصفقة: يُرفض', async () => {
    const s = await setup();
    deal(s.dev, s.ua, 4, s.ca);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'key_money', (ls) => ls.map((l, i) => (i === 0 ? { ...l, unit_id: null, property_id: null, contract_id: null } : l)));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    s.close();
  });

  test('إيجابي · بعقد وبنك: القيد بأبعاد العقد، وحركة البنك برقم القيد، ويقبله المالك', async () => {
    const s = await setup(true);
    const bank = addBank(s.dev, 'بنك تدقيق مصطنع');
    const id = deal(s.dev, s.ua, 5, s.ca, bank);
    const e = s.dev.get<{ id: string; no: string }>(`SELECT id, no FROM journal_entries WHERE src_type = 'key_money' AND src_id = ?`, [id])!;
    expect(s.dev.get<{ n: string }>(`SELECT journal_no AS n FROM bank_tx WHERE bank_id = ?`, [bank])!.n).toBe(e.no);
    expect(s.dev.get<{ j: string }>(`SELECT journal_entry_id AS j FROM key_money_deals WHERE id = ?`, [id])!.j).toBe(e.id);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'key_money');
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, k)).toBe(true);
    // الصف في السحابة يسمّي قيده
    expect(s.r.docs.get('key_money_deals__' + id)!.d!.journal_entry_id).toBe(e.id);
    void lastEntry;
    s.close();
  });
});

describe('مدقق أ · قيد عمولةٍ بلا أبعاد من إصدارٍ أقدم (يُرفض الآن)', () => {
  test('ما يتبعه لا يبقى على جهاز المالك بلا قيده: حركة البنك وصفّ الصفقة', async () => {
    const s = await setup();
    const bank = addBank(s.owner, 'بنك تدقيق قديم مصطنع');
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    const id = deal(s.dev, s.ua, 6, s.ca, bank);
    await sync(s.dev, s.r);
    // كأن الجهاز الكاتب بإصدارٍ قبل 8a9b3de: سطورٌ بلا عقارٍ ولا وحدة ولا عقد
    const k = asMember(s.r, 'key_money', otherDims({ unit_id: null, property_id: null, contract_id: null }));
    // وحركة بنكه يكتبها العضو نفسه كما في السحابة (byMember)
    for (const d of [...s.r.docs.values()].filter((x) => x.t === 'bank_tx')) s.r.inject({ ...d, by: MEMBER });
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    // والحركة مرفوضةٌ بسببها بعد رفض قيدها
    expect(s.owner.get<{ r: string }>(`SELECT reason AS r FROM sync_rejects WHERE tbl = 'bank_tx' ORDER BY rowid DESC LIMIT 1`)?.r ?? '').toMatch(/لقيدٍ مرفوض/);
    const tx = s.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_tx WHERE bank_id = ? AND deleted_at IS NULL`, [bank])!.n;
    const bal = s.owner.get<{ s: number }>(`SELECT COALESCE(SUM(amount_halalas), 0) AS s FROM bank_tx WHERE bank_id = ? AND deleted_at IS NULL`, [bank])!.s;
    const row = s.owner.get<{ j: string | null }>(`SELECT journal_entry_id AS j FROM key_money_deals WHERE id = ?`, [id]);
    // تشخيص: ما على جهاز المالك بعد رفض القيد
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ rejected: reasonOf(s.owner, k), bankTx: tx, bankSum: bal, dealRow: row, ledger4300: net(s.owner, '4300') }));
    // حركة بنكٍ برقم قيدٍ مرفوض: رصيد البنك عند المالك يخالف دفتره
    expect(bal).toBe(0);
    s.close();
  });

  test('إلغاء العضو لصفقةٍ رُفض قيدها: عاكسه لا ينتظر بلا نهاية', async () => {
    const s = await setup();
    deal(s.dev, s.ua, 7, s.ca);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'key_money', otherDims({ unit_id: null, property_id: null, contract_id: null }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    // العضو لا يعلم بالرفض، فيلغي من جهازه
    s.dev.run(`DROP TRIGGER IF EXISTS trg_jl_dims_fill_only`);
    s.dev.run(`UPDATE journal_lines SET unit_id = NULL, property_id = NULL, contract_id = NULL WHERE entry_id = ?`, [k]);
    const a = entrySourceAction(s.dev, k);
    if (a?.kind !== 'op') throw new Error('op');
    a.run('2026-11-02', 'إلغاء تدقيق');
    await sync(s.dev, s.r);
    const rev = asMember(s.r, 'key_money_rev');
    await ownerPulls(s.owner, s.r);
    const inbox = s.owner.get<{ e: string | null; n: number }>(`SELECT last_error AS e, attempts AS n FROM sync_inbox WHERE pk = ?`, [rev]);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ revReason: reasonOf(s.owner, rev), inbox, has: has(s.owner, rev) }));
    expect(inbox).toBeUndefined();
    s.close();
  });
});
