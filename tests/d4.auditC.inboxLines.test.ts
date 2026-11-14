/**
 * مدقق خارجي (ج) · الجولة الثانية · محفّزات sync_inbox_lines (الهجرة ٥٢ · 825f162) · بيانات مصطنعة.
 * المحفّز يحسب json_extract(j.value, '$.id') لكل عنصرٍ في lines عند إدراج المستند في الصندوق (stageInbox) · وعنصرٌ نصّيٌّ غير JSON
 * (القواعد تشترط lines قائمةً ولا تفحص عناصرها) يرمي «malformed JSON» خارج applyOne: تسقط معاملة الصفحة كلها، ولا يتقدّم المؤشر،
 * فيُسحب المستند نفسه ويسقط في كل دورة: جهاز المالك لا يطبّق شيئاً بعده أبداً.
 */
import { addProperty } from './helpers/fixtures';
import { pair, sync, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';

describe('مدقق ج · sync_inbox_lines', () => {
  test('مستند قيدٍ من عضو سطورُه نصوص: لا يوقف مزامنة جهاز المالك، وما بعده يصل', async () => {
    const s = await pair();
    addProperty(s.owner, { name: 'عقار وارد مصطنع' });
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    // مسودة قيد (القواعد: lines قائمة، والمسودة لا تشترط dr/cr) عناصر سطورها نصوص
    const k = 'je-poison-c1';
    s.r.inject({ id: 'journal_entries__' + k, t: 'journal_entries', k, del: false, by: MEMBER, op: 'ledger', u: new Date().toISOString(), dev: 'dev-x',
      d: { id: k, no: 'PZ-1', date: '2026-11-01', memo: 'مصطنع', status: 'مسودة', src_type: null, src_id: null, reversed_by: null,
        created_at: new Date().toISOString() },
      lines: ['x'] as never } as RemoteDoc);
    // ثم عملٌ مشروع من الجهاز الثاني (يسحب قبل أن يرفع، فيسقط هو أيضاً)
    const later = addProperty(s.dev, { name: 'عقار لاحق مصطنع' });
    const devErrs: string[] = [];
    try { await sync(s.dev, s.r); } catch (e) { devErrs.push(e instanceof Error ? e.message : String(e)); }
    const errs: string[] = [];
    for (let i = 0; i < 3; i++) {
      try { await sync(s.owner, s.r); } catch (e) { errs.push(e instanceof Error ? e.message : String(e)); }
    }
    const arrived = !!s.owner.get(`SELECT 1 FROM properties WHERE id = ?`, [later]);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ errs, devErrs, arrived, inbox: s.owner.get(`SELECT COUNT(*) AS n FROM sync_inbox`), cursor: s.owner.get(`SELECT v FROM sync_state WHERE k = 'cursor'`) }));
    expect(errs).toEqual([]);
    expect(devErrs).toEqual([]);
    expect(arrived).toBe(true);
    s.close();
  });
});

describe('مدقق ج · الهجرة ٥٢ على قاعدةٍ في صندوقها مستندٌ كهذا', () => {
  test('على v51 قيدٌ مرحّل من عضو بسطورٍ نصية ينتظر مستنده في الصندوق · ثم الترقية: القاعدة تفتح', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { schemaAt } = require('./helpers/oldSchema') as typeof import('./helpers/oldSchema');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { migrate, currentSchemaVersion } = require('@/db/migrations') as typeof import('@/db/migrations');
    const db = schemaAt(':memory:', 51);
    const k = 'je-poison-c2';
    const doc = { id: 'journal_entries__' + k, t: 'journal_entries', k, del: false, by: MEMBER, op: 'reservations', u: '2026-11-01T00:00:00.000Z',
      dev: 'dev-x', d: { id: k, no: 'PZ-2', date: '2026-11-01', status: 'مرحّل', src_type: 'key_money', src_id: 'deal-missing-c2', reversed_by: null },
      lines: ['x'] };
    // كما يتركه v51: ينتظر صفّ الصفقة (deriveSrc.noDoc) فيبقى في الصندوق
    db.run(`INSERT INTO sync_inbox (doc, tbl, pk, rank, payload, updated_at, device_id, attempts, last_error, del) VALUES (?,?,?,?,?,?,?,3,'بانتظار سجل أب',0)`,
      [doc.id, 'journal_entries', k, 18, JSON.stringify(doc), doc.u, 'dev-x']);
    let err = '';
    try { migrate(db); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ err, version: currentSchemaVersion(db) }));
    expect(err).toBe('');
    db.close();
  });
});
