/**
 * مدقق خارجي (ج) · الجولة الثانية · memberBankTxCheck (engine.ts · ك٢ في 825f162) · بيانات مصطنعة.
 * الحارس يرفض حركة البنك نهائياً متى وجد قيدها في sync_rejects ولم يجده في الوارد · ورفضُ القيد لطول انتظاره (WAIT_REJECT) ليس نهائياً:
 * restageArrivedParents يعيده حين يصل ما ينتظره فيُطبَّق · أما الحركة فسبب رفضها غير WAIT_REJECT فلا تعود أبداً: قيدٌ في دفتر المالك
 * بلا حركته، ورصيد البنك عنده دون رصيده عند العضو.
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { confirmContract } from '@/domain/contracts/service';
import { bankBalance } from '@/domain/accounting/ledger';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, reasonOf, holdBack, MEMBER } from './helpers/rederive';

describe('مدقق ج · حركة البنك وقيدها المرفوض لطول انتظاره', () => {
  test('القيد ينتظر صفّ صفقته أكثر من ثلاثين يوماً ثم يصل: يُطبَّق القيد وحركته معاً', async () => {
    const s = await (async () => {
      const p = await pair();
      const pa = addProperty(p.owner, { name: 'عقار بنك ج مصطنع' });
      const ua = addUnit(p.owner, pa, { unit_no: 'BC-A' });
      const ca = confirmContract(p.owner, contractInput(ua, { tenant: 'مستأجر بنك ج مصطنع', idNumber: '1000000037', phone: '0555550037' }));
      const bank = addBank(p.owner, 'بنك ج مصطنع');
      await sync(p.owner, p.r);
      await sync(p.dev, p.r);
      return { ...p, ua, ca, bank };
    })();
    const id = recordKeyMoneyDeal(s.dev, { unitId: s.ua, contractId: s.ca, outgoing: 'متنازل بنك ج', incoming: 'متنازل له بنك ج',
      amountHalalas: 5000000, date: '2026-11-01', commissionHalalas: 230000, method: 'bank', bankId: s.bank, notes: '' });
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'key_money');
    for (const d of [...s.r.docs.values()].filter((x) => x.t === 'bank_tx')) s.r.inject({ ...d, by: MEMBER, op: 'reservations' });
    // صفّ الصفقة يتأخر (رفعٌ انقطع، أو جهازٌ غاب) · القيد ينتظره والحركة تنتظر القيد
    const row = holdBack(s.r, (d) => d.t === 'key_money_deals' && d.k === id);
    expect(row.count).toBe(1);
    await ownerPulls(s.owner, s.r);
    expect(s.owner.get(`SELECT 1 FROM sync_inbox WHERE pk = ?`, [k])).toBeDefined();
    // ثلاثون يوماً وعشرون محاولة (كما تحاكيها اختبارات المشروع: review8.syncTimes)
    s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
    await sync(s.owner, s.r);
    const midway = { entry: reasonOf(s.owner, k), tx: s.owner.get<{ r: string }>(`SELECT reason AS r FROM sync_rejects WHERE tbl = 'bank_tx'`)?.r ?? '' };
    // ثم يصل الصف
    row.release();
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    const out = { midway, entryApplied: has(s.owner, k), ownerBank: bankBalance(s.owner, s.bank), memberBank: bankBalance(s.dev, s.bank),
      txRejectNow: s.owner.get<{ r: string }>(`SELECT reason AS r FROM sync_rejects WHERE tbl = 'bank_tx'`)?.r ?? '' };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(out.entryApplied).toBe(true);
    // القيد في دفتر المالك، فحركته في بنكه
    expect(out.ownerBank).toBe(out.memberBank);
    s.close();
  });
});
