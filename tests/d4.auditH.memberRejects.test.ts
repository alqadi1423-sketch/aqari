/**
 * المدقق الخارجي H · الجولة الرابعة · أثر إصلاح F٥ (failureDb → openedAppDb) على جهاز العضو، كما هو في 97d0beb.
 * reportFailure يكتب الآن في كل موضعٍ بلا db (١١٥ موضعاً) سطراً عاماً في سجل العمليات «فشل …» (failureDialog.ts:95-99) مع تقرير العطل ·
 * وسطر السجل العام من عضوٍ لا قسم إدخالٍ له لا يجد عملية (acl.ts:192 chooseOp → null، وليس «بيانات عضو» ولا «تقرير عطل») فيُعدّ
 * «لا قسم يجيزه» ويُكتب في sync_rejects «خارج صلاحيتك · بقي على هذا الجهاز ولم يُرفع» (engine.ts:2006 و:2039) · فيظهر في الإعدادات
 * «N مرفوض عند الوصول» بالأحمر (settings.tsx:673-676) عن عملٍ لم يقم به المستخدم، مع كل عطلٍ في التحصيل والعقود والفواتير…
 * (تقرير العطل نفسه مستثنى من المرفوض في :2039، وسطر «فشل …» المرافق له غير مستثنى.)
 * بيانات مصطنعة · وحدات الجهاز مقلَّدة.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import type { DB } from '@/db/adapter';

const opened: { db: DB | null } = { db: null };
jest.mock('react-native', () => ({ Share: { share: jest.fn(async () => ({})) }, Platform: { OS: 'android' } }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('@/ui/AppDialog', () => ({ showDialog: jest.fn() }));
jest.mock('@/ui/Toast', () => ({ showToast: jest.fn() }));
jest.mock('@/services/errorReport', () => ({ errorReportText: () => 'تقرير', saveErrorReport: async () => '' }));
jest.mock('@/db/expoAdapter', () => ({ openedAppDb: () => opened.db }));

import { reportFailure } from '@/ui/failureDialog';
import { enableSync, syncOnce, syncStatus } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import type { Access } from '@/domain/access/access';

test('H8 · عضوٌ قارئٌ يقع له عطلٌ في شاشةٍ بلا db: يزيد «مرفوض عند الوصول» عنده بسطر «فشل …» لم يكتبه هو', async () => {
  const db = memDb();
  const a: Access = { owner: false, uid: 'U-RO-H', perms: { props: 1, collect: 1 }, allProps: true, props: [] };
  enableSync(db, 'U-RO-H');
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'ORG-H', profile: { name: 'عضو قارئ مصطنع' } })]);
  const r = new MemoryRemote();
  Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, a).doc });
  const dev = getMeta(db, 'device_id')!;
  // ما قبل العطل: طابور الانضمام يُرفع (ويُرفض منه ما يُرفض)
  await syncOnce(db, r, dev);
  const before = syncStatus(db).rejected;
  opened.db = db;
  // كما في الشاشة حرفاً (app/(tabs)/collect.tsx:319): reportFailure({ title: 'تعذّر التسجيل', e }) · عطلٌ غير متوقع
  await reportFailure({ title: 'تعذّر التسجيل', e: new Error('database or disk is full (code 13 SQLITE_FULL)') });
  await syncOnce(db, r, dev);
  const after = syncStatus(db).rejected;
  const why = db.all<{ reason: string; payload: string }>(`SELECT reason, payload FROM sync_rejects ORDER BY id DESC LIMIT 1`)
    .map((x) => x.reason + ' · ' + String((JSON.parse(x.payload) as { d?: { entity_type?: string } }).d?.entity_type ?? ''));
  // eslint-disable-next-line no-console
  console.log('H8 · «مرفوض عند الوصول» قبل العطل:', before, '· بعده:', after, '· آخرها:', why);
  expect(after).toBe(before);
});
