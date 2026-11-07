/**
 * عُدّة اختبارات إعادة الاشتقاق (التوجيه الثالث · ١) على نمط tests/deriveRent.test.ts: جهاز المالك وجهازٌ ثانٍ على الحساب نفسه ·
 * الثاني يعمل ثم يرفع، وقيده يُعلَّم بكاتبه العضو ويُعدَّل إن طُلب · بيانات مصطنعة.
 */
import { memDb } from './testDb';
import { MemoryRemote } from './memoryRemote';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

export const UID = 'owner-rd';
export const MEMBER = 'member-rd';
export type Lines = NonNullable<RemoteDoc['lines']>;

export const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
export const reasonOf = (db: DB, pk: string) =>
  db.get<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE pk = ? ORDER BY id DESC`, [pk])?.reason ?? '';
export const has = (db: DB, id: string) => !!db.get(`SELECT 1 FROM journal_entries WHERE id = ? AND status = 'مرحّل'`, [id]);

export async function pair() {
  const r = new MemoryRemote();
  const owner = memDb();
  const dev = memDb();
  enableSync(owner, UID);
  enableSync(dev, UID);
  return { r, owner, dev, close: () => { owner.close(); dev.close(); } };
}

/** آخر قيدٍ في الحساب بمصدره */
export function lastEntry(r: MemoryRemote, src: string): RemoteDoc {
  const docs = [...r.docs.values()].filter((d) => d.t === 'journal_entries' && d.d?.src_type === src);
  if (!docs.length) throw new Error('لا قيد ' + src); // i18n-exempt: رسالة اختبار
  return docs[docs.length - 1];
}

/** آخر قيدٍ بمصدره في الحساب بكاتبه العضو · وسطوره بعد التعديل · يعيد معرّفه */
export function asMember(r: MemoryRemote, src: string, edit?: (lines: Lines) => Lines): string {
  const o = lastEntry(r, src);
  r.inject({ ...o, by: MEMBER, lines: edit ? edit(o.lines!) : o.lines });
  return o.k;
}

/** المبالغ مضاعفة (القيد يبقى متوازناً) */
export const doubled = (ls: Lines): Lines =>
  ls.map((l) => ({ ...l, debit_halalas: Number(l.debit_halalas) * 2, credit_halalas: Number(l.credit_halalas) * 2 }));
/** حسابٌ منقول إلى غيره بالمبلغ نفسه */
export const moved = (from: string, to: string) => (ls: Lines): Lines =>
  ls.map((l) => (l.account_code === from ? { ...l, account_code: to } : l));
/** أبعاد مستندٍ آخر على كل السطور */
export const otherDims = (d: { contract_id?: string | null; unit_id?: string | null; property_id?: string | null }) => (ls: Lines): Lines =>
  ls.map((l) => ({ ...l, ...d }));

/** يسحب المالك مرتين (ما ينتظر أباه يُعاد في المرور التالي) */
export async function ownerPulls(owner: DB, r: MemoryRemote) {
  await sync(owner, r);
  await sync(owner, r);
}

let forged = 0;
/** قيدٌ مزوّر من عضو على مثال قيدٍ في الحساب: معرّفٌ ورقمٌ ومعرّفات سطورٍ جديدة · وعاكسه إن سُمّي */
export function forge(base: RemoteDoc, over: { k?: string; src_type?: string; no?: string; reversed_by?: string | null; lines: Lines }): RemoteDoc {
  const n = ++forged;
  const k = over.k ?? 'forged-' + n;
  return {
    ...base, id: 'journal_entries__' + k, k, by: MEMBER,
    d: { ...base.d, id: k, no: over.no ?? 'FG-' + n, src_type: over.src_type ?? base.d!.src_type, reversed_by: over.reversed_by ?? null },
    lines: over.lines.map((l, i) => ({ ...l, id: k + '-l' + i, entry_id: k })),
  };
}
/** مرآة السطور: مدينها دائن ودائنها مدين */
export const mirrorOf = (ls: Lines): Lines => ls.map((l) => ({ ...l, debit_halalas: l.credit_halalas, credit_halalas: l.debit_halalas }));
/** رصيد حسابٍ في الدفتر المرحّل (مدينه موجب) · وبشرطٍ على القيد إن أُعطي */
export const net = (db: DB, account: string, where = '1 = 1', params: string[] = []) => Number(db.get<{ n: number }>(
  `SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas), 0) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
   WHERE e.status = 'مرحّل' AND l.account_code = ? AND ${where}`, [account, ...params])!.n);
/** كل قيود المصدر (بعواكسها إن طابقها النمط) في الحساب بكاتبها العضو */
export function srcAsMember(r: MemoryRemote, re: RegExp): string[] {
  const ids: string[] = [];
  for (const d of [...r.docs.values()]) {
    if (d.t !== 'journal_entries' || !re.test(String(d.d?.src_type))) continue;
    r.inject({ ...d, by: MEMBER });
    ids.push(d.k);
  }
  return ids;
}
