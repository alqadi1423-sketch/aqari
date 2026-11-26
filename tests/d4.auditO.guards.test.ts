/**
 * إصلاحات الجولة الثامنة (المدقق الخارجي O) · حارسان مباشران مع اختبارات المدقق: السداد من بنكٍ لا يكفيه رصيده (O٢ · سجل القرارات ٥٥)،
 * والحساب المستعمل في قيدٍ لا يغيّر العضو نوعه (O١) · بيانات مصطنعة.
 */
import { savePurchase, payPurchase, payPurchaseSplit, TS_EXCLUDED, type PurchaseInput } from '@/domain/purchases';
import { saveSupplier } from '@/domain/suppliers';
import { ownerCashIn } from '@/domain/cashOps';
import { bankBalance } from '@/domain/accounting/ledger';
import { postEntry } from '@/domain/accounting/post';
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';

const purchase = (db: ReturnType<typeof memDb>, total: number) => {
  saveSupplier(db, null, { name: 'مورد مصطنع O', vat: '', phone: '', category: '', amountHalalas: null, utility: '' });
  return savePurchase(db, {
    supplier: 'مورد مصطنع O', date: '2026-11-01', due: '', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
    exempt: false, excludeFromVat: true, taxStatus: TS_EXCLUDED, subtotalHalalas: total, taxHalalas: 0, totalHalalas: total,
  } as PurchaseInput);
};

describe('O٢ · السداد من البنك لا يُنزله تحت الصفر (سجل القرارات ٥٥)', () => {
  test('سدادٌ أكبر من رصيد البنك يُرفض برسالة قاعدة، ولا يُكتب شيء · وبرصيدٍ يكفي يُقبل', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع O٢', 40000);
    const id = purchase(db, 50000);
    expect(() => payPurchase(db, id, 'bank', bank, '2026-11-02')).toThrow(/لا يكفي/);
    expect(bankBalance(db, bank)).toBe(40000);
    expect(Number(db.get<{ paid: number }>(`SELECT paid FROM purchases WHERE id = ?`, [id])!.paid)).toBe(0);
    // والمقسَّم على بنكٍ واحد يُحسب شطراً بعد شطر
    expect(() => payPurchaseSplit(db, id, [
      { method: 'bank', bankId: bank, amountHalalas: 30000 }, { method: 'card', bankId: bank, amountHalalas: 20000 }], '2026-11-02')).toThrow(/لا يكفي/);
    expect(bankBalance(db, bank)).toBe(40000);
    ownerCashIn(db, { amountHalalas: 10000, date: '2026-11-01' });
    payPurchaseSplit(db, id, [{ method: 'bank', bankId: bank, amountHalalas: 40000 }, { method: 'cash', amountHalalas: 10000 }], '2026-11-02');
    expect(bankBalance(db, bank)).toBe(0);
  });
});

describe('O١ · الحساب المستعمل في قيدٍ لا يغيّر العضو نوعه ولا يحذفه', () => {
  test.each([['نوعه', { type: 'إيراد' }], ['حذفه', { deleted_at: '2026-11-03T00:00:00.000Z' }], ['مجموعته', { grp: 'مجموعة مصطنعة' }]])(
    'عضوٌ يغيّر %s: يُرفض وتعود نسخة المالك بافتتاحيّ نسخة العضو', async (_l, over) => {
      const s = await pair();
      s.owner.run(`INSERT INTO accounts (code, name, type, opening_halalas, created_at) VALUES ('5998', 'حساب مستعمل مصطنع', 'مصروف', 0, ?)`, [new Date().toISOString()]);
      ownerCashIn(s.owner, { amountHalalas: 5000, date: '2026-11-01' });
      postEntry(s.owner, { date: '2026-11-02', memo: 'قيد مصطنع O١', srcType: 'manual', srcId: undefined,
        lines: [{ account: '5998', descr: 'مصطنع', debit: 5000, credit: 0 }, { account: '1100', descr: 'مصطنع', debit: 0, credit: 5000 }] });
      await sync(s.owner, s.r);
      const { ts: _ts, ...cloud } = s.r.docs.get('accounts__5998')!;
      s.r.inject({ ...cloud, by: MEMBER, op: 'ledger', u: new Date().toISOString(), d: { ...cloud.d, name: 'اسمٌ مصطنع', ...over } } as RemoteDoc);
      await ownerPulls(s.owner, s.r);
      await sync(s.owner, s.r);
      const acc = s.owner.get<{ type: string; grp: string | null; deleted_at: string | null; name: string }>(`SELECT type, grp, deleted_at, name FROM accounts WHERE code = '5998'`)!;
      const rejects = s.owner.all<{ tbl: string }>(`SELECT tbl FROM sync_rejects`).map((r) => r.tbl);
      expect(acc).toMatchObject({ type: 'مصروف', grp: null, deleted_at: null });
      expect(rejects).toContain('accounts');
      // ونسخة المالك عادت إلى السحابة
      expect(s.r.docs.get('accounts__5998')!.op ?? '').toBe('');
      s.close();
    });
});
