/**
 * قرار المالك 2026-10-09 على #55: «أول إصدار بعد التفعيل مني، ورسالة صريحة بالسبب للعضو» · جهاز العضو لا يُنشئ أول رقمٍ
 * للفاتورة الضريبية، ويصله السبب، وفاتورته تُحفظ مسودة بلا انتظار · بيانات مصطنعة.
 */
import { FirestoreRemote, encodeFields } from '@/cloud/firestore';
import { FirstIssueByOwnerError } from '@/domain/numbering';
import { saveInvoiceIssued, pendingIssues } from '@/domain/invoiceIssue';
import { memDb } from './helpers/testDb';

function remote(counters: Record<string, number>, member: boolean) {
  const fetchImpl = (async (url: string, init?: { method?: string }) => {
    if (!init?.method || init.method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ fields: encodeFields(counters), updateTime: '2026-01-01T00:00:00Z' }), text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ commitTime: new Date().toISOString() }) };
  }) as unknown as typeof fetch;
  return new FirestoreRemote({ projectId: 'demo', uid: 'U', org: 'O', idToken: async () => 'T', baseUrl: 'http://x', fetchImpl,
    memberTokens: member ? () => ['invoices|@'] : undefined });
}

test('العضو لا يأخذ أول رقم فاتورة · والمالك يأخذه', async () => {
  await expect(remote({ JE: 10 }, true).takeInvoiceSeq(0)).rejects.toBeInstanceOf(FirstIssueByOwnerError);
  await expect(remote({ JE: 10 }, false).takeInvoiceSeq(0)).resolves.toBe(1);
  await expect(remote({ JE: 10, INV: 4 }, true).takeInvoiceSeq(0)).resolves.toBe(5);
});

test('فاتورة العضو تُحفظ مسودة بلا انتظار ويصله السبب', async () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
  const input = { customer: 'عميل مصطنع', customerVat: '', issue: '2026-03-01', due: '2026-03-01', notes: '',
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 1000, taxPct: 15, taxCode: 'S' as const }] };
  await expect(saveInvoiceIssued(db, remote({ JE: 10 }, true), input, 'مستحقة')).rejects.toBeInstanceOf(FirstIssueByOwnerError);
  expect(db.get(`SELECT status FROM invoices`)).toEqual({ status: 'مسودة' });
  expect(pendingIssues(db)).toEqual([]);
  db.close();
});
