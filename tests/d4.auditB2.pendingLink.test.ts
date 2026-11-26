/**
 * المدقق B2 · الجولة الرابعة عشرة · على 52f19cb · إلغاء التحصيل من الكشف ثم إعادته على جهاز عضو (المسار الذي بُني له رقم الاعتماد) ·
 * بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditB2.pendingLink.test.ts
 *
 * B2-3 · عالٍ · src/sync/engine.ts:1820-1826 (حارس stmt_line_id يسأل «reversed_by IS NULL» في الجدول وحده) مع engine.ts:459-468
 * (linkReversal: ربطٌ بعاكسٍ لم يُطبَّق بعد يبقى معلَّقاً في PENDING_REV) وsrc/cloud/firestore.ts:278-287 (الرفع كله في التزامٍ واحد بوقت
 * الطلب REQUEST_TIME، فيُسحب بترتيب المعرّف): العضو يعتمد إيداع ماجد لقسط أكتوبر ويرفعه فيطبّقه جهاز المالك (E1) · ثم يتبيّن له أن
 * الدفعة سُجّلت خطأً فيفكّ المطابقة ويلغي الدفعة ويعتمد الإيداع ثانيةً (الاعتماد ٢ بمعرّفاتٍ جديدة · W1 وX3 وZ2-9) ويرفع ذلك كله معاً ·
 * إن سبق معرّفُ القيد الجديد E2 معرّفَ العاكس R1 (نصف الحالات بمعرّفاتٍ حتمية من التجزئة) طُبّق E2 وقيد E1 هنا بلا عاكس بعد (مستنده
 * الوارد يسمّي R1 والربط معلَّق) فيُرفض E2 «تحصيلاً ثانياً» وتسقط حركته، ثم يصل R1 فيُعكس E1 · فلا تحصيل حيّ للإيداع في دفاتر المالك:
 * البنك صفر والكشف 1,000، وقسط أكتوبر غير مسدَّد، والسطر مفتوح · وعلى جهاز العضو تحصيلٌ حيّ (افتراقٌ بلا رجعة: الرفض لا يُعاد).
 * لماذا يهم: «ألغِ ثم اعتمد ثانيةً» مسارٌ يومي صُمّم له رقم الاعتماد، ويضيع به تحصيلٌ حقيقي من دفاتر المالك بلا خطأ من أحد.
 * السلوك الصحيح: قيدٌ عاكسه في الوارد نفسه (أو ربطه معلَّق) ليس «تحصيلاً حيّاً» يحجز السطر: التحصيل الثاني يُقبل، والبنك 1,000،
 * والسطر مطابَقٌ بحركته، والقسط مسدَّد.
 * (المحاكاة: الذاكرة تختم كل مستندٍ بوقتٍ أحدث، فيُكتب R1 آخراً ليُطبَّق بعد E2 كما يرتّبه Firestore حين يصغر معرّف E2.)
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { sync, ownerPulls, MEMBER, UID } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync } from '@/sync/engine';
import { confirmContract } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, unmatchLine } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('B2-3 · [عالٍ] العضو يلغي تحصيلاً من الكشف ويعيده، والقيد الجديد يسبق العاكس في السحب: على جهاز المالك التحصيل الثاني مقبول والبنك 1,000', async () => {
  const r = new MemoryRemote();
  const owner = memDb(); const m = memDb();
  for (const d of [owner, m]) enableSync(d, UID);
  const bank = addBank(owner, 'بنك مصطنع B23', 0);
  const prop = addProperty(owner, { name: 'عقار مصطنع B23' });
  const c = confirmContract(owner, contractInput(addUnit(owner, prop, { unit_no: 'B23-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000003301', phone: '0500003301', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(owner, bank, g, { name: 'b23.csv', hash: 'b23' });
  await sync(owner, r); await sync(m, r); await sync(m, r);
  const dev = getMeta(m, 'device_id');
  const mark = () => { for (const d of [...r.docs.values()]) if (d.dev === dev && d.by !== MEMBER) r.inject({ ...d, by: MEMBER }); };

  // العضو يعتمد الإيداع لقسط أكتوبر ويرفعه، ويطبّقه جهاز المالك
  const s1 = collectionSuggestions(m, bank)[0];
  approveCollection(m, s1.line.id, s1.target);
  await sync(m, r); mark(); await ownerPulls(owner, r);
  const e1 = owner.get<{ id: string }>(`SELECT id FROM journal_entries WHERE stmt_line_id = ?`, [s1.line.id])!.id;
  const p1 = owner.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [c])!.id;

  // ثم يفكّ المطابقة ويلغي الدفعة ويعتمد الإيداع ثانيةً (الاعتماد ٢)، ويرفع ذلك كله معاً
  await wait(5);
  unmatchLine(m, s1.line.id);
  cancelPayment(m, p1, { date: '2026-10-02', reason: 'سُجّلت خطأً (مصطنع)' });
  const s2 = collectionSuggestions(m, bank)[0];
  expect(s2.line.id).toBe(s1.line.id);
  const { txId } = approveCollection(m, s2.line.id, s2.target);
  await sync(m, r);
  const rev = m.get<{ r: string }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [e1])!.r;
  mark();
  // ترتيب Firestore حين يصغر معرّف القيد الجديد: العاكس بعده
  const revDoc = [...r.docs.values()].find((d) => d.t === 'journal_entries' && d.k === rev)!;
  r.inject(revDoc);
  for (let i = 0; i < 3; i++) { await ownerPulls(owner, r); await sync(m, r); mark(); }

  const view = {
    bank: bankBalance(owner, bank),
    line: owner.get<{ status: string; tx: string | null }>(`SELECT status, bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [s1.line.id]),
    e1Reversed: owner.get<{ r: string | null }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [e1])!.r === rev,
    livePayments: Number(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL`, [c])!.n),
  };
  // (الواقع: القيد الثاني مرفوض «تحصيلٌ ثانٍ…» وحركته مرفوضة، والبنك صفر، والسطر مفتوح، ولا دفعة حيّة)
  expect(view).toEqual({ bank: 100000, line: { status: 'matched', tx: txId }, e1Reversed: true, livePayments: 1 });
  owner.close(); m.close();
});
