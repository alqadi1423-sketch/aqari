/**
 * مدقق خارجي (I) · الجولة الخامسة · عُدّة مشتركة لاختبارات auditI · بيانات مصطنعة.
 */
import { bankBalance, walletCashBalance } from '@/domain/accounting/ledger';
import { MEMBER } from './rederive';
import type { MemoryRemote } from './memoryRemote';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';

/** لقطة أوقات المستندات في السحابة · ما تغيّر بعدها كتبه الجهاز الثاني */
/** نسخ السحابة قبل كتابة «العضو» · لتُفحص كتابته بقاعدة السحابة كما تُفحص كتابته الحقيقية (openingKept) */
const PRIOR = new WeakMap<Map<string, string>, Map<string, RemoteDoc>>();
export const snap = (r: MemoryRemote) => {
  const m = new Map([...r.docs.values()].map((d) => [d.id, d.ts] as const));
  PRIOR.set(m, new Map([...r.docs.values()].map((d) => [d.id, JSON.parse(JSON.stringify(d)) as RemoteDoc])));
  return m;
};

const OP: Record<string, string> = {
  bank_tx: 'banks', banks: 'banks', key_money_deals: 'reservations', purchases: 'purchases', purchase_lines: 'purchases',
  invoices: 'invoices', invoice_lines: 'invoices', assets: 'assets', asset_events: 'assets', suppliers: 'purchases',
};
/** ما رفعه الجهاز الثاني بعد اللقطة يُعاد بكاتبه العضو (وقسم عمليته) */
export function newAsMember(r: MemoryRemote, since: Map<string, string>): RemoteDoc[] {
  const out: RemoteDoc[] = [];
  for (const d of [...r.docs.values()]) {
    if (since.get(d.id) === d.ts || d.by === MEMBER) continue;
    const { ts: _t, ...doc } = d as RemoteDoc & { ts: string };
    const op = d.t === 'journal_entries' ? 'banks' : OP[d.t] ?? 'banks';
    const m = { ...doc, by: MEMBER, op } as RemoteDoc;
    // وما ترفضه قاعدة السحابة من العضو لا يُكتب: تبقى النسخة السابقة (الافتتاحي للمالك وحده · المدقق الخارجي O٥)
    const prior = PRIOR.get(since)?.get(d.id);
    if (!r.openingKept(prior, m)) {
      if (prior) r.docs.set(d.id, prior as RemoteDoc & { ts: string });
      else r.docs.delete(d.id);
      continue;
    }
    r.inject(m);
    out.push(m);
  }
  return out;
}

export const bal = (db: DB, banks: string[]) => [...banks.map((b) => bankBalance(db, b)), walletCashBalance(db)];
export const cash1100 = (db: DB) => Number(db.get<{ n: number }>(
  `SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas), 0) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
   WHERE e.status = 'مرحّل' AND l.account_code = '1100'`)!.n);
export const rejects = (db: DB) => db.all<{ tbl: string; pk: string; reason: string }>(`SELECT tbl, pk, reason FROM sync_rejects`);
export const waiting = (db: DB) => db.all<{ tbl: string; pk: string; last_error: string | null }>(`SELECT tbl, pk, last_error FROM sync_inbox`);
