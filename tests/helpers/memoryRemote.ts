/**
 * سحابة في الذاكرة بسلوك Firestore وقواعد الأمان نفسها: الكتابة غير ذرية بنتيجة لكل مستند،
 * وقت الخادم يتزايد، القيد المرحّل وسجل العمليات لا يُعدَّلان إلا ربط القيد العكسي مرة واحدة.
 */
import type { Cursor, RemoteDoc, RemoteStore, WriteResult } from '@/sync/types';
import { syncTable } from '@/db/syncTables';
import { planBlocks, planInvoiceSeq, type BlockRequest, type ReservedBlock } from '@/domain/numbering';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export class MemoryRemote implements RemoteStore {
  docs = new Map<string, RemoteDoc & { ts: string }>();
  private clock = 0;
  /** محاكاة انقطاع الاتصال */
  offline = false;
  /** فرق ساعة الجهاز الكاتب عن الخادم · لاختبار حسم التعارض بساعة الخادم */
  deviceSkewMs = 0;
  private sample: { serverMs: number; localMs: number } | null = null;
  clockSample(): { serverMs: number; localMs: number } | null {
    const s = this.sample;
    this.sample = null;
    return s;
  }
  writes = 0;

  private stamp(): string {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return new Date(this.clock).toISOString();
  }

  private allowed(prev: RemoteDoc | undefined, next: RemoteDoc): boolean {
    if (!syncTable(next.t)) return false;                                   // جدول خارج المزامنة
    if (next.lines !== undefined && next.t !== 'journal_entries') return false; // السطور للقيد وحده
    if (!prev) return true;
    if (prev.t === 'audit_log') return false;
    const posted = prev.t === 'journal_entries' && prev.d?.status === 'مرحّل';
    if (!posted) return true;
    if (!next.d) return false;
    // أبعاد سطوره وحدها تُملأ (الهجرة ٢٨) · كقاعدة orgOnlyLineDims في firestore.rules
    const noDims = (ls: unknown) => JSON.stringify(((ls as Array<Record<string, unknown>> | undefined) ?? [])
      .map(({ property_id, unit_id, contract_id, cost_center_id, asset_id, ...rest }) => rest));
    if (JSON.stringify(prev.d) === JSON.stringify(next.d) && prev.del === next.del && noDims(prev.lines) === noDims(next.lines)) return true;
    // الربط بالقيد العكسي وحده ومرة واحدة
    if (prev.d!.reversed_by != null || typeof next.d.reversed_by !== 'string') return false;
    const a = { ...prev.d, reversed_by: null };
    const b = { ...next.d, reversed_by: null };
    return JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(prev.lines) === JSON.stringify(next.lines) && prev.del === next.del;
  }

  async write(docs: RemoteDoc[]): Promise<WriteResult[]> {
    if (this.offline) throw new Error('Network request failed');
    const now = Date.now();
    this.sample = { serverMs: now, localMs: now + this.deviceSkewMs };
    return docs.map((d) => {
      const prev = this.docs.get(d.id);
      if (!this.allowed(prev, d)) return { ok: false, code: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' };
      this.writes += 1;
      this.docs.set(d.id, { ...clone(d), ts: this.stamp() });
      return { ok: true, code: 'OK' };
    });
  }

  async pull(cursor: Cursor | null, limit: number): Promise<{ docs: RemoteDoc[]; next: Cursor | null }> {
    if (this.offline) throw new Error('Network request failed');
    const all = [...this.docs.values()].sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? -1 : 1) : a.ts < b.ts ? -1 : 1));
    const after = cursor ? all.filter((d) => d.ts > cursor.ts || (d.ts === cursor.ts && d.id > cursor.id)) : all;
    const page = after.slice(0, limit).map(clone);
    const last = page[page.length - 1];
    return { docs: page, next: last ? { ts: last.ts, id: last.id } : cursor };
  }

  /** عدّاد الترقيم كسجل meta/counters */
  counters: Record<string, number> = {};
  async reserveBlocks(req: BlockRequest[]): Promise<ReservedBlock[]> {
    if (this.offline) throw new Error('Network request failed');
    const { next, out } = planBlocks(this.counters, req);
    this.counters = { ...this.counters, ...next };
    return out;
  }
  async takeInvoiceSeq(floor: number): Promise<number> {
    if (this.offline) throw new Error('Network request failed');
    const { next, out } = planInvoiceSeq(this.counters, floor);
    this.counters = { ...this.counters, ...next };
    return out;
  }

  /** كتابة مباشرة كما يفعل جهاز آخر أو عابث · لاختبار ما يرد */
  inject(doc: RemoteDoc): void {
    this.docs.set(doc.id, { ...clone(doc), ts: this.stamp() });
  }
}
