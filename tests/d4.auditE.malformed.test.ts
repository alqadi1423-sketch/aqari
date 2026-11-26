/**
 * مدقق خارجي (هـ) · الجولة الثالثة · حمولةٌ مشوّهة في الوارد (الهجرة ٥٣ تحرس المحفّزات بـ j.type = 'object') · بيانات مصطنعة.
 * القواعد تشترط «lines is list» ولا تفحص عناصرها · فعنصرٌ null في سطور قيدٍ من عضو يمرّ من المحفّزات (j.type = 'null')، ثم يقرأ
 * applyOne «l.entry_id» على null خارج try (engine.ts: فحص «سطرٌ لقيدٍ آخر») فيرمي TypeError يُسقط دورة التطبيق كلها · والمستند باقٍ في
 * الوارد فتسقط كل دورةٍ بعدها: جهاز المالك لا يطبّق شيئاً بعده.
 */
import { addProperty } from './helpers/fixtures';
import { pair, sync, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';

describe('مدقق هـ · سطرٌ null في قيد عضو', () => {
  test('قيدٌ من عضوٍ سطوره [null]: يُرفض وحده، وجهاز المالك يواصل تطبيق ما بعده', async () => {
    const s = await pair();
    const bad = { id: 'journal_entries__nul-e', t: 'journal_entries', k: 'nul-e', u: new Date().toISOString(), dev: 'dev-x', del: false, by: MEMBER,
      d: { id: 'nul-e', no: 'NUL-1', date: '2026-11-01', memo: 'مصطنع', status: 'مسودة', created_at: '2026-11-01T00:00:00.000Z' },
      lines: [null] } as unknown as RemoteDoc;
    // يكتب العضو عقاراً مشروعاً ويرفعه، ثم يصل القيد المشوّه
    const p = addProperty(s.dev, { name: 'عقار قبل المشوّه مصطنع' });
    await sync(s.dev, s.r);
    s.r.inject(bad);
    const errs: string[] = [];
    for (const db of [s.owner, s.owner, s.dev]) {
      try { await sync(db, s.r); } catch (e) { errs.push((db === s.owner ? 'owner: ' : 'member: ') + String((e as Error).message).slice(0, 80)); }
    }
    const out = { errs, propertyApplied: !!s.owner.get(`SELECT 1 FROM properties WHERE id = ?`, [p]),
      inbox: s.owner.all(`SELECT tbl, pk FROM sync_inbox`), rejects: s.owner.all(`SELECT pk, substr(reason, 1, 60) AS r FROM sync_rejects`) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(errs).toEqual([]);
    expect(out.propertyApplied).toBe(true);
    s.close();
  });
});
