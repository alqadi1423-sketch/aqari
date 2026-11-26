/**
 * التوجيه الرابع · ٣ · ٢ (دراسة التوسع · المرحلة ٠ · معيار القبول «3,000 دفعة عضو في ≤ 3 ث وخطياً»): فحص جهاز المالك لدفعات
 * الأعضاء كان يبحث في صندوق الوارد بـ json_extract بلا فهرس (rowsHereOrInbox وقارئ المصادر)، فيكبر زمنه بمربع حجم الوارد ·
 * والإصلاح فهارس تعبير على الوارد (الهجرة ٥٠) · يقيس الزمن على حجمين ويشترط النمو الخطي، وكلفة الفحص دون ضعف سحب المالك لكتاباته نفسها ·
 * والزمن المطلق يُكتب في التقرير ولا يُشترط هنا: يختلف بالجهاز، واختبارٌ زمنيٌّ مطلق سقط من قبل تحت حمل الجهاز (الأعطال المعروفة ٤) · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { MemoryRemote } from './helpers/memoryRemote';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'owner-scale';
const MEMBER = 'member-scale';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);

/** عقودٌ شهرية مصطنعة على وحداتٍ مصطنعة، ودفعةٌ من العضو لكل قسط حتى payments · يعيد زمن سحب المالك وفحصه بالثواني */
async function ownerCheck(payments: number, asMember = true): Promise<{ secs: number; accepted: number }> {
  const r = new MemoryRemote();
  const owner = memDb();
  const dev = memDb();
  enableSync(owner, UID);
  enableSync(dev, UID);
  const p = addProperty(owner, { name: 'عقار حِمل مصطنع' });
  const contracts = Math.ceil(payments / 12);
  for (let i = 0; i < contracts; i++) {
    confirmContract(owner, contractInput(addUnit(owner, p, { unit_no: 'S-' + i }), {
      tenant: 'مستأجر حِمل مصطنع ' + i, idNumber: String(1000000000 + i), phone: '05' + String(10000000 + i), start: '2026-01-01', depositHalalas: 0,
    }));
  }
  await sync(owner, r);
  await sync(dev, r);
  const insts = dev.all<{ id: string; contract_id: string; amount_halalas: number }>(
    `SELECT id, contract_id, amount_halalas FROM contract_installments ORDER BY contract_id, due_date`).slice(0, payments);
  for (const i of insts) {
    recordRentPayment(dev, i.contract_id, { installmentId: i.id, period: '', date: '2026-02-01',
      lines: [{ method: 'cash', amountHalalas: Number(i.amount_halalas) }], discountHalalas: 0, notes: '' });
  }
  await sync(dev, r);
  // قيود التحصيل بكاتبها العضو: يعيد المالك اشتقاقها من دفعاتها في الوارد
  if (asMember) for (const d of [...r.docs.values()]) if (d.t === 'journal_entries' && d.d?.src_type === 'rent') r.inject({ ...d, by: MEMBER });
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 3; k++) await sync(owner, r);
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const accepted = Number(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments`)!.n);
  owner.close();
  dev.close();
  return { secs, accepted };
}

describe('فحص المالك لدفعات الأعضاء خطيٌّ في حجم الوارد', () => {
  test('ثلاثة آلاف دفعة عضو: كلها تُقبل، ومن ٧٥٠ إلى ٣٠٠٠ (×٤) دون ×٦، والفحص دون ضعف سحب المالك لكتاباته نفسها', async () => {
    const small = await ownerCheck(750);
    const big = await ownerCheck(3000);
    // الضابط: الدفعات نفسها بكاتبها المالك، فلا يُعاد اشتقاقها · فما زاد عليه كلفة فحص العضو وحدها
    const own = await ownerCheck(3000, false);
    // eslint-disable-next-line no-console
    console.log('member-scale', JSON.stringify({ small, big, own, ratio: big.secs / small.secs, overhead: big.secs / own.secs }));
    expect(small.accepted).toBe(750);
    expect(big.accepted).toBe(3000);
    expect(big.secs / small.secs).toBeLessThan(6);
    expect(big.secs / own.secs).toBeLessThan(2);
  }, 900000);
});

describe('كل بحثٍ في الوارد بعمودٍ من الحمولة له فهرس (الهجرة ٥٠)', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  /** أعمدة الحمولة التي يبحث بها المحرّك وقارئ المصادر: الثابتة نصاً، وأعمدة rows وrowsHereOrInbox */
  function lookupCols(): string[] {
    const cols = new Set<string>();
    const eng = src('src/sync/engine.ts');
    for (const m of eng.matchAll(/json_extract\((?:i\.)?payload, '\$\.d\.([a-z_]+)'\) (?:=|IN)/g)) cols.add(m[1]);
    for (const m of eng.matchAll(/rowsHereOrInbox<[^>]*>\(db, '[a-z_]+', '([a-z_]+)'/g)) cols.add(m[1]);
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'src/domain/accounting'))) {
      for (const m of src('src/domain/accounting/' + f).matchAll(/\br\.rows<[^(]*\('[a-z_]+', '([a-z_]+)'/g)) cols.add(m[1]);
    }
    return [...cols].sort();
  }

  test('الأعمدة كلها مفهرسة، والمخطِّط يستعمل الفهرس', () => {
    const db = memDb();
    const cols = lookupCols();
    expect(cols.length).toBeGreaterThan(8);
    const have = new Set(db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sync_inbox'`).map((r) => r.name));
    expect(cols.filter((c) => !have.has('ix_inbox_d_' + c))).toEqual([]);
    const plan = (sql: string) => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ['t', 'v']).map((r) => r.detail).join(' | ');
    expect(plan(`SELECT payload FROM sync_inbox WHERE tbl = ? AND del = 0 AND json_extract(payload, '$.d.journal_entry_id') = ?`)).toMatch(/ix_inbox_d_journal_entry_id/);
    expect(plan(`SELECT payload FROM sync_inbox WHERE tbl = ? AND pk = ? AND del = 0`)).toMatch(/ix_sync_inbox_tbl_pk/);
    expect(db.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT 1 FROM contract_payments WHERE (journal_entry_id = ? OR cancel_entry_id = ?) AND id != ?`, ['a', 'a', 'b'])
      .map((r) => r.detail).join(' | ')).toMatch(/ix_pay_cancel_entry/);
  });
});
