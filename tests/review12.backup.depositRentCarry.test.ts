/**
 * المراجعة ١٢ · R12-BAK-2 · الضابط الموجب لقاعدة حمل دفعة «من التأمين» (keepPosted.ts): الدفعة تُحمل حين صفّ التسوية في النسخة هو التسوية
 * التي سُدّدت بها ولا أخت لها من قيود التسوية تُراجَع · وتُترك فيُراجَع قيدها حين صفّ النسخة غيرها · فالإصلاح لا يمنع الحمل كله.
 * بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * عقد ثلاثة أشهر بأقساط ١٬٠٠٠٫٠٠ وتأمين ١٬٠٠٠٫٠٠ لدى المكتب · سُدّد يناير وفبراير · ثم تسوية: التأمين كله (١٠٠٬٠٠٠) مقابل قسط مارس.
 * النسخة (الهدف) أُخذت قبل التسوية، ثم وصلها صفّ التسوية وحده (كمزامنةٍ وصل فيها صفّ التسوية قبل القيد والدفعة) · فالمضموم قيد
 * السداد من التأمين وحده (لا قيد خصمٍ للأضرار: الخصم كله أقساط، ولا ردّ).
 */
import { memDb, tempDir, rmrf } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, saveDepositSettlement, recordRentPayment } from '@/domain/contracts/service';
import { planKeepPosted } from '@/domain/backup/keepPosted';
import { openNodeDb } from '@/db/nodeAdapter';
import * as path from 'node:path';
import type { DB } from '@/db/adapter';

let dir: string;
beforeEach(() => { dir = tempDir('aq-r12-deprent-carry-'); });
afterEach(() => rmrf(dir));

function setup(): { src: DB; target: DB; cid: string } {
  const src = memDb();
  const unit = addUnit(src, addProperty(src, { name: 'عقار حمل مصطنع' }), { unit_no: 'R12-DC' });
  const cid = confirmContract(src, contractInput(unit, { tenant: 'مستأجر حمل مصطنع', idNumber: '1000001313', phone: '0500001313',
    valueHalalas: 300_000, cycle: 'شهرية', start: '2026-01-01', end: '2026-03-31', depositHalalas: 100_000 }));
  const insts = src.all<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  for (const i of insts.slice(0, 2)) {
    recordRentPayment(src, cid, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100_000 }], discountHalalas: 0, notes: '' });
  }
  const file = path.join(dir, 'before-settlement.db').replace(/\\/g, '/');
  src.exec(`VACUUM INTO '${file}'`);
  saveDepositSettlement(src, cid, { date: '2026-04-05', deductionHalalas: 100_000, deductionReason: 'إيجار مارس مصطنع', refundHalalas: 0, notes: '', arrearsHalalas: 100_000 });
  return { src, target: openNodeDb(file), cid };
}

const copySettlement = (src: DB, target: DB, cid: string, date?: string) => {
  const s = src.get<Record<string, string | number>>(`SELECT * FROM deposit_settlements WHERE contract_id = ?`, [cid])!;
  target.run(`INSERT INTO deposit_settlements (contract_id, date, deduction_halalas, deduction_reason, refund_halalas, notes, deduct_destination)
    VALUES (?,?,?,?,?,?,?)`, [cid, date ?? s.date, s.deduction_halalas, s.deduction_reason, s.refund_halalas, s.notes, s.deduct_destination]);
};

test('صفّ التسوية في النسخة هو الذي سُدّدت به الدفعة: تُحمل الدفعة مع قيدها ولا مراجعة', () => {
  const { src, target, cid } = setup();
  copySettlement(src, target, cid);
  const plan = planKeepPosted(target, { device: src });
  const rent = plan.entries.filter((e) => src.get(`SELECT 1 FROM journal_entries WHERE id = ? AND src_type = 'deposit_rent'`, [e.id]));
  expect(rent.map((e) => ({ amount: e.amount, carried: e.carried, review: e.review })))
    .toEqual([{ amount: 100_000, carried: ['الدفعة'], review: null }]); // قسط مارس كله من التأمين: ١٠٠٬٠٠٠
  expect(plan.docs.payments.map((p) => Number(p.net_halalas))).toEqual([100_000]);
  src.close(); target.close();
});

test('صفّ التسوية في النسخة غير الذي سُدّدت به (تاريخٌ آخر): لا تُحمل الدفعة ويُراجَع قيدها', () => {
  const { src, target, cid } = setup();
  copySettlement(src, target, cid, '2026-04-01');
  const plan = planKeepPosted(target, { device: src });
  const rent = plan.entries.filter((e) => src.get(`SELECT 1 FROM journal_entries WHERE id = ? AND src_type = 'deposit_rent'`, [e.id]));
  expect(rent.map((e) => ({ carried: e.carried, review: e.review !== null }))).toEqual([{ carried: [], review: true }]);
  expect(plan.docs.payments).toEqual([]);
  src.close(); target.close();
});
