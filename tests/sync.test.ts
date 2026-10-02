/**
 * القسم ٤ج · المزامنة: القاعدة المحلية مصدر الحقيقة، والطابور يُرسل عند عودة الاتصال،
 * والقيد المرحّل إضافة فقط، والتعارض يُحلّ على مستوى الصف ويُسجَّل، والمبالغ أعداد صحيحة.
 * وقواعد القسم ٣ (توازن القيد وسقف القسط) تسري على ما يرد بالمزامنة كما تسري على المحلي.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { MemoryRemote } from './helpers/memoryRemote';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { postEntry, reverseEntryById } from '@/domain/accounting/post';
import { enableSync, syncOnce, syncStatus, outboxCount, docId } from '@/sync/engine';
import { SYNC_TABLES } from '@/db/syncTables';
import { semanticIssues, moneyColumns, tableLabel, columnLabel } from '@/domain/backup/semantic';
import { DISCOUNT_AFTER_DUE } from '@/domain/contracts/installments';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getMeta } from '@/repos/settings';
import { encodeValue, docToFields, fieldsToDoc, FirestoreRemote } from '@/cloud/firestore';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

const UID = 'user-1';
const dev = (db: DB) => getMeta(db, 'device_id')!;
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, dev(db));
const count = (db: DB, sql: string, p: (string | number)[] = []) => Number(db.get<{ n: number }>(sql, p)!.n);

function contract(db: DB, tenant = 'سلوى التجريبية', monthly = 248000) {
  const p = addProperty(db, { name: 'برج النخيل' });
  const u = addUnit(db, p, { unit_no: 'A-1', rent: monthly });
  const cid = confirmContract(db, contractInput(u, { tenant, valueHalalas: monthly * 12, depositHalalas: 0, idNumber: '1011111111' }));
  const inst = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  return { cid, inst };
}

describe('الالتقاط والطابور', () => {
  test('قبل تسجيل الدخول لا شيء يُلتقط · والتفعيل يضع كل صف في الطابور', () => {
    const db = memDb();
    contract(db);
    expect(outboxCount(db)).toBe(0);
    const rows = SYNC_TABLES.reduce((s, t) => s + count(db, `SELECT COUNT(*) AS n FROM "${t.name}"`), 0);
    expect(enableSync(db, UID).seeded).toBe(true);
    expect(outboxCount(db)).toBe(rows);
    // كتابة جديدة تُلتقط · وتكرار تعديل الصف نفسه صف واحد في الطابور
    db.run(`UPDATE tenants SET phone = '0500000000'`);
    db.run(`UPDATE tenants SET phone = '0500000001'`);
    expect(outboxCount(db)).toBe(rows);
    db.close();
  });

  test('بلا اتصال: العمل محلي كامل والطابور يبقى · وعند عودة الاتصال يُرسل كله', async () => {
    const r = new MemoryRemote();
    const a = memDb();
    enableSync(a, UID);
    await sync(a, r);
    r.offline = true;
    const k = contract(a);
    recordRentPayment(a, k.cid, { installmentId: k.inst, period: 'يناير', date: '2026-01-05', discountHalalas: 22000, notes: '',
      discountKind: DISCOUNT_AFTER_DUE, lines: [{ method: 'cash', amountHalalas: 226000 }] });
    await expect(sync(a, r)).rejects.toThrow('Network request failed');
    expect(outboxCount(a)).toBeGreaterThan(0);
    expect(count(a, `SELECT COUNT(*) AS n FROM contract_payments`)).toBe(1); // البيانات المحلية سليمة
    r.offline = false;
    const rep = await sync(a, r);
    expect(rep.pending).toBe(0);
    expect(r.docs.has(docId('contract_payments', a.get<{ id: string }>(`SELECT id FROM contract_payments`)!.id))).toBe(true);
    a.close();
  });
});

describe('جهازان في حساب واحد', () => {
  test('ما يُكتب في جهاز يصل الآخر كاملاً · والقيود متوازنة والمبالغ هي هي', async () => {
    const r = new MemoryRemote();
    const a = memDb(); const b = memDb();
    enableSync(a, UID); enableSync(b, UID);
    const k = contract(a);
    recordRentPayment(a, k.cid, { installmentId: k.inst, period: 'يناير', date: '2026-01-05', discountHalalas: 22000, notes: '',
      discountKind: DISCOUNT_AFTER_DUE, lines: [{ method: 'cash', amountHalalas: 226000 }] });
    await sync(a, r);
    const rep = await sync(b, r);
    expect(rep.rejected).toBe(0);
    for (const t of ['contracts', 'contract_installments', 'contract_payments', 'payment_lines', 'tenants', 'units', 'properties']) {
      expect(count(b, `SELECT COUNT(*) AS n FROM "${t}"`)).toBe(count(a, `SELECT COUNT(*) AS n FROM "${t}"`));
    }
    const inst = b.get<{ paid: number; amount: number }>(`SELECT paid_halalas AS paid, amount_halalas AS amount FROM contract_installments WHERE id = ?`, [k.inst])!;
    expect(inst).toEqual({ paid: 226000, amount: 248000 });
    expect(b.all(`SELECT e.no FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.status = 'مرحّل'
      GROUP BY e.id HAVING SUM(l.debit_halalas - l.credit_halalas) != 0`)).toEqual([]);
    expect(count(b, `SELECT COUNT(*) AS n FROM journal_entries WHERE status = 'مرحّل'`))
      .toBe(count(a, `SELECT COUNT(*) AS n FROM journal_entries WHERE status = 'مرحّل'`));
    // جهاز ثانٍ فارغ لا يكتب قيمه الافتراضية فوق بيانات الأول ولا يكرّر القوالب الافتراضية
    expect(count(b, `SELECT COUNT(*) AS n FROM message_scripts`)).toBe(count(a, `SELECT COUNT(*) AS n FROM message_scripts`));
    a.close(); b.close();
  });

  test('التعارض على صف واحد: الأحدث تغييراً يغلب في الجهازين ويُسجَّل في سجل العمليات', async () => {
    const r = new MemoryRemote();
    const a = memDb(); const b = memDb();
    enableSync(a, UID); enableSync(b, UID);
    contract(a);
    await sync(a, r); await sync(b, r);
    const tid = a.get<{ id: string }>(`SELECT id FROM tenants`)!.id;
    a.run(`UPDATE tenants SET phone = '0511111111' WHERE id = ?`, [tid]);
    await new Promise((res) => setTimeout(res, 5));
    b.run(`UPDATE tenants SET phone = '0522222222' WHERE id = ?`, [tid]); // الأحدث
    await sync(b, r);   // ب يرفع أولاً
    await sync(a, r);   // أ يجد تعديلاً أحدث من تعديله
    await sync(b, r);
    for (const db of [a, b]) {
      expect(db.get<{ p: string }>(`SELECT phone AS p FROM tenants WHERE id = ?`, [tid])!.p).toBe('0522222222');
    }
    expect(count(a, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'تعارض مزامنة' AND entity_name LIKE ?`, ['tenants · ' + tid + '%'])).toBe(1);
    a.close(); b.close();
  });
});

describe('القيد المرحّل إضافة فقط', () => {
  test('تعديل قيد مرحّل لا يعبر المزامنة · ولا يغيّر الوارد قيداً مرحّلاً محلياً', async () => {
    const r = new MemoryRemote();
    const a = memDb(); const b = memDb();
    enableSync(a, UID); enableSync(b, UID);
    const e = postEntry(a, { date: '2026-01-01', memo: 'الأصل', lines: [
      { account: '1100', debit: 1000, credit: 0 }, { account: '4200', debit: 0, credit: 1000 }] })!;
    await sync(a, r); await sync(b, r);
    // عبث محلي بالبيان في أ · يُرفض في السحابة ويُترك
    a.run(`UPDATE journal_entries SET memo = 'معدَّل' WHERE id = ?`, [e.id]);
    await sync(a, r);
    expect((r.docs.get(docId('journal_entries', e.id))!.d as Record<string, unknown>).memo).toBe('الأصل');
    expect(outboxCount(a)).toBe(0);
    // مستند مزوّر يغيّر سطور قيد مرحّل · لا يمسّ ب
    const forged = { ...r.docs.get(docId('journal_entries', e.id))!, dev: 'other', u: '2099-01-01T00:00:00.000Z' };
    forged.lines = forged.lines!.map((l) => ({ ...l, debit_halalas: Number(l.debit_halalas) ? 9999 : 0 }));
    r.inject(forged);
    await sync(b, r);
    expect(count(b, `SELECT SUM(debit_halalas) AS n FROM journal_lines WHERE entry_id = ?`, [e.id])).toBe(1000);
    a.close(); b.close();
  });

  test('الإلغاء بقيد عكسي يعبر المزامنة ويُربط بأصله', async () => {
    const r = new MemoryRemote();
    const a = memDb(); const b = memDb();
    enableSync(a, UID); enableSync(b, UID);
    const e = postEntry(a, { date: '2026-01-01', memo: 'الأصل', lines: [
      { account: '1100', debit: 1000, credit: 0 }, { account: '4200', debit: 0, credit: 1000 }] })!;
    await sync(a, r); await sync(b, r);
    const rev = reverseEntryById(a, e.id)!;
    await sync(a, r); await sync(b, r);
    expect(b.get<{ r: string }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [e.id])!.r).toBe(rev.id);
    expect(b.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = ?`, [rev.id])!.s).toBe('مرحّل');
    a.close(); b.close();
  });
});

describe('قواعد القسم ٣ على مسار المزامنة', () => {
  async function receive(doc: Omit<RemoteDoc, 'id' | 'u' | 'dev' | 'del'> & { del?: boolean }, prep?: (db: DB) => void) {
    const r = new MemoryRemote();
    const b = memDb();
    enableSync(b, UID);
    prep?.(b);
    await sync(b, r);
    r.inject({ id: docId(doc.t, doc.k), u: '2026-05-01T00:00:00.000Z', dev: 'other', del: false, ...doc });
    const rep = await sync(b, r);
    return { b, rep };
  }

  test('قيد مرحّل غير متوازن وارد: يُرفض ويُسجَّل ولا يدخل الدفتر', async () => {
    const { b, rep } = await receive({ t: 'journal_entries', k: 'JX', d: {
      id: 'JX', no: 'JE-9100', date: '2026-01-01', memo: 'م', status: 'مرحّل', auto: 0, src_type: null, src_id: null,
      created_at: 'x', deleted_at: null, reversed_by: null,
    }, lines: [{ id: 'LX', entry_id: 'JX', account_code: '1100', descr: '', debit_halalas: 500, credit_halalas: 0 }] });
    expect(rep.rejected).toBe(1);
    expect(b.get(`SELECT id FROM journal_entries WHERE id = 'JX'`)).toBeFalsy();
    expect(b.get<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE pk = 'JX'`)!.reason).toContain('قيد غير متوازن');
    expect(count(b, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'رفض وارد'`)).toBe(1);
    b.close();
  });

  test('دفعة واردة يتجاوز خصمها مبلغ القسط: تُرفض · وقسط وارد مسدَّده فوق مبلغه: يُرفض', async () => {
    const r = new MemoryRemote();
    const b = memDb();
    enableSync(b, UID);
    const k = contract(b);
    await sync(b, r);
    r.inject({ id: docId('contract_payments', 'PY'), t: 'contract_payments', k: 'PY', u: '2026-05-01T00:00:00.000Z', dev: 'other', del: false, d: {
      id: 'PY', contract_id: k.cid, installment_id: k.inst, period: 'م', date: '2026-01-01', gross_halalas: 400000,
      discount_halalas: 400000, net_halalas: 0, method_label: '', notes: '', journal_entry_id: null, created_at: 'x' } });
    const row = b.get<Record<string, unknown>>(`SELECT * FROM contract_installments WHERE id = ?`, [k.inst])!;
    r.inject({ id: docId('contract_installments', k.inst), t: 'contract_installments', k: k.inst, u: '2026-05-01T00:00:00.000Z', dev: 'other', del: false,
      d: { ...row, paid_halalas: 999999 } as never });
    const rep = await sync(b, r);
    expect(rep.rejected).toBe(2);
    expect(b.get(`SELECT id FROM contract_payments WHERE id = 'PY'`)).toBeFalsy();
    expect(b.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = ?`, [k.inst])!.p).toBe(0);
    const reasons = b.all<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE pk IN ('PY', ?)`, [k.inst]).map((x) => x.reason).join(' | ');
    // الدفعة بلا نوع (صف من إصدار سابق) يحرسها سقف القسط بخصمها · والقسط يحرسه مبلغه
    expect(reasons).toContain('الخصم يتجاوز المتبقي على القسط');
    expect(reasons).toContain('المسدَّد يتجاوز مبلغ القسط');
    b.close();
  });
});

describe('فحص الاستعادة نفسه على كل صف وارد · قبل اعتماده', () => {
  const AT = '2026-05-01T00:00:00.000Z';
  const reasonOf = (db: DB, pk: string) => db.get<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE pk = ?`, [pk])?.reason ?? '';
  /** يُسقط محفّزات القسم ٣ (التوازن والسقف) فلا يبقى أمام الوارد إلا الفحص الدلالي · ليُرى أنه يقف وحده */
  const dropLedgerTriggers = (db: DB) => {
    for (const t of ['trg_je_post_balanced', 'trg_je_insert_balanced', 'trg_pay_insert_cap', 'trg_pay_update_cap', 'trg_inst_insert_cap', 'trg_inst_update_cap'])
      db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  };
  async function device(prep?: (db: DB) => void) {
    const r = new MemoryRemote();
    const b = memDb();
    enableSync(b, UID);
    const k = contract(b);
    prep?.(b);
    await sync(b, r);
    return { r, b, k };
  }
  const payment = (k: { cid: string; inst: string }, id: string, d: Record<string, unknown>): RemoteDoc => ({
    id: docId('contract_payments', id), t: 'contract_payments', k: id, u: AT, dev: 'other', del: false,
    d: { id, contract_id: k.cid, installment_id: k.inst, period: 'م', date: '2026-01-01', gross_halalas: 0, discount_halalas: 0,
      net_halalas: 0, method_label: '', notes: '', journal_entry_id: null, created_at: 'x', ...d } });
  const postedEntry = (id: string, no: string, lines: { debit: number; credit: number }[]): RemoteDoc => ({
    id: docId('journal_entries', id), t: 'journal_entries', k: id, u: AT, dev: 'other', del: false,
    d: { id, no, date: '2026-01-01', memo: 'م', status: 'مرحّل', auto: 0, src_type: null, src_id: null, created_at: 'x', deleted_at: null, reversed_by: null },
    lines: lines.map((l, i) => ({ id: id + '-L' + i, entry_id: id, account_code: i % 2 ? '4200' : '1100', descr: '', debit_halalas: l.debit, credit_halalas: l.credit })),
  });

  test('مبلغ بكسر في أي عمود مالي: دفعة صافيها 2260.5 ومستأجر رصيده 10.25 · يُرفضان ولا يبقى لهما أثر · والسليم في الدفعة نفسها يمرّ', async () => {
    const { r, b, k } = await device();
    const tenant = b.get<Record<string, unknown>>(`SELECT * FROM tenants LIMIT 1`)!;
    r.inject(payment(k, 'PF', { gross_halalas: 2260.5, net_halalas: 2260.5 }));
    r.inject({ id: docId('tenants', String(tenant.id)), t: 'tenants', k: String(tenant.id), u: AT, dev: 'other', del: false,
      d: { ...tenant, credit_halalas: 10.25 } as never });
    r.inject(payment(k, 'PG', { gross_halalas: 50000, net_halalas: 50000 })); // سليمة
    const rep = await sync(b, r);
    expect(rep.rejected).toBe(2);
    expect(reasonOf(b, 'PF')).toBe('الوارد مرفوض · مبلغ بالهللات ليس عدداً صحيحاً: دفعات العقود · المبلغ قبل الخصم، دفعات العقود · الصافي');
    expect(reasonOf(b, String(tenant.id))).toBe('الوارد مرفوض · مبلغ بالهللات ليس عدداً صحيحاً: المستأجرون · دائن');
    expect(b.get(`SELECT id FROM contract_payments WHERE id = 'PF'`)).toBeFalsy();
    expect(b.get<{ c: number }>(`SELECT credit_halalas AS c FROM tenants WHERE id = ?`, [String(tenant.id)])!.c).toBe(0);
    expect(b.get<{ n: number }>(`SELECT net_halalas AS n FROM contract_payments WHERE id = 'PG'`)!.n).toBe(50000);
    // لا خانة مالية غير صحيحة في القاعدة المحلية كلها · بفحص الاستعادة نفسه
    expect(semanticIssues(b)).toEqual([]);
    b.close();
  });

  test('قيد مرحّل سطوره متوازنة لكنها كسور (500.5 / 500.5): المحفّز يراه متوازناً · وفحص الاستعادة يرفضه', async () => {
    const { r, b } = await device();
    r.inject(postedEntry('JF', 'JE-9200', [{ debit: 500.5, credit: 0 }, { debit: 0, credit: 500.5 }]));
    const rep = await sync(b, r);
    expect(rep.rejected).toBe(1);
    expect(reasonOf(b, 'JF')).toBe('الوارد مرفوض · مبلغ بالهللات ليس عدداً صحيحاً: سطور القيود · مدين (1 سطر)، سطور القيود · دائن (1 سطر)');
    expect(b.get(`SELECT id FROM journal_entries WHERE id = 'JF'`)).toBeFalsy();
    expect(count(b, `SELECT COUNT(*) AS n FROM journal_lines WHERE entry_id = 'JF'`)).toBe(0);
    b.close();
  });

  test('بلا محفّزات القاعدة أصلاً: الفحص وحده يرفض القيد غير المتوازن والقيد بلا سطور والقسط المتجاوز والدفعة السالبة · بنص الاستعادة حرفاً', async () => {
    const { r, b, k } = await device(dropLedgerTriggers);
    const inst2 = b.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1 OFFSET 1`, [k.cid])!.id;
    const row = b.get<Record<string, unknown>>(`SELECT * FROM contract_installments WHERE id = ?`, [k.inst])!;
    r.inject(postedEntry('JU', 'JE-9300', [{ debit: 500, credit: 0 }]));
    r.inject(postedEntry('JN', 'JE-9301', []));
    r.inject({ id: docId('contract_installments', k.inst), t: 'contract_installments', k: k.inst, u: AT, dev: 'other', del: false,
      d: { ...row, paid_halalas: 999999 } as never });
    r.inject(payment({ cid: k.cid, inst: inst2 }, 'PN', { gross_halalas: -100, net_halalas: -100 }));
    const rep = await sync(b, r);
    expect(rep.rejected).toBe(4);
    // لا أثر لشيء منها
    expect(count(b, `SELECT COUNT(*) AS n FROM journal_entries WHERE id IN ('JU', 'JN')`)).toBe(0);
    expect(b.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = ?`, [k.inst])!.p).toBe(0);
    expect(b.get(`SELECT id FROM contract_payments WHERE id = 'PN'`)).toBeFalsy();
    expect(semanticIssues(b)).toEqual([]);

    // الدالة نفسها التي تفحص بها الاستعادة نسخةً كاملة: تُكتب المخالفات نفسها مباشرة ثم تُفحص القاعدة كلها
    b.run(`INSERT INTO journal_entries (id,no,date,memo,status,auto,created_at) VALUES ('JU','JE-9300','2026-01-01','م','قيد الإنشاء',0,'x')`);
    b.run(`INSERT INTO journal_lines (id,entry_id,account_code,descr,debit_halalas,credit_halalas) VALUES ('JU-L0','JU','1100','',500,0)`);
    b.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = 'JU'`);
    b.run(`INSERT INTO journal_entries (id,no,date,memo,status,auto,created_at) VALUES ('JN','JE-9301','2026-01-01','م','مرحّل',0,'x')`);
    b.run(`UPDATE contract_installments SET paid_halalas = 999999 WHERE id = ?`, [k.inst]);
    b.run(`INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,method_label,notes,created_at)
           VALUES ('PN',?,?,'م','2026-01-01',-100,0,-100,'','','x')`, [k.cid, inst2]);
    const restoreSays = semanticIssues(b);
    expect(restoreSays).toHaveLength(4);
    const syncSaid = ['JU', 'JN', k.inst, 'PN'].map((pk) => reasonOf(b, pk));
    for (const reason of syncSaid) expect(reason.startsWith('الوارد مرفوض · ')).toBe(true);
    expect(syncSaid.map((x) => x.replace('الوارد مرفوض · ', '')).sort()).toEqual([...restoreSays].sort());
    b.close();
  });
});

describe('المبالغ أعداد صحيحة بالهللات في Firestore', () => {
  test('الترميز: integerValue للمبالغ وتعود أعداداً صحيحة كما كانت', () => {
    expect(encodeValue(226000)).toEqual({ integerValue: '226000' });
    expect(encodeValue(0.5)).toEqual({ doubleValue: 0.5 });
    const doc: RemoteDoc = { id: 'contract_payments__P1', t: 'contract_payments', k: 'P1', u: 'u', dev: 'd', del: false,
      d: { id: 'P1', gross_halalas: 248000, discount_halalas: 22000, net_halalas: 226000, notes: null } };
    const f = docToFields(doc) as Record<string, { mapValue?: { fields: Record<string, unknown> } }>;
    expect(f.d.mapValue!.fields.net_halalas).toEqual({ integerValue: '226000' });
    const back = fieldsToDoc(doc.id, docToFields(doc));
    expect(back.d).toEqual(doc.d);
    expect(Number.isInteger(back.d!.net_halalas)).toBe(true);
  });

  test('عميل REST: commit تحت users/{uid}/rows مع وقت الخادم · والمرفوض بعينه يُعزل · وسحب يبدأ بعد المؤشر', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    const fake = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, auth: init.headers.Authorization });
      // القواعد ترفض المستند b · والدفعة التي تحويه تُرفض كلها كما في Firestore
      const hasB = url.endsWith(':commit') && (body.writes as Array<{ update: { name: string } }>).some((w) => w.update.name.endsWith('/b'));
      if (hasB) return { ok: false, status: 403, text: async () => '{"error":{"status":"PERMISSION_DENIED"}}' };
      return { ok: true, status: 200, text: async () => (url.endsWith(':commit') ? '{}' : '[]') };
    }) as unknown as typeof fetch;
    const fs = new FirestoreRemote({ projectId: 'aqari-p', uid: 'U1', idToken: async () => 'TOKEN', fetchImpl: fake });
    const doc = (id: string): RemoteDoc => ({ id, t: 'tenants', k: id, u: 'u', dev: 'd', del: false, d: { id } });
    const res = await fs.write([doc('a'), doc('b'), doc('c')]);
    expect(res.map((r) => r.ok)).toEqual([true, false, true]);
    expect(res[1].code).toBe('PERMISSION_DENIED');
    expect(calls[0].url).toBe('https://firestore.googleapis.com/v1/projects/aqari-p/databases/(default)/documents:commit');
    expect(calls[0].auth).toBe('Bearer TOKEN');
    const w = (calls[0].body.writes as Array<Record<string, any>>)[0];
    expect(w.update.name).toBe('projects/aqari-p/databases/(default)/documents/users/U1/rows/a');
    expect(w.updateTransforms).toEqual([{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }]);
    const before = calls.length;
    await fs.pull({ ts: '2026-01-01T00:00:00.000001Z', id: 'tenants__a' }, 500);
    expect(calls[before].url).toBe('https://firestore.googleapis.com/v1/projects/aqari-p/databases/(default)/documents/users/U1:runQuery');
    const q = calls[before].body.structuredQuery as Record<string, any>;
    expect(q.startAt.values[1].referenceValue).toBe('projects/aqari-p/databases/(default)/documents/users/U1/rows/tenants__a');
    expect(q.startAt.before).toBe(false);
  });
});

describe('قواعد Firestore والمحرّك على قائمة واحدة', () => {
  test('الجداول المسموحة في القواعد هي SYNC_TABLES نفسها · ولا journal_lines بينها · وlines للقيد وحده', () => {
    const rules = fs.readFileSync(path.resolve(__dirname, '..', 'firestore.rules'), 'utf8');
    const block = /function syncedTable\(t\) \{\s*return t in \[([\s\S]*?)\];/.exec(rules)![1];
    const listed = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...listed].sort()).toEqual(SYNC_TABLES.map((t) => t.name).sort());
    expect(listed).not.toContain('journal_lines');
    expect(rules).toContain("!('lines' in r) || (r.t == 'journal_entries' && r.lines is list)");
  });

  test('كل عمود مالي في القاعدة (_halalas) تفحص القواعد أنه عدد صحيح · ولكل واحد اسم عربي في رسائل الرفض', () => {
    const rules = fs.readFileSync(path.resolve(__dirname, '..', 'firestore.rules'), 'utf8');
    const db = memDb();
    const money = moneyColumns(db);
    const cols = [...new Set([...money.values()].flat())].sort();
    expect(cols.length).toBeGreaterThanOrEqual(22);
    for (const c of cols) expect(rules).toContain(`intOrAbsent(r.d, '${c}')`);
    for (const [t, cs] of money) {
      expect(tableLabel(t)).not.toBe('جدول مالي');
      for (const c of cs) expect(columnLabel(c)).not.toBe('عمود مالي');
    }
    db.close();
  });
});

describe('الحالة للإعدادات', () => {
  test('الطابور والوارد والمرفوض وآخر مزامنة', async () => {
    const r = new MemoryRemote();
    const a = memDb();
    enableSync(a, UID);
    expect(syncStatus(a)).toMatchObject({ enabled: true, uid: UID, lastSyncAt: null });
    await sync(a, r);
    const s = syncStatus(a);
    expect(s.pending).toBe(0);
    expect(s.lastSyncAt).toBeTruthy();
    a.close();
  });
});
