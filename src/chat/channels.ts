/**
 * القنوات ومحادثات العقارات (قرار المالك 2026-10-08T05:31Z · الدفعة ٤): «قنوات للأقسام، وإضافة العضو الجديد لقنوات
 * أقسامه تلقائياً، وقناة إعلانات للإدارة» و«محادثة تلقائية لكل عقار تجمع ما يخصه، ويراها من له صلاحية على العقار».
 *  - جهاز المالك ينشئ القنوات: الإعلانات، وقناةً لكل قسم له عضو، ومحادثةً لكل عقار قائم · ويُخرج منها من لم تعد
 *    تحق له (والقواعد تمنعه القراءة والإرسال قبل ذلك).
 *  - جهاز العضو يضمّه إلى ما تحق له بصلاحيته · والقواعد تفرض الصلاحية من مستند عضويته.
 */
import type { DB } from '../db/adapter';
import { GRANTABLE, sectionDef, type SectionKey } from '../domain/access/sections';
import { readMembership } from '../services/access';
import type { ChatRemote } from './remote';
import { applyRemoteThread, listThreads } from './store';
import { channelId, type ChannelRef, type ChatMe } from './types';
import { getSyncState, setSyncState } from '../sync/engine';

export const ANNOUNCE_NAME = 'إعلانات الإدارة'; // i18n-exempt: اسم القناة المخزّن
const JOIN_RETRY_MS = 60 * 60_000;

interface MemberPerm { uid: string; perm: Record<string, number>; all: boolean; props: string[] }

/** تحق القناة لهذا العضو؟ (مطابق لقواعد الخادم chatQualifies) */
export function qualifies(ch: ChannelRef, m: { perm: Record<string, number>; all: boolean; props: string[] }): boolean {
  if (ch.t === 'announce') return true;
  if (ch.t === 'section') return (m.perm[ch.key] ?? 0) >= 1;
  return m.all || m.props.includes(ch.id);
}

function activeProperties(db: DB): Array<{ id: string; name: string }> {
  try {
    return db.all<{ id: string; name: string }>(`SELECT id, name FROM properties WHERE deleted_at IS NULL AND COALESCE(archived, 0) = 0`);
  } catch { return []; }
}

/** القنوات التي ينشئها المالك: الإعلانات، وقسمٌ له عضو، وكل عقار قائم */
export function wantedChannels(db: DB, members: MemberPerm[]): Array<{ ch: ChannelRef; name: string }> {
  const out: Array<{ ch: ChannelRef; name: string }> = [{ ch: { t: 'announce' }, name: ANNOUNCE_NAME }];
  for (const s of GRANTABLE) {
    if (members.some((m) => (m.perm[s.key] ?? 0) >= 1)) out.push({ ch: { t: 'section', key: s.key }, name: sectionDef(s.key as SectionKey).label });
  }
  // رقم العقار بصيغة القواعد وحدها (فلا تُرفض القناة كل دورة) · وحين يكون فيها عضو غير المالك (قرار المالك 2026-10-08T10:24Z)
  for (const p of activeProperties(db)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(p.id)) continue;
    if (members.some((m) => qualifies({ t: 'prop', id: p.id }, m))) out.push({ ch: { t: 'prop', id: p.id }, name: p.name });
  }
  return out;
}

/** عند المالك: تُنشأ القنوات الناقصة · ويُخرج منها من لم تعد تحق له */
export async function ensureChannels(db: DB, remote: ChatRemote, me: ChatMe): Promise<{ created: number; removed: number }> {
  const members = await remote.members();
  const local = new Map(listThreads(db, me.uid).map((t) => [t.id, t]));
  let created = 0;
  let removed = 0;
  // كلٌّ وحده: فشلُ قناةٍ لا يوقف غيرها ولا الإخراج
  for (const w of wantedChannels(db, members)) {
    const id = channelId(w.ch);
    if (local.has(id)) continue;
    try {
      if ((await remote.createChannel(id, w.ch, w.name)) === 'created') created++;
      applyRemoteThread(db, await remote.getThread(id));
    } catch { /* تُعاد في الدورة التالية */ }
  }
  // قائمة أعضاء فارغة وفي القنوات أعضاء: لا إخراج (قراءةٌ ناقصة لا تُخرج الجميع)
  const anyone = listThreads(db, me.uid).some((t) => t.channel && t.members.some((u) => u !== me.uid));
  if (!members.length && anyone) return { created, removed };
  for (const t of listThreads(db, me.uid)) {
    if (!t.channel) continue;
    const gone = t.members.filter((u) => u !== me.uid && !members.some((m) => m.uid === u && qualifies(t.channel!, m)));
    if (!gone.length) continue;
    try {
      await remote.removeMembers(t.id, gone);
      removed += gone.length;
      applyRemoteThread(db, await remote.getThread(t.id));
    } catch { /* تُعاد في الدورة التالية */ }
  }
  return { created, removed };
}

/** عند العضو: ينضم إلى ما تحق له مما ليس فيه · وما تعذّر (لم تُنشأ بعد) يُعاد بعد ساعة */
export async function autoJoinChannels(db: DB, remote: ChatRemote, me: ChatMe, now = Date.now()): Promise<number> {
  const m = readMembership(db);
  if (!m) return 0;
  const mine = { perm: m.perms as Record<string, number>, all: m.allProps, props: m.props };
  const cands: ChannelRef[] = [{ t: 'announce' }];
  for (const s of GRANTABLE) if (qualifies({ t: 'section', key: s.key }, mine)) cands.push({ t: 'section', key: s.key });
  for (const p of activeProperties(db)) if (qualifies({ t: 'prop', id: p.id }, mine)) cands.push({ t: 'prop', id: p.id });
  const inThreads = new Set(listThreads(db, me.uid, true).map((t) => t.id));
  let joined = 0;
  for (const ch of cands) {
    const id = channelId(ch);
    if (inThreads.has(id)) continue;
    const key = 'chat_chjoin_' + id;
    const tried = getSyncState(db, key);
    if (tried && now - Number(tried) < JOIN_RETRY_MS) continue;
    try {
      await remote.addMember(id, me.uid);
      applyRemoteThread(db, await remote.getThread(id));
      joined++;
    } catch {
      setSyncState(db, key, String(now));
    }
  }
  return joined;
}
