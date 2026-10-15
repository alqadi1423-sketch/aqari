/**
 * المتحقق المستقل، الجولة ٣٥ (ج١): لقطة السحابة التي تُبنى عليها الاستعادة والاعتماد لا تقرأ ما كُتب في عهد مسحٍ أقدم، كما لا
 * يسحبه الجهاز (النتيجة ٢٣) · كانت تضمّ قيداً مرحّلاً من عهدٍ ممسوح · بيانات مصطنعة.
 */
import { MemoryRemote } from './helpers/memoryRemote';
import { docId, readCloud } from '@/sync/engine';
import type { RemoteDoc } from '@/sync/types';

const AT = '2026-10-15T00:00:00.000Z';
const entry = (k: string, ep?: number): RemoteDoc => ({
  id: docId('journal_entries', k), t: 'journal_entries', k, u: AT, dev: 'other', del: false, ...(ep ? { ep } : {}),
  d: { id: k, no: 'JE-' + k, date: '2026-01-02', memo: 'قيد مصطنع', status: 'مرحّل', auto: 0, src_type: null, src_id: null,
    created_at: AT, deleted_at: null, reversed_by: null },
  lines: [{ id: k + 'a', entry_id: k, account_code: '1100', descr: '', debit_halalas: 100, credit_halalas: 0 },
    { id: k + 'b', entry_id: k, account_code: '3100', descr: '', debit_halalas: 0, credit_halalas: 100 }],
});

test('عهد المسح ٢: لا يُقرأ ما كُتب بعهد ١ ولا بلا عهد · ويُقرأ ما كُتب بعهد ٢', async () => {
  const r = new MemoryRemote();
  r.inject(entry('OLD1', 1));
  r.inject(entry('NONE'));
  r.inject(entry('NEW2', 2));
  expect((await readCloud(r, undefined, 2)).docs.map((d) => d.k)).toEqual(['NEW2']);
  expect((await readCloud(r)).docs.map((d) => d.k).sort()).toEqual(['NEW2', 'NONE', 'OLD1']);
});
