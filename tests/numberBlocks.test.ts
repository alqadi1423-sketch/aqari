/**
 * ترقيم المستندات بين الأجهزة (قرار المالك ٢٠٢٦-١٠-٠٥) · كتل من عدّاد الحساب بلا لاحقة والفجوات مقبولة،
 * والفاتورة الضريبية من العدّاد لحظة إصدارها بلا فجوة، وبلا اتصال مسودةٌ تصدر عند عودته · بيانات مصطنعة.
 */
import * as path from 'node:path';
import { memDb, tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import type { DB } from '@/db/adapter';
import {
  planBlocks, planInvoiceSeq, takeNumber, peekNumber, addBlock, readBlocks, mergeBlocks, blockRemaining,
  setDeviceLetter, BLOCK_SIZE, FIRST_GAP,
} from '@/domain/numbering';
import { postEntry, nextJournalNo, peekJournalNo } from '@/domain/accounting/post';
import { confirmContract } from '@/domain/contracts/service';
import { savePurchase } from '@/domain/purchases';
import { saveInvoice, isTempInvoiceNo } from '@/domain/invoices';
import {
  saveInvoiceIssued, setInvoiceStatusIssued, issuePendingInvoices, pendingIssues, INV_RESERVED_KEY,
} from '@/domain/invoiceIssue';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { wipeAllData } from '@/domain/wipe';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
const newEnv = () => { const d = tempDir('aq-num-'); dirs.push(d); return makeBackupEnv(d); };
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const manual = (db: DB) => postEntry(db, {
  date: '2026-03-01', memo: 'قيد يدوي', lines: [{ account: '1100', debit: 1000, credit: 0 }, { account: '3100', debit: 0, credit: 1000 }] })!;
const purchase = (db: DB) => savePurchase(db, { supplier: 'مورد مصطنع', date: '2026-03-01', due: '2026-03-31', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null, exempt: true, excludeFromVat: false, subtotalHalalas: 1000, taxHalalas: 0, totalHalalas: 1000 });
const invInput = { customer: 'عميل مصطنع', customerVat: '', issue: '2026-04-01', due: '2026-04-30', notes: '', lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 10000, taxPct: 15 }] };
const noOf = (db: DB, t: string, id: string) => db.get<{ no: string }>(`SELECT no FROM ${t} WHERE id = ?`, [id])!.no;

describe('الكتل', () => {
  test('العدّاد: أول إنشاء بعد الأرضية بفجوة، وما بعده بعد أعلى الاثنين · والفاتورة واحداً واحداً', () => {
    const a = planBlocks({}, [{ series: 'JE', size: 200, floor: 42, gap: 1000 }]);
    expect(a.out).toEqual([{ series: 'JE', lo: 1043, hi: 1242 }]);
    const b = planBlocks(a.next, [{ series: 'JE', size: 200, floor: 5000, gap: 1000 }]);
    expect(b.out[0].lo).toBe(5001);
    const c = planBlocks({ JE: 9000 }, [{ series: 'JE', size: 200, floor: 10, gap: 1000 }]);
    expect(c.out[0].lo).toBe(9001);
    expect(planInvoiceSeq({}, 7).out).toBe(8);
    expect(planInvoiceSeq({ INV: 20 }, 7).out).toBe(21);
  });

  test('الأخذ يستهلك والنظر لا · والكتلة المستهلكة تسقط · ودمج نسختين يأخذ الأبعد', () => {
    const db = memDb();
    addBlock(db, 'JE', 11, 12);
    addBlock(db, 'JE', 31, 31);
    expect(peekNumber(db, 'JE')).toBe(11);
    expect([takeNumber(db, 'JE'), takeNumber(db, 'JE'), takeNumber(db, 'JE'), takeNumber(db, 'JE')]).toEqual([11, 12, 31, null]);
    expect(readBlocks(db)).toEqual({ JE: [] });
    expect(mergeBlocks({ PUR: [{ lo: 1, hi: 9, next: 3 }] }, { PUR: [{ lo: 1, hi: 9, next: 6 }, { lo: 20, hi: 29, next: 20 }] }))
      .toEqual({ PUR: [{ lo: 1, hi: 9, next: 6 }, { lo: 20, hi: 29, next: 20 }] });
  });

  test('جهازان يعملان بلا اتصال بعد مزامنة: أرقامٌ بلا لاحقة لا تتصادم في القيود والعقود والمشتريات', async () => {
    const r = new MemoryRemote();
    const A = memDb(); const B = memDb();
    enableSync(A, 'U-NUM'); enableSync(B, 'U-NUM');
    await sync(A, r); await sync(B, r);
    expect(blockRemaining(A, 'JE')).toBe(BLOCK_SIZE.JE);
    r.offline = true;
    const ids: Array<[DB, string, string]> = [];
    for (const [k, db] of [A, B].entries()) {
      for (let i = 0; i < 3; i++) ids.push([db, 'journal_entries', manual(db).id]);
      ids.push([db, 'purchases', purchase(db)]);
      const p = addProperty(db, { name: 'عقار ترقيم ' + k });
      const c = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'N-' + k }), { tenant: 'مستأجر ترقيم ' + k, idNumber: '100000600' + k, phone: '050000600' + k }));
      expect(db.get<{ no: string }>(`SELECT contract_no AS no FROM contracts WHERE id = ?`, [c])!.no).toMatch(/^EJ-\d{4}-\d{3,}$/);
    }
    const nos = ids.map(([db, t, id]) => noOf(db, t, id));
    for (const n of nos) expect(n).toMatch(/^(JE-\d{4,}|PUR-\d{3,})$/);
    const all = (db: DB) => [
      ...db.all<{ no: string }>(`SELECT no FROM journal_entries`).map((x) => x.no),
      ...db.all<{ no: string }>(`SELECT no FROM purchases`).map((x) => x.no),
      ...db.all<{ no: string }>(`SELECT contract_no AS no FROM contracts`).map((x) => x.no),
    ];
    const both = [...all(A), ...all(B)];
    expect(new Set(both).size).toBe(both.length);
    // وتلتقي بعد عودة الاتصال بلا رفض
    r.offline = false;
    await sync(A, r); await sync(B, r); await sync(A, r);
    expect(A.all(`SELECT tbl, reason FROM sync_rejects`)).toEqual([]);
    expect(new Set(all(A)).size).toBe(all(A).length);
  });

  test('عدّادٌ جديد على حسابٍ فيه أرقام قديمة بلا حرف: يبدأ بعد أعلاها بفجوة · والنظر قبل الحفظ لا يستهلك', async () => {
    const r = new MemoryRemote();
    const db = memDb();
    for (let i = 0; i < 5; i++) manual(db);
    expect(nextJournalNo(db)).toBe('JE-0006'); // بلا كتلة: الترقيم القديم
    enableSync(db, 'U-OLD');
    await sync(db, r);
    expect(peekJournalNo(db)).toBe('JE-' + (5 + FIRST_GAP.JE + 1));
    expect(peekJournalNo(db)).toBe(peekJournalNo(db));
    expect(manual(db).no).toBe('JE-' + (5 + FIRST_GAP.JE + 1));
  });

  test('جهاز قديم بحرف لم يحجز بعد يُرقِّم بحرفه · وبعد المزامنة من كتلته بلا لاحقة', async () => {
    const r = new MemoryRemote();
    const db = memDb();
    setDeviceLetter(db, 'B');
    expect(manual(db).no).toBe('JE-0001-B');
    enableSync(db, 'U-LTR');
    await sync(db, r);
    expect(manual(db).no).toMatch(/^JE-\d+$/);
  });

  test('الاستعادة لا تعيد كتلةً من النسخة · والمسح يُبقي كتل الجهاز', async () => {
    const r = new MemoryRemote();
    const env = newEnv();
    enableSync(env.db, 'U-RST');
    await sync(env.db, r);
    const archive = path.join(env.root, 'n.aqbk');
    await createBackup(env, archive);
    const after = manual(env.db).no; // رقمٌ أُخذ بعد النسخة
    const db = (await commitRestore(env, await prepareRestore(env, archive))).db;
    const next = manual(db).no;
    expect(next).not.toBe(after);
    expect(Number(next.slice(3))).toBeGreaterThan(Number(after.slice(3)));
    await wipeAllData(env);
    expect(blockRemaining(env.db, 'JE')).toBeGreaterThan(0);
    expect(Number(manual(env.db).no.slice(3))).toBeGreaterThan(Number(next.slice(3)));
    env.closeLive();
  });
});

describe('الفاتورة الضريبية بلا فجوات', () => {
  test('المسودة برقم مؤقت · والإصدار من العدّاد بالتتابع على جهازين', async () => {
    const r = new MemoryRemote();
    const A = memDb(); const B = memDb();
    const draft = saveInvoice(A, invInput, 'مسودة');
    expect(isTempInvoiceNo(noOf(A, 'invoices', draft))).toBe(true);
    const x = await saveInvoiceIssued(A, r, invInput, 'مستحقة');
    const y = await saveInvoiceIssued(B, r, invInput, 'مستحقة');
    const z = await setInvoiceStatusIssued(A, r, draft, 'مستحقة');
    expect([noOf(A, 'invoices', x.id), noOf(B, 'invoices', y.id), noOf(A, 'invoices', z.id)]).toEqual(['INV-2026-0001', 'INV-2026-0002', 'INV-2026-0003']);
    // والإصدار رحّل قيده برقمه الحقيقي
    expect(A.get(`SELECT 1 FROM journal_entries WHERE memo LIKE '%INV-2026-0003%'`)).toBeTruthy();
  });

  test('بلا اتصال: تُحفظ مسودةً بانتظار الإصدار · وتصدر برقمها عند عودة الاتصال، وما حُذف يخرج من الانتظار', async () => {
    const r = new MemoryRemote();
    const db = memDb();
    r.offline = true;
    const a = await saveInvoiceIssued(db, r, invInput, 'مستحقة');
    const b = await saveInvoiceIssued(db, r, invInput, 'مستحقة');
    const gone = await saveInvoiceIssued(db, r, invInput, 'مستحقة');
    expect([a.pending, b.pending]).toEqual([true, true]);
    expect(db.get<{ s: string }>(`SELECT status AS s FROM invoices WHERE id = ?`, [a.id])!.s).toBe('مسودة');
    expect(pendingIssues(db)).toEqual([a.id, b.id, gone.id]);
    db.run(`UPDATE invoices SET deleted_at = 'x' WHERE id = ?`, [gone.id]);
    r.offline = false;
    expect(await issuePendingInvoices(db, r)).toBe(2);
    expect([noOf(db, 'invoices', a.id), noOf(db, 'invoices', b.id)]).toEqual(['INV-2026-0001', 'INV-2026-0002']);
    expect(pendingIssues(db)).toEqual([]);
    expect(isTempInvoiceNo(noOf(db, 'invoices', gone.id))).toBe(true);
  });

  test('رقمٌ أُخذ ولم تُكتب فاتورته يأخذه الإصدار التالي · فلا فجوة', async () => {
    const r = new MemoryRemote();
    const db = memDb();
    // عطلٌ في الكتابة المحلية بعد أخذ الرقم
    const broken: DB = { ...db, run: (sql, p) => { if (sql.includes('INSERT INTO invoices')) throw new Error('عطل كتابة مصطنع'); db.run(sql, p); } };
    await expect(saveInvoiceIssued(broken, r, invInput, 'مستحقة')).rejects.toThrow('عطل كتابة مصطنع');
    expect(getMeta(db, INV_RESERVED_KEY)).toBe('1');
    const ok = await saveInvoiceIssued(db, r, invInput, 'مستحقة');
    expect(noOf(db, 'invoices', ok.id)).toBe('INV-2026-0001');
    expect(getMeta(db, INV_RESERVED_KEY)).toBeNull();
  });

  test('جهازٌ لا يزامن يُرقِّم من تسلسله', async () => {
    const db = memDb();
    const a = await saveInvoiceIssued(db, null, invInput, 'مستحقة');
    expect(noOf(db, 'invoices', a.id)).toBe('INV-2026-0001');
  });
});
