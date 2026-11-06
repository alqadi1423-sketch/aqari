/**
 * المراجعة الشاملة · البند ٣ (تتمة · المراجعة الأخيرة): الهجرة ٤٨ أضافت contracts.original_end وتملؤه على كل صفٍّ في الجهاز،
 * ومستندات العقود القديمة في السحابة بلاه · فعضو المستأجرين بلا «كامل» العقود يكتب العقد من مسار اللمس الجانبي (تعديل الاسم
 * ودمج المستأجرين) والقواعد تشترط ألا يمسّ من d غير tenant_id وtenant_name، وaffectedKeys تعدّ المفتاح المضاف لمساً فتُرفض الكتابة.
 * الكتابة الآن جزئية بلا original_end وحده (sync/acl.ts touchLegacyColumns)، فيبقى في السحابة كما هو · وما سواه يُرفع كما هو، فتغيير
 * غير الملموس ترفضه القواعد ظاهراً ولا يُسقط بصمت (المتحقق المستقل · الاختبار الأخير) · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { DISCOUNT_REDUCES_INSTALLMENT } from '@/domain/contracts/installments';
import { buildDoc } from '@/sync/engine';
import { FirestoreRemote, decodeFields } from '@/cloud/firestore';
import { memberTokens, fullReadTables } from '@/sync/acl';
import { renameTenant, mergeTenants } from '@/domain/tenants';
import { opAllows } from '@/domain/access/opWrites';
import { SYNC_TABLES } from '@/db/syncTables';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

type Fields = Parameters<typeof decodeFields>[0];
type Write = { update: { name: string; fields: Fields }; updateMask?: { fieldPaths: string[] } };
type Doc = Record<string, unknown> & { d?: Record<string, unknown> | null };

const OWNER: Access = { owner: true, uid: 'ORG', perms: {}, allProps: true, props: [] };
const TEN: Access = { owner: false, uid: 'U-TEN', perms: { tenants: 3, contracts: 1, props: 1 }, allProps: true, props: [] };
const tables = SYNC_TABLES.map((t) => t.name);

/** عميل المنشأة بطلباتٍ تُلتقط ولا تُرسل */
function remote(a: Access, sink: Write[]): FirestoreRemote {
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    sink.push(...(JSON.parse(init.body) as { writes: Write[] }).writes);
    return { ok: true, status: 200, text: async () => '{}' };
  }) as unknown as typeof fetch;
  return new FirestoreRemote({ projectId: 'p', uid: a.uid!, org: 'ORG', idToken: async () => 't', fetchImpl,
    memberTokens: () => (a.owner ? null : memberTokens(a)), fullReadTables: () => fullReadTables(a, tables), access: () => a });
}
const idOf = (w: Write) => w.update.name.split('/rows/')[1];

/** ما يصير إليه المستند في السحابة بعد الكتابة: الكاملة تستبدله، والجزئية تكتب حقول قناعها وحدها (دلالة updateMask) */
function applyWrite(before: Doc | undefined, w: Write): Doc {
  const sent = decodeFields(w.update.fields) as Doc;
  if (!w.updateMask) return sent;
  const out: Doc = { ...(before ?? {}), d: { ...((before?.d as Record<string, unknown>) ?? {}) } };
  for (const p of w.updateMask.fieldPaths) {
    if (p.startsWith('d.')) {
      const c = p.slice(2);
      if (sent.d && c in sent.d) (out.d as Record<string, unknown>)[c] = sent.d[c];
      else delete (out.d as Record<string, unknown>)[c];
    } else if (p in sent) out[p] = sent[p];
    else delete out[p];
  }
  return out;
}
/** affectedKeys() لـ d في القواعد: ما أُضيف أو نُزع أو تغيّرت قيمته */
function affected(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => !(k in a) || !(k in b) || JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}

/** نسخة السحابة كما كتبها إصدارٌ قبل الهجرة ٤٨ (المستند وإسقاطه بلا original_end) */
async function legacyCloud(db: DB, ids: string[]): Promise<Map<string, Doc>> {
  const sink: Write[] = [];
  const owner = remote(OWNER, sink);
  for (const id of ids) {
    const doc = buildDoc(db, 'contracts', id, 'upsert', '2026-01-01T00:00:00.000Z', 'dev-v47');
    const { original_end: _drop, ...d } = doc.d!;
    await owner.write([owner.annotate!(db, { ...doc, d } as RemoteDoc)]);
  }
  const out = new Map<string, Doc>();
  for (const w of sink) out.set(idOf(w), applyWrite(undefined, w));
  return out;
}

/** كتابة جهاز عضو المستأجرين لعقود · وما تمسّه من d كل مستندٍ في السحابة */
async function memberTouch(db: DB, ids: string[], cloud: Map<string, Doc>) {
  const sink: Write[] = [];
  const r = remote(TEN, sink);
  const docs = ids.map((id) => r.annotate!(db, buildDoc(db, 'contracts', id, 'upsert', '2026-11-01T00:00:00.000Z', 'dev-ten')));
  await r.write(docs);
  return {
    ops: docs.map((d) => d.op),
    writes: sink.map((w) => {
      const before = cloud.get(idOf(w))!;
      const after = applyWrite(before, w);
      const sent = decodeFields(w.update.fields) as Doc;
      return { id: idOf(w), keys: affected(after.d as Record<string, unknown>, before.d as Record<string, unknown>), sentOriginalEnd: !!w.updateMask?.fieldPaths.includes('d.original_end') || (!w.updateMask && !!sent.d && 'original_end' in sent.d), after, before };
    }),
  };
}

/** نسخة السحابة كما كتبها المالك لصفوف جدول (المستند وإسقاطه) */
async function ownerCloud(db: DB, table: string, ids: string[]): Promise<Map<string, Doc>> {
  const sink: Write[] = [];
  const owner = remote(OWNER, sink);
  for (const id of ids) await owner.write([owner.annotate!(db, buildDoc(db, table, id, 'upsert', '2026-01-01T00:00:00.000Z', 'dev-owner'))]);
  return new Map(sink.map((w) => [idOf(w), applyWrite(undefined, w)] as const));
}

/** كتابة جهاز عضو لصفوف جدول كما يرفع المحرّك · وما تمسّه من d كل مستندٍ في السحابة */
async function memberWrite(db: DB, a: Access, table: string, ids: string[], cloud: Map<string, Doc>) {
  const sink: Write[] = [];
  const r = remote(a, sink);
  const docs = ids.map((id) => r.annotate!(db, buildDoc(db, table, id, 'upsert', '2026-11-01T00:00:00.000Z', 'dev-' + a.uid)));
  await r.write(docs);
  return {
    ops: docs.map((d) => d.op),
    writes: sink.map((w) => {
      const before = cloud.get(idOf(w))!;
      const after = applyWrite(before, w);
      return { id: idOf(w), keys: affected(after.d as Record<string, unknown>, before.d as Record<string, unknown>), after };
    }),
  };
}

function setup() {
  const db = memDb();
  addProperty(db, { id: 'P1', name: 'عقار لمس مصطنع' });
  const c1 = confirmContract(db, contractInput(addUnit(db, 'P1', { id: 'UT1' }), { tenant: 'مستأجر لمس أول مصطنع', idNumber: '1000000058', phone: '0500000058' }));
  const c2 = confirmContract(db, contractInput(addUnit(db, 'P1', { id: 'UT2' }), { tenant: 'مستأجر لمس ثانٍ مصطنع', idNumber: '1000000066', phone: '0500000066' }));
  // جهاز العضو يعلّم ما وصله من السحابة «بلا كاتب» (الهجرة ٤٢) · فلا يضيف كاتباً لعقدٍ ليس له
  for (const c of [c1, c2]) db.run(`INSERT OR REPLACE INTO row_by (tbl, pk, uid) VALUES ('contracts', ?, '')`, [c]);
  const tid = (c: string) => db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [c])!.t;
  return { db, c1, c2, tid };
}

test('٣ تعديل اسم المستأجر من عضو المستأجرين على عقدٍ كتبته السحابة قبل الهجرة ٤٨ لا يمسّ إلا tenant_name', async () => {
  const { db, c1, tid } = setup();
  const oe = db.get<{ v: string | null }>(`SELECT original_end AS v FROM contracts WHERE id = ?`, [c1])!.v;
  expect(oe).toBeTruthy(); // الجهاز الأحدث يحمل المفتاح على كل صف
  const cloud = await legacyCloud(db, [c1]);
  expect([...cloud.keys()].sort()).toEqual(['contracts__' + c1, 'contracts~pub__' + c1]);
  for (const doc of cloud.values()) expect('original_end' in (doc.d as object)).toBe(false);

  renameTenant(db, tid(c1), 'مستأجر لمس معدَّل مصطنع');
  const { ops, writes } = await memberTouch(db, [c1], cloud);
  expect(ops).toEqual(['tenants']);
  expect(writes.map((w) => w.id).sort()).toEqual(['contracts__' + c1, 'contracts~pub__' + c1]);
  for (const w of writes) {
    expect([w.id, w.keys]).toEqual([w.id, ['tenant_name']]);
    expect(opAllows('tenants', 'contracts', 'update', w.keys)).toBe(true);
    expect(w.sentOriginalEnd).toBe(false);
    // وما سوى الملموس في السحابة كما كان: لا يُضاف original_end ولا يُحذف غيره
    expect('original_end' in (w.after.d as object)).toBe(false);
    expect(w.after.d!.tenant_name).toBe('مستأجر لمس معدَّل مصطنع');
  }
  db.close();
});

test('٣ دمج المستأجرين من عضو المستأجرين: عقد المدموج لا يمسّ إلا tenant_id وtenant_name ولو كانت نسخته في السحابة بلا original_end', async () => {
  const { db, c1, c2, tid } = setup();
  const cloud = await legacyCloud(db, [c1, c2]);
  const keep = tid(c1);
  mergeTenants(db, keep, [tid(c2)], { allowDifferentIds: true });
  const { ops, writes } = await memberTouch(db, [c2], cloud);
  expect(ops).toEqual(['tenants']);
  expect(writes.length).toBe(2);
  for (const w of writes) {
    expect([w.id, w.keys]).toEqual([w.id, ['tenant_id', 'tenant_name']]);
    expect(opAllows('tenants', 'contracts', 'update', w.keys)).toBe(true);
    expect(w.after.d!.tenant_id).toBe(keep);
    expect('original_end' in (w.after.d as object)).toBe(false);
  }
  db.close();
});

test('٣ وعلى مستندٍ يحمل original_end تبقى قيمته في السحابة كما هي · والجزئية للمس الجانبي وحده (ذو «كامل» العقود يكتب المستند كاملاً)', async () => {
  const { db, c1, tid } = setup();
  const sink: Write[] = [];
  const owner = remote(OWNER, sink);
  await owner.write([owner.annotate!(db, buildDoc(db, 'contracts', c1, 'upsert', '2026-01-01T00:00:00.000Z', 'dev-owner'))]);
  const cloud = new Map(sink.map((w) => [idOf(w), applyWrite(undefined, w)] as const));
  const oe = cloud.get('contracts__' + c1)!.d!.original_end;
  expect(oe).toBeTruthy();
  renameTenant(db, tid(c1), 'اسم لمس ثالث مصطنع');
  const { writes } = await memberTouch(db, [c1], cloud);
  for (const w of writes) {
    expect(w.keys).toEqual(['tenant_name']);
    expect(w.after.d!.original_end).toBe(oe);
  }
  // ذو «كامل» العقود يملك الجدول: مستندٌ كامل بلا قناع
  const full: Write[] = [];
  const r = remote({ ...TEN, uid: 'U-CON', perms: { contracts: 3, props: 1 } }, full);
  await r.write([r.annotate!(db, buildDoc(db, 'contracts', c1, 'upsert', '2026-11-02T00:00:00.000Z', 'dev-con'))]);
  expect(full.every((w) => !w.updateMask)).toBe(true);
  db.close();
});

// المتحقق المستقل على الإصلاح السابق: الكتابة الجزئية بحقول اللمس وحدها كانت عامةً لكل مسارٍ جانبي، فيُسقط غيرُ الملموس بصمت ·
// تخفيض القسط بخصم «تنزيل من قيمة القسط» يُرفع بلا amount_halalas فتقبله القواعد، ويُحذف من الطابور ولا يصل سجل المرفوض أبداً
test('٣ عضو «إدخال» التحصيل يخفّض القسط بـ«تنزيل من قيمة القسط»: يُرفع amount_halalas فترفضه القواعد ظاهراً ولا يُسقط بصمت · وكذلك إرجاعه بإلغاء الدفعة من «كامل» التحصيل', async () => {
  const { db, c1 } = setup();
  const COL: Access = { owner: false, uid: 'U-COL', perms: { collect: 2, contracts: 1, props: 1 }, allProps: true, props: [] };
  const inst = db.get<{ id: string; a: number }>(`SELECT id, amount_halalas AS a FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c1])!;
  expect(inst.a).toBe(200000);
  const amountOf = () => Number(db.get<{ a: number }>(`SELECT amount_halalas AS a FROM contract_installments WHERE id = ?`, [inst.id])!.a);
  const doc = 'contract_installments__' + inst.id;

  const cloud = await ownerCloud(db, 'contract_installments', [inst.id]);
  recordRentPayment(db, c1, { installmentId: inst.id, period: 'يناير', date: '2026-01-05', notes: '',
    discountHalalas: 10000, discountKind: DISCOUNT_REDUCES_INSTALLMENT, lines: [{ method: 'cash', amountHalalas: 190000 }] });
  expect(amountOf()).toBe(190000);
  const { ops, writes } = await memberWrite(db, COL, 'contract_installments', [inst.id], cloud);
  expect(ops).toEqual(['collect']);
  const w = writes.find((x) => x.id === doc)!;
  // التخفيض في المرسَل: إما أن يصل السحابة، وإما أن ترفضه القواعد فيُسجَّل «خارج صلاحيتك» ويُعاد بعد الترقية
  expect(w.keys).toContain('amount_halalas');
  expect(w.after.d!.amount_halalas).toBe(190000);
  expect(opAllows('collect', 'contract_installments', 'update', w.keys)).toBe(false);

  // وإرجاع التنزيل بإلغاء الدفعة من «كامل» التحصيل على نسخةٍ في السحابة وصلها التخفيض
  const reduced = await ownerCloud(db, 'contract_installments', [inst.id]);
  const pay = db.get<{ id: string }>(`SELECT id FROM contract_payments WHERE installment_id = ?`, [inst.id])!.id;
  cancelPayment(db, pay, { date: '2026-01-06', reason: 'إلغاء دفعة مصطنع' });
  expect(amountOf()).toBe(200000);
  const FULL: Access = { ...COL, uid: 'U-COL3', perms: { collect: 3, contracts: 1, props: 1 } };
  const back = await memberWrite(db, FULL, 'contract_installments', [inst.id], reduced);
  expect(back.ops).toEqual(['collect']);
  const b = back.writes.find((x) => x.id === doc)!;
  expect(b.keys).toContain('amount_halalas');
  expect(b.after.d!.amount_halalas).toBe(200000);
  expect(opAllows('collect', 'contract_installments', 'update', b.keys)).toBe(false);
  db.close();
});
