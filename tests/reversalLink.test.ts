/**
 * قيدٌ يصل مربوطاً بعاكسٍ لم يصل (رفعٌ انقطع على جهاز آخر) لا يُحبس في الوارد ولا تُحبس دفعته معه ·
 * يُطبَّق، ويكتمل ربطه حين يصل عاكسه. بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { enableSync, stageInbox, applyInbox } from '@/sync/engine';
import type { RemoteDoc } from '@/sync/types';

const entry = (id: string, no: string, extra: Record<string, unknown> = {}, flip = false): RemoteDoc => ({
  id: 'journal_entries__' + id, t: 'journal_entries', k: id, u: '2026-05-01T00:00:00.000Z', dev: 'dev-x', del: false,
  d: { id, no, date: '2026-05-01', memo: 'قيد تجريبي', status: 'مرحّل', auto: 1, src_type: 'manual', src_id: null, created_at: 'x', reversed_by: null, ...extra },
  lines: [
    { id: id + '-1', entry_id: id, account_code: '1100', descr: '', debit_halalas: flip ? 0 : 500, credit_halalas: flip ? 500 : 0 },
    { id: id + '-2', entry_id: id, account_code: '4200', descr: '', debit_halalas: flip ? 500 : 0, credit_halalas: flip ? 0 : 500 },
  ],
});

test('العاكس الغائب لا يحبس القيد · ويكتمل الربط حين يصل', () => {
  const db = memDb();
  enableSync(db, 'U-X');
  stageInbox(db, [entry('EA', 'JE-9001', { reversed_by: 'EB' })]);
  const r1 = applyInbox(db, 'dev-y');
  expect(r1.waiting).toBe(0);
  expect(db.get<{ reversed_by: string | null }>(`SELECT reversed_by FROM journal_entries WHERE id = 'EA'`)!.reversed_by).toBeNull();
  // يصل العاكس لاحقاً
  stageInbox(db, [entry('EB', 'JE-9002', { src_type: 'manual_rev', src_id: 'EA' }, true)]);
  applyInbox(db, 'dev-y');
  expect(db.get<{ reversed_by: string | null }>(`SELECT reversed_by FROM journal_entries WHERE id = 'EA'`)!.reversed_by).toBe('EB');
  db.close();
});
