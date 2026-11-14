/**
 * مدقق خارجي M · الجولة السابعة · الافتتاحي على جهاز المالك (engine.ts · applyOne) على 2cf6151 · بيانات مصطنعة.
 * «الرصيد الافتتاحي للبنك يضعه المالك وحده (القاعدة ٩٩): مالٌ بلا قيد» · وافتتاحي الحساب 1100 مالٌ بلا قيدٍ كذلك.
 */
import { walletCashBalance } from '@/domain/accounting/ledger';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';

test('(M7) عضوٌ بمسار «ledger» يرفع افتتاحياً للنقدية 1100: يُطبَّق على جهاز المالك فتظهر في المحفظة نقدٌ بلا قيد', async () => {
  const s = await pair();
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const row = s.owner.get<Record<string, unknown>>(`SELECT * FROM accounts WHERE code = '1100'`)!;
  const before = { owner: walletCashBalance(s.owner), opening: row.opening_halalas };
  // والكتابة تمرّ بقاعدة السحابة (openingKept · المدقق الخارجي O٥): الافتتاحي في نسخة العضو كما في السابقة، فتُرفض
  const w = await s.r.write([{ id: 'accounts__1100', t: 'accounts', k: '1100', d: { ...row, opening_halalas: 1000000 } as never,
    u: new Date().toISOString(), dev: 'dev-m7', del: false, by: MEMBER, op: 'ledger' } as RemoteDoc]);
  expect(w[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  await ownerPulls(s.owner, s.r);
  const out = { before, owner: walletCashBalance(s.owner),
    opening: s.owner.get<{ o: number }>(`SELECT opening_halalas AS o FROM accounts WHERE code = '1100'`)!.o,
    rejects: s.owner.all<{ reason: string }>(`SELECT reason FROM sync_rejects`).map((r) => r.reason) };
  // eslint-disable-next-line no-console
  console.log('M7', JSON.stringify(out));
  expect(out.owner).toBe(before.owner);
  s.close();
});
