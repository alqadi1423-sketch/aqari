/**
 * المراجعة الشاملة 2026-11-13 · R12-SYN-2 (ملاحظة المشكك الإضافية) · بيانات مصطنعة كلها.
 *
 * العيب: حارس «الفاتورة الصادرة مقفلة» على جهاز المالك يعدّ فاتورة العضو مكتملة متى ساوى مجموعُ ما وصل من سطورها رأسها · والتطبيق
 *   لا يمنع سطراً بسعرٍ سالب (خصم)، فسطرٌ بزيادة وسطر خصمٍ بالمبلغ نفسه يصلان بعد السطر الأصلي يُرفض كلٌّ منهما «مقفلة» ويُحذف من
 *   السحابة ومن جهاز العضو · وقبولُ السطر الجديد «إن بقي المجموع مساوياً للرأس» وحده لا يكفي: كلٌّ منهما وحده يُخرج المجموع عن الرأس.
 * الصحيح: ما كتبه التطبيق مع الإصدار يُقبل ولو وصل على دفعاتٍ أو دورات: السطر الذي يُخرج المجموع عن الرأس ينتظر بقية سطور
 *   الإصدار (ساعةً بوقت الخادم من إصدارها) ولا يُرفض وهي في الطريق · وما كُتب بعد الإصدار بأكثر من ساعة، أو بقي يُخرج المجموع عن
 *   الرأس بعد الساعة، يُرفض كما كان وتُعاد نسخة المالك.
 * الأرقام: خدمة ١٠٠٬٠٠٠ هللة + إضافة ٥٬٠٠٠ − خصم ٥٬٠٠٠ = صافٍ ١٠٠٬٠٠٠ · والضريبة ١٥٪: ١٥٬٠٠٠ + ٧٥٠ − ٧٥٠ = ١٥٬٠٠٠.
 *   TZ=Asia/Riyadh npx jest tests/review12.sync.discountPairLines.test.ts
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit } from './helpers/fixtures';
import { enableSync, syncOnce, setSyncState } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { holdBack } from './helpers/rederive';
import { saveInvoice } from '@/domain/invoices';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteDoc, RemoteStore } from '@/sync/types';

const OWNER = 'OWNER-R12-DP';
const dev = (db: DB) => getMeta(db, 'device_id')!;

async function joinMember(r: MemoryRemote, a: Access) {
  const db = memDb();
  enableSync(db, a.uid!);
  db.run(`DELETE FROM sync_outbox`);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: OWNER, profile: { name: 'عضو مصطنع' } })]);
  setSyncState(db, 'org', OWNER);
  const remote: RemoteStore = {
    pull: (c, l) => r.pull(c, l), write: (d) => r.write(d), clockSample: () => r.clockSample(),
    reserveBlocks: (q) => r.reserveBlocks(q), takeInvoiceSeq: (f) => r.takeInvoiceSeq(f), memberMode: true,
    annotate: (d, doc) => annotate(d, doc, a).doc,
  };
  await syncOnce(db, remote, dev(db));
  return { db, sync: () => syncOnce(db, remote, dev(db)) };
}

async function setup(uid: string) {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, OWNER);
  owner.run(`UPDATE company SET vat_enabled = 1, name = 'منشأة مصطنعة', vatno = '300000000000003' WHERE id = 1`);
  const u = addUnit(owner, addProperty(owner, { name: 'عقار مصطنع' }), { unit_no: 'DP-1' });
  await syncOnce(owner, r, dev(owner));
  const access: Access = { owner: false, uid, perms: { invoices: 3 }, allProps: true, props: [] };
  const m = await joinMember(r, access);
  const id = saveInvoice(m.db, {
    customer: 'عميل مصطنع', customerVat: '', issue: '2026-04-10', due: '2026-04-30', notes: '', unitId: u, propertyId: null,
    lines: [
      { descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100_000, taxPct: 15, taxCode: 'S' },
      { descr: 'إضافة مصطنعة', qty: 1, priceHalalas: 5_000, taxPct: 15, taxCode: 'S' },
      { descr: 'خصم مصطنع', qty: 1, priceHalalas: -5_000, taxPct: 15, taxCode: 'S' },
    ],
  }, 'مستحقة');
  await m.sync();
  const ownerSync = async () => { await syncOnce(owner, r, dev(owner)); await syncOnce(owner, r, dev(owner)); };
  const lineId = (price: number) => m.db.get<{ id: string }>(`SELECT id FROM invoice_lines WHERE invoice_id = ? AND price_halalas = ?`, [id, price])!.id;
  return { r, owner, m, id, access, ownerSync, lineId };
}

const pricesOf = (db: DB, id: string) => db.all<{ p: number }>(
  `SELECT price_halalas AS p FROM invoice_lines WHERE invoice_id = ? ORDER BY sort`, [id]).map((x) => Number(x.p));
const rejects = (db: DB) => db.all<{ pk: string }>(`SELECT pk FROM sync_rejects WHERE tbl = 'invoice_lines'`).map((x) => x.pk);
const ISSUED = [100_000, 5_000, -5_000];

test('سطر الإضافة وسطر الخصم يصلان معاً بعد السطر الأصلي: يُقبلان بلا رفض', async () => {
  const s = await setup('M-R12-DP1');
  const pair = [s.lineId(5_000), s.lineId(-5_000)];
  const late = holdBack(s.r, (d) => d.t === 'invoice_lines' && pair.includes(d.k));
  expect(late.count).toBe(2);
  await s.ownerSync();
  expect(pricesOf(s.owner, s.id)).toEqual([100_000]);
  late.release();
  await s.ownerSync();
  await s.m.sync();
  expect({ rejects: rejects(s.owner), owner: pricesOf(s.owner, s.id), member: pricesOf(s.m.db, s.id) })
    .toEqual({ rejects: [], owner: ISSUED, member: ISSUED });
  // الرأس كما صدر: صافٍ ١٠٠٬٠٠٠ وضريبة ١٥٬٠٠٠
  expect(s.owner.get(`SELECT subtotal_halalas AS s, tax_halalas AS t FROM invoices WHERE id = ?`, [s.id])).toEqual({ s: 100_000, t: 15_000 });
  s.owner.close(); s.m.db.close();
});

test('سطر الإضافة يصل في دورةٍ وسطر الخصم في دورةٍ بعدها: الأول ينتظر بلا رفض، ثم يُقبلان', async () => {
  const s = await setup('M-R12-DP2');
  const plus = s.lineId(5_000), minus = s.lineId(-5_000);
  const lateMinus = holdBack(s.r, (d) => d.t === 'invoice_lines' && d.k === minus);
  const latePlus = holdBack(s.r, (d) => d.t === 'invoice_lines' && d.k === plus);
  await s.ownerSync();
  latePlus.release();
  await s.ownerSync();
  // الإضافة وحدها تُخرج الصافي عن الرأس (١٠٥٬٠٠٠): تنتظر الخصم في الصندوق ولا تُرفض
  const waiting = s.owner.all<{ pk: string }>(`SELECT pk FROM sync_inbox WHERE tbl = 'invoice_lines'`).map((x) => x.pk);
  expect({ rejects: rejects(s.owner), owner: pricesOf(s.owner, s.id), waiting }).toEqual({ rejects: [], owner: [100_000], waiting: [plus] });
  lateMinus.release();
  await s.ownerSync();
  await s.m.sync();
  expect({ rejects: rejects(s.owner), owner: pricesOf(s.owner, s.id), member: pricesOf(s.m.db, s.id) })
    .toEqual({ rejects: [], owner: ISSUED, member: ISSUED });
  s.owner.close(); s.m.db.close();
});

describe('وما كُتب بعد إصدار فاتورة العضو يبقى مرفوضاً', () => {
  const forge = (s: Awaited<ReturnType<typeof setup>>, k: string, price: number): RemoteDoc => annotate(s.m.db, {
    id: 'invoice_lines__' + k, t: 'invoice_lines', k, u: new Date().toISOString(), dev: 'DEV-M', del: false,
    d: { id: k, invoice_id: s.id, descr: 'سطر مضاف', qty: 1, price_halalas: price, tax_pct: 0, sort: 9, tax_code: 'E' },
  } as RemoteDoc, s.access).doc;
  /** مضت ساعتان على إصدارها في السحابة */
  const twoHoursLater = (s: Awaited<ReturnType<typeof setup>>) =>
    s.owner.run(`UPDATE sync_state SET v = ? WHERE k = ?`, [new Date(Date.now() - 2 * 3600_000).toISOString(), 'invoice_issued:' + s.id]);

  test('سطرٌ بمبلغ بعد اكتمالها ينتظر ساعة الإصدار ثم يُرفض ويُرفع شاهد حذفه', async () => {
    const s = await setup('M-R12-DP3');
    await s.ownerSync();
    expect(pricesOf(s.owner, s.id)).toEqual(ISSUED);
    s.r.inject(forge(s, 'R12-DP-FORGED', 1_000));
    await s.ownerSync();
    // في ساعة الإصدار: لا يُطبَّق (يُخرج الصافي إلى ١٠١٬٠٠٠) ولا يُرفض بعد
    expect({ rejects: rejects(s.owner), owner: pricesOf(s.owner, s.id) }).toEqual({ rejects: [], owner: ISSUED });
    twoHoursLater(s);
    await s.ownerSync();
    expect({ rejects: rejects(s.owner), owner: pricesOf(s.owner, s.id), cloudDel: s.r.docs.get('invoice_lines__R12-DP-FORGED')?.del })
      .toEqual({ rejects: ['R12-DP-FORGED'], owner: ISSUED, cloudDel: true });
    s.owner.close(); s.m.db.close();
  });

  test('سطرٌ بسعرٍ صفر كُتب بعد إصدارها بساعتين: يُرفض فوراً', async () => {
    const s = await setup('M-R12-DP4');
    await s.ownerSync();
    twoHoursLater(s);
    s.r.inject(forge(s, 'R12-DP-ZERO', 0));
    await s.ownerSync();
    expect({ rejects: rejects(s.owner), owner: pricesOf(s.owner, s.id) }).toEqual({ rejects: ['R12-DP-ZERO'], owner: ISSUED });
    s.owner.close(); s.m.db.close();
  });
});
