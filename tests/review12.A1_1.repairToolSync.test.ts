/**
 * المراجعة الشاملة 2026-11-13 · A1-1 (البيانات القائمة) · المزامنة · بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * أداة «عكس الترحيل وتصفير تأمين الجديد» للمالك وحده: عاكس الترحيل وصفّ العقد المصحَّح يُرفعان من جهاز المالك ويُقبلان على جهازه
 * الثاني (الفحص الثالث أخضر هناك أيضاً) · وعضوٌ بإصدارٍ لا يمنعه يعكس الترحيل ويصفّر التأمين بنفسه: جهاز المالك يرفض العاكس ويُبقي
 * تأمين العقد كما في دفاتره (الترحيل حيٌّ عنده) ويعيده إلى السحابة.
 */
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, renewContract, saveDepositSettlement } from '@/domain/contracts/service';
import { getContract } from '@/domain/contracts/rules';
import { postDepositCarry, reverseEntryById } from '@/domain/accounting/post';
import { correctionDate } from '@/domain/vatFilings';
import { accountBalance } from '@/domain/accounting/ledger';
import { ownerCashIn } from '@/domain/cashOps';
import { integrityChecks, DEPOSIT_CHECK_NAME } from '@/domain/accounting/integrity';
import { reverseCarryAfterSettle, carryAfterSettleItems } from '@/domain/contracts/carryRepair';
import { pair, sync, ownerPulls, reasonOf, MEMBER } from './helpers/rederive';
import { t } from '@/i18n';
import type { DB } from '@/db/adapter';

const check3 = (db: DB) => integrityChecks(db).find((x) => x.name === DEPOSIT_CHECK_NAME)!;
const depositOf = (db: DB, id: string) => Number(db.get<{ d: number }>(`SELECT deposit_halalas AS d FROM contracts WHERE id = ?`, [id])!.d);
const carryLive = (db: DB, b: string) => !!db.get(
  `SELECT 1 FROM journal_entries WHERE src_type = 'deposit_carry' AND src_id = ? AND reversed_by IS NULL AND deleted_at IS NULL`, [b]);
const rejects = (db: DB) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects`)!.n);

/** جهاز المالك: عقد (أ) بتأمين ١٬٠٠٠ لدى المكتب سُوّي بردّه، ثم تجديده (ب) بالترحيل القديم · والجهاز الثاني يسحب */
async function badPair() {
  const s = await pair();
  ownerCashIn(s.owner, { amountHalalas: 500000, date: '2026-01-01' });
  const u = addUnit(s.owner, addProperty(s.owner, { name: 'عقار أداة الترحيل بالمزامنة' }), { unit_no: 'TS-1' });
  const a = confirmContract(s.owner, contractInput(u, { tenant: 'مستأجر أداة الترحيل بالمزامنة', idNumber: '1000012111', phone: '0500012111',
    valueHalalas: 600000, start: '2026-01-01', end: '2026-06-30', depositHalalas: 100000 }));
  saveDepositSettlement(s.owner, a, { date: '2026-07-01', deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '' });
  const b = renewContract(s.owner, a, { start: '2026-07-01', end: '2026-09-30', valueHalalas: 300000, cycle: 'شهرية', carryDeposit: false,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  postDepositCarry(s.owner, { fromNo: getContract(s.owner, a)!.contract_no || '', toNo: getContract(s.owner, b)!.contract_no || '', toId: b,
    fromId: a, deposit: 100000, date: correctionDate(s.owner, '2026-07-01') });
  s.owner.run(`UPDATE contracts SET deposit_halalas = deposit_halalas + 100000 WHERE id = ?`, [b]);
  await sync(s.owner, s.r);
  await ownerPulls(s.dev, s.r);
  const carryId = s.owner.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'deposit_carry' AND src_id = ?`, [b])!.id;
  return { ...s, a, b, carryId };
}

test('جهاز المالك يطبّق الأداة فيصل العاكس والتأمين المصحَّح إلى جهازه الثاني', async () => {
  const s = await badPair();
  for (const db of [s.owner, s.dev]) {
    expect([depositOf(db, s.b), carryLive(db, s.b), check3(db).ok]).toEqual([100000, true, false]);
  }
  expect(reverseCarryAfterSettle(s.owner, s.b)).toBe(true);
  await sync(s.owner, s.r);
  await ownerPulls(s.dev, s.r);
  await ownerPulls(s.owner, s.r);
  for (const db of [s.owner, s.dev]) {
    expect([depositOf(db, s.b), carryLive(db, s.b)]).toEqual([0, false]);
    expect([accountBalance(db, '2400'), accountBalance(db, '1100')]).toEqual([0, 500000]);
    expect(check3(db)).toMatchObject({ ok: true, value: '0.00 / 0.00' });
    expect(carryAfterSettleItems(db)).toEqual([]);
    expect(rejects(db)).toBe(0);
  }
  // العاكس نفسه بمعرّفه على الجهازين
  const revOf = (db: DB) => db.get<{ r: string }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [s.carryId])!.r;
  expect(revOf(s.dev)).toBe(revOf(s.owner));
  s.close();
});

test('عضوٌ يعكس الترحيل ويصفّر التأمين بنفسه: جهاز المالك يرفض العاكس ويُبقي التأمين ويعيده', async () => {
  const s = await badPair();
  // جهازٌ بإصدارٍ لا يمنعه (أو مزوَّر): العكس وتصفير التأمين مباشرة
  const rev = reverseEntryById(s.dev, s.carryId, 'عكس ترحيلٍ من عضو')!;
  s.dev.run(`UPDATE contracts SET deposit_halalas = 0 WHERE id = ?`, [s.b]);
  await sync(s.dev, s.r);
  for (const d of [...s.r.docs.values()]) {
    const his = (d.t === 'journal_entries' && (d.k === rev.id || d.k === s.carryId)) || (d.t === 'contracts' && d.k === s.b);
    if (his) s.r.inject({ ...d, by: MEMBER, op: 'contracts' });
  }
  await ownerPulls(s.owner, s.r);
  expect(carryLive(s.owner, s.b)).toBe(true);
  expect(s.owner.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [rev.id])).toBeUndefined();
  expect(reasonOf(s.owner, rev.id)).toContain(t('mirror.carryOwnerOnly', { lng: 'ar' }));
  expect(depositOf(s.owner, s.b)).toBe(100000);
  // والمالك يُصلحه بأداته بعد ذلك
  expect(reverseCarryAfterSettle(s.owner, s.b)).toBe(true);
  expect([depositOf(s.owner, s.b), carryLive(s.owner, s.b), check3(s.owner).ok]).toEqual([0, false, true]);
  // وصفّ العقد بتأمين المالك يعود إلى السحابة
  await sync(s.owner, s.r);
  const doc = [...s.r.docs.values()].find((d) => d.t === 'contracts' && d.k === s.b)!;
  expect(Number(doc.d!.deposit_halalas)).toBe(0);
  s.close();
});

test('عضوٌ يصفّر تأمين المجدَّد وحده والترحيل حيٌّ عند المالك: يبقى تأمين المالك ويُرفع', async () => {
  const s = await badPair();
  s.dev.run(`UPDATE contracts SET deposit_halalas = 0, phone = '0500012112' WHERE id = ?`, [s.b]);
  await sync(s.dev, s.r);
  const d = [...s.r.docs.values()].find((x) => x.t === 'contracts' && x.k === s.b)!;
  s.r.inject({ ...d, by: MEMBER, op: 'contracts' });
  await ownerPulls(s.owner, s.r);
  // بقية الصف تُقبل (الهاتف)، والتأمين كما في دفاتر المالك
  expect(s.owner.get<{ p: string }>(`SELECT phone AS p FROM contracts WHERE id = ?`, [s.b])!.p).toBe('0500012112');
  expect(depositOf(s.owner, s.b)).toBe(100000);
  await sync(s.owner, s.r);
  const back = [...s.r.docs.values()].find((x) => x.t === 'contracts' && x.k === s.b)!;
  expect(Number(back.d!.deposit_halalas)).toBe(100000);
  s.close();
});
