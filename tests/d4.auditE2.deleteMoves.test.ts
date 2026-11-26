/**
 * المدقق E2 · الجولة السادسة عشرة · على 50556c3 · حذف كشفٍ بلا أرصدة (MT940 أو CSV بلا عمود رصيد) ينقل إلى الكشف الآخر كل سطوره بلا رصيد
 * في يومٍ ومبلغٍ للكشف الآخر فيهما سطرٌ برصيده، ولو تخطّى ذاك سطراً واحداً منها · بياناتٌ مصطنعة كلها، وجهازٌ واحد.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditE2.deleteMoves.test.ts
 *
 * E2-3 · متوسط · src/domain/bankStatement/store.ts:333-338 (statementSharing) وstore.ts:353-356 (deleteStatement ينقل ما «تخطّاه» كشفٌ حيٌّ
 * آخر) بشرط src/domain/bankStatement/dedupe.ts:50-51 (SAME_KEY_SQL: «#n» يطابق أي بصمةٍ برصيدٍ في قاعدته أياً كان n) · ونظيره في المزامنة
 * src/sync/engine.ts:1001 و1113-1118 و1142 (sharingStatement): إصلاح V١ («ما يُنقل هو ما تخطّاه الكشف الآخر عند حفظه، والباقي يُحذف مع
 * كشفه») يعدّ «#1» و«#2» كليهما مما تخطّاه كشفٌ فيه بصمةٌ برصيدٍ واحدة لذلك اليوم والمبلغ، وهذا خلاف عدّ الحفظ (freshLines يتخطّى بها
 * سطراً واحداً) وخلاف قاعدة الجولة الخامسة عشرة نفسها («#n» حركةٌ أخرى إن جاوز n عدد ذوات الرصيد · keepInOrder):
 * بنكٌ لم يُكتب آيبانه (فلا يمنع U٢١ كشف حسابٍ آخر) · المستخدم يقرأ خطأً كشف أكتوبر MT940 لحسابٍ آخر للمكتب، وفيه يوم 1 أكتوبر حوالتا
 * إيجارٍ بـ2,500 («#1» و«#2») · ثم يقرأ كشف هذا الحساب بأرصدته، وفيه يوم 1 أكتوبر حوالة ماجد 2,500 وحدها، فيتخطّاها الحفظ لأن «#1»
 * هنا (سطرٌ واحد) · ثم يحذف الكشف الخطأ: تُنقل «#1» و«#2» كلتاهما إلى الكشف الصحيح، فيصير فيه يوم 1 أكتوبر إيداعان بـ5,000 والكشف
 * المطبوع 2,500 · إيداعٌ وهمي مفتوحٌ «في الكشف وحده» يُقترح تحصيلاً، وتقرير أكتوبر بفرقٍ «غير مفسَّر» −2,500.
 * لماذا يهم: هو أثر V١ (السطر الخطأ يبقى بعد حذف كشفه، في الكشف الصحيح) بالصيغة التي تكثر فيها حوالات الإيجار بالمبلغ نفسه أول الشهر،
 * وتحصيل الإيداع الوهمي يسجّل مالاً لم يصل · والمستخدم فعل الصواب: حذف ما قرأه خطأً.
 * السلوك الصحيح: يُنقل ما تخطّاه الكشف الآخر بعدّه (سطرٌ واحد لبصمته الواحدة) ويُحذف الباقي: في الكشف الصحيح بعد الحذف حوالة 2,500
 * واحدة والرسوم، ولا فرق غير مفسَّر · (ويبقى C٢-١(ج) كما هو: «#3» بعد صفحةٍ بحوالتين حوالةٌ ثالثة.)
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementFile, readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, deleteStatement, reconciliation } from '@/domain/bankStatement/store';

test('E2-3 · [متوسط] حذف كشف MT940 لحسابٍ آخر بحوالتين يوم 1 أكتوبر بعد كشف الحساب الصحيح بحوالةٍ واحدة: يبقى في الكشف الصحيح إيداعٌ واحد ولا فرق غير مفسَّر', () => {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع E2-3', 0);
  // كشف حسابٍ آخر (MT940 بلا رصيدٍ لكل حركة): حوالتان بـ2,500 يوم 1 أكتوبر ورسمٌ يوم 15
  const wrong = readStatementFile({ name: 'other.sta', bytes: new TextEncoder().encode([':20:SYNE23', ':25:SA0000000000000000009999', ':60F:C260930SAR0,00',
    ':61:2610011001C2500,00NTRF//A', ':86:TRANSFER NAWAF',
    ':61:2610011001C2500,00NTRF//B', ':86:TRANSFER TURKI',
    ':61:2610151015D300,00NCHG//X', ':86:OTHER FEE',
    ':62F:C261015SAR4700,00'].join('\n')) });
  if (!wrong.ok) throw new Error(wrong.error);
  expect(wrong.lines.map((l) => [l.date, l.amount, l.balance])).toEqual([['2026-10-01', 250000, null], ['2026-10-01', 250000, null], ['2026-10-15', -30000, null]]);
  const W = saveStatement(db, bank, wrong, { name: 'other.sta', hash: 'e2-3-other' });
  // كشف هذا الحساب بأرصدته: حوالة ماجد يوم 1 أكتوبر (يتخطّاها الحفظ: «#1» هنا) والرسوم يوم 9
  const good = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/01', 'حوالة واردة ماجد المصطنع', '', '2,500.00', '2,500.00'],
    ['2026/10/09', 'رسوم مصطنعة', '10.00', '', '2,490.00']]);
  if (!good.ok) throw new Error(good.error);
  expect(saveStatement(db, bank, good, { name: 'oct.csv', hash: 'e2-3-oct' })).toMatchObject({ added: 1, skipped: 1 });
  // المستخدم يحذف ما قرأه خطأً
  deleteStatement(db, W.statementId);

  const live = db.all<{ a: number }>(`SELECT amount_halalas AS a FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY date, rowid`, [bank]).map((x) => Number(x.a));
  // (الواقع: [250000, 250000, -1000] والفرق غير المفسَّر −250,000 هللة)
  expect({ live, unexplained: reconciliation(db, bank, '2026-10').unexplained }).toEqual({ live: [250000, -1000], unexplained: 0 });
  db.close();
});
