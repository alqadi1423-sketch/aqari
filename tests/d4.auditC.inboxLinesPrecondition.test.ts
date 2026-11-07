/**
 * مدقق ج · شرطٌ مسبق لاختبار الهجرة ٥٢ (يُشغَّل على الأب feb6ceb): قيدٌ مرحّل من عضو بسطورٍ نصية ينتظر صفّ صفقته يبقى في الصندوق
 * (لا يُرفض) · فيصل إلى الترقية وهو فيه · بيانات مصطنعة.
 */
import { pair, sync, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';

test('v51: القيد بسطورٍ نصية ينتظر في الصندوق', async () => {
  const s = await pair();
  await sync(s.owner, s.r);
  const k = 'je-poison-c3';
  s.r.inject({ id: 'journal_entries__' + k, t: 'journal_entries', k, del: false, by: MEMBER, op: 'reservations', u: new Date().toISOString(), dev: 'dev-x',
    d: { id: k, no: 'PZ-3', date: '2026-11-01', status: 'مرحّل', src_type: 'key_money', src_id: 'deal-missing-c3', reversed_by: null, created_at: new Date().toISOString() },
    lines: ['x'] as never } as RemoteDoc);
  let err = '';
  try { await sync(s.owner, s.r); await sync(s.owner, s.r); } catch (e) { err = String(e); }
  const row = s.owner.get<{ e: string | null }>(`SELECT last_error AS e FROM sync_inbox WHERE pk = ?`, [k]);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ err, row }));
  expect(err).toBe('');
  expect(row).toBeDefined();
  s.close();
});
