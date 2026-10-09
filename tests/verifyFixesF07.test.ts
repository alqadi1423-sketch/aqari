/**
 * التحقق المستقل من f07ad73 وc789999 (القاعدة ٣٥) · ما وجده يُصلح (القاعدة ٩٦) · بيانات مصطنعة:
 *  ١. قواعد اللمس الجانبي وربط العكس والرؤية والأبعاد تقبل «sv» فلا تُرفض تعديلات الصفوف القديمة بعد الحد
 *  ٢. المرفوض بالصلاحية والوارد المرفوض يُعادان بعد ترقية التطبيق مرة لكل إصدار (مورد الغاز على جهازٍ أقدم مثلاً)
 *  ٣. جهاز العضو لا يحكم بـ«بلا مستند» على قيودٍ مستندها في قسمٍ لا يقرؤه
 *  ٤. الصف الواحد المرفوض بـ٤٠٠ يُرفض وحده ولا يوقف الدفعة
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { FirestoreRemote } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';
import { replayRejectsAfterUpgrade } from '@/sync/engine';
import { postEntry } from '@/domain/accounting/post';
import { integrityChecks } from '@/domain/accounting/integrity';
import { isOrphanEntry } from '@/domain/accounting/orphans';
import { SCHEMA_VERSION } from '@/db/schema';

test('١ القواعد المولَّدة تجيز «sv» في قوائم المفاتيح المتغيّرة كلها', () => {
  const all = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  // كتلة المنشأة المولَّدة وحدها (صفوفها تحمل «sv») · لا المسار القديم ولا المحادثة
  const rules = all.slice(all.indexOf('<org:generated>'), all.indexOf('</org:generated>'));
  const lists = rules.match(/affectedKeys\(\)\.hasOnly\(\[[^\]]*'dev'[^\]]*\]\)/g) ?? [];
  expect(lists.length).toBeGreaterThanOrEqual(4);
  expect(lists.filter((l) => !l.includes("'sv'"))).toEqual([]);
});

test('٢ المرفوض يُعاد بعد الترقية مرة لكل إصدار', () => {
  const db = memDb();
  db.run(`INSERT INTO properties (id, name, created_at) VALUES ('PR1', 'عقار مرفوض مصطنع', '2026-01-01')`);
  const incoming = { id: 'suppliers__S9', t: 'suppliers', k: 'S9', d: { id: 'S9', name: 'مورد غاز مصطنع', utility_type: 'غاز', created_at: '2026-01-01' }, u: '2026-01-02T00:00:00.000Z', dev: 'D2', del: false };
  db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`,
    ['properties__PR1', 'properties', 'PR1', 'خارج صلاحيتك · بقي على هذا الجهاز ولم يُرفع', '{}', '2026-01-03']);
  db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`,
    ['suppliers__S9', 'suppliers', 'S9', 'CHECK constraint failed', JSON.stringify(incoming), '2026-01-03']);
  expect(replayRejectsAfterUpgrade(db, SCHEMA_VERSION)).toEqual({ requeued: 1, restaged: 1 });
  expect(db.get(`SELECT op FROM sync_outbox WHERE tbl = 'properties' AND pk = 'PR1'`)).toEqual({ op: 'upsert' });
  expect(db.get(`SELECT tbl FROM sync_inbox WHERE doc = 'suppliers__S9'`)).toEqual({ tbl: 'suppliers' });
  expect(db.get(`SELECT COUNT(*) AS n FROM sync_rejects`)).toEqual({ n: 0 });
  // مرة لكل إصدار
  expect(replayRejectsAfterUpgrade(db, SCHEMA_VERSION)).toEqual({ requeued: 0, restaged: 0 });
  db.close();
});

test('٣ جهاز العضو لا يرى قيداً بلا مستندٍ في قسمٍ لا يقرؤه', () => {
  const db = memDb();
  db.run(`INSERT INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'O', uid: 'U', perms: { ledger: 1 }, allProps: true, props: [] })]);
  const e = postEntry(db, { date: '2026-02-01', memo: 'سداد فاتورة مصطنع', srcType: 'invoice_pay', srcId: 'INV-NOT-HERE',
    lines: [{ account: '1100', debit: 1000, credit: 0 }, { account: '1200', debit: 0, credit: 1000 }] })!;
  expect(isOrphanEntry(db, e.id)).toBe(false);
  expect(integrityChecks(db).find((c) => c.name === 'لا قيود يتيمة لمصادر محذوفة')!.ok).toBe(true);
  db.close();
});

test('٤ الصف المعيب بـ٤٠٠ يُرفض وحده وتمضي البقية', async () => {
  const fetchImpl = (async (_u: string, init?: { body?: string }) => {
    const writes = (JSON.parse(String(init?.body ?? '{}')) as { writes?: Array<{ update?: { name?: string } }> }).writes ?? [];
    const bad = writes.some((w) => String(w.update?.name ?? '').endsWith('units__U7'));
    return bad ? { ok: false, status: 400, text: async () => '{"error":{"status":"INVALID_ARGUMENT"}}' }
      : { ok: true, status: 200, text: async () => JSON.stringify({ commitTime: new Date().toISOString() }) };
  }) as unknown as typeof fetch;
  const remote = new FirestoreRemote({ projectId: 'demo', uid: 'U', org: 'O', idToken: async () => 'T', baseUrl: 'http://x', fetchImpl });
  const docs = Array.from({ length: 20 }, (_, i) => ({ id: 'units__U' + i, t: 'units', k: 'U' + i, d: { id: 'U' + i }, u: '2026-01-01T00:00:00Z', dev: 'D', del: false, g: ['units|P1'], pids: ['P1'] })) as unknown as RemoteDoc[];
  const r = await remote.write(docs);
  expect(r.filter((x) => !x.ok).length).toBe(1);
  expect(r[7].ok).toBe(false);
  expect(r.filter((x) => x.ok).length).toBe(19);
});
