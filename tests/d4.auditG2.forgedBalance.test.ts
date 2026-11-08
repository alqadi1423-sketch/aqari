/**
 * المدقق G2 · الجولة السابعة عشرة · على 3f2c136 · «وقائع السطر بأول ما قُرئ به على جهاز المالك» (E2-2) تحمي التوأم بالبصمة نفسها وحدها:
 * سطرٌ من عضوٍ بقاعدة الإيداع نفسها ورصيدٍ يكتبه هو يُزيح سطر المالك بلا رصيد (MT940 أو CSV بلا عمود رصيد) ببيانه · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditG2.forgedBalance.test.ts
 *
 * G2-5 · متوسط · src/sync/engine.ts:1050-1058 (statementLineFix: وقائع السطر القائم تُنسخ إلى سطر العضو حين يكون له «local» بالبصمة نفسها
 * «x.k === me.k» وحده) مع src/domain/bankStatement/dedupe.ts:60-80 (keepInOrder: كل ذي رصيدٍ حركةٌ يبقى، و«#n» لا يجاوز عددها يُبقى منه
 * ما يكمل need وحده) وengine.ts:1059-1064 (ما لم يُبقِه يُحذف هنا ويرفعه جهاز المالك تصحيحاً) وsrc/domain/access/rulesGen.ts:182-185
 * (blobShapeOk: سطر الكشف الجديد ممن له البنوك ٢ مفتوحٌ بلا حركة، ولا شيء عن بصمته):
 * المالك يقرأ كشف أكتوبر بلا عمود رصيد وفيه «حوالة واردة ماجد المصطنع» 1,000 يوم 2 أكتوبر (بصمته «#1») فيُقترح له قسط ماجد «جاهزاً»
 * (الاسم في البيان) · موظف البنوك (البنوك ٢) يكتب كشفاً بسطرٍ واحد بالقاعدة نفسها (اليوم والمبلغ) ورصيدٍ يختاره «@100000»، وبيانه «حوالة
 * واردة سالم المصطنع»، بوقت إنشائه الحقيقي (لا أقدم، خلاف E2-2) · جهاز المالك يقبل الكشف والسطر (إنشاءٌ مفتوحٌ بلا حركة)، ثم يرى في
 * القاعدة ذا رصيدٍ و«#1» وأكبر عددٍ في كشفٍ واحد 1، فيُبقي ذا الرصيد (المزوَّر) ويحذف سطره الحقيقي ويرفع حذفه إلى الأجهزة كلها،
 * ولا تُنسخ وقائعه إليه لأن البصمتين مختلفتان · الإيداع باقٍ بمبلغه فلا فرق في التقرير، لكن بيانه صار سالماً واقتراح التحصيل «الجاهز»
 * صار قسط سالم · (والمسار نفسه بلا تزوير: صورة صفحةٍ يقرؤها عضوٌ بلا اتصال، بيانها أرقامٌ وحدها لأن القارئ لا يقرأ العربية، تُزيح سطر
 * المالك ببيانه فيضيع اسم الدافع والاقتراح «الجاهز» · جُرّب.)
 * لماذا يهم: هو E2-2 بطريقٍ لم يغلقه إصلاحه، ولا يحتاج وقت إنشاءٍ مزوَّراً: يكفي رصيدٌ لأي رقمٍ على إيداعٍ من كشف المنشآت (MT940) أو
 * تصديرٍ بلا رصيد · «اعتماد الجاهزة» يسجّل مال ماجد تحصيلاً لسالم، فيبقى ماجد مطالَباً بما دفع ويُسدَّد قسط سالم بلا مال.
 * السلوك الصحيح: سطرٌ جديدٌ من عضوٍ قد يكون الإيداع نفسه لسطرٍ يعرفه جهاز المالك (sameLineKey) لا يُزيح وقائعه: على جهاز المالك يبقى
 * الإيداع ببيان ماجد كما قُرئ، سطراً حيّاً واحداً، ويبقى اقتراحه «الجاهز» قسط ماجد.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementFile } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { lineKeyBase } from '@/domain/bankStatement/dedupe';
import { collectionSuggestions } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditE2.forgedTwin.test.ts */
function memberDevice(r: MemoryRemote, org: string, uid: string, perms: Access['perms']) {
  const M: Access = { owner: false, uid, perms, allProps: true, props: [] };
  const db = memDb();
  enableSync(db, uid);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org, profile: { name: 'موظف مصطنع' } })]);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [org]);
  const sync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(db, r, getMeta(db, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  return { db, sync };
}

test('G2-5 · [متوسط] موظف البنوك ٢ يكتب سطراً برصيدٍ يختاره بقاعدة إيداعٍ بلا رصيد: على جهاز المالك يبقى إيداع ماجد بوقائعه واقتراحه «الجاهز» قسط ماجد', async () => {
  const ORG = 'owner-g2-5';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع G2-5', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع G2-5' });
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'G25-' + n }), {
      tenant, idNumber: '100000450' + n, phone: '050000450' + n, valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
  }
  // كشف أكتوبر بلا عمود رصيد (الافتتاحي والختامي من رأسه): حوالة ماجد بصمتها «#1»
  const st = readStatementFile({ name: 'oct.csv', bytes: new TextEncoder().encode([
    'Date,Description,Debit,Credit', '02/10/2026,حوالة واردة ماجد المصطنع,,1000.00'].join('\n')) }, { opening: 0, closing: 100000 });
  if (!st.ok) throw new Error(st.error);
  expect(st.lines.map((l) => [l.descr, l.amount, l.balance])).toEqual([['حوالة واردة ماجد المصطنع', 100000, null]]);
  saveStatement(O, bank, st, { name: 'oct-g2-5.csv', hash: 'g2-5-oct' });
  const ready = () => collectionSuggestions(O, bank).filter((s) => s.level === 'ready').map((s) => s.label);
  expect(ready()).toEqual([expect.stringContaining('ماجد المصطنع')]);
  await ownerSync();
  const clerk = memberDevice(r, ORG, 'member-g2-5', { banks: 2 });
  await clerk.sync(); await clerk.sync();

  // الموظف يكتب كشفاً وسطراً بالقاعدة نفسها ورصيدٍ يختاره، بوقت إنشائه الحقيقي، وبيانه يسمّي سالماً (مفتوحٌ بلا حركة: ما يجيزه «البنوك ٢»)
  const L = clerk.db.get<{ key: string }>(`SELECT line_key AS key FROM bank_statement_lines`)!;
  expect(L.key.endsWith('#1')).toBe(true);
  const forgedKey = lineKeyBase(L.key) + '@100000';
  const now = new Date().toISOString();
  clerk.db.run(`INSERT INTO bank_statements (id, bank_id, period_from, period_to, opening_halalas, closing_halalas, file_name, file_hash, line_count, mapping, verified, shared_keys, created_at)
    VALUES ('st_g25_forged', ?, '2026-10-01', '2026-10-31', 0, 100000, 'oct.csv', 'g2-5-forged', 1, '', 1, ?, ?)`, [bank, JSON.stringify([forgedKey]), now]);
  clerk.db.run(`INSERT INTO bank_statement_lines (id, statement_id, bank_id, line_key, date, value_date, descr, ref, amount_halalas, balance_halalas, created_at)
    VALUES ('sl_g25_forged', 'st_g25_forged', ?, ?, '2026-10-02', NULL, 'حوالة واردة سالم المصطنع', NULL, 100000, 100000, ?)`, [bank, forgedKey, now]);
  await clerk.sync();
  await ownerSync(); await ownerSync();

  const view = {
    live: O.all<{ d: string; a: number }>(`SELECT descr AS d, amount_halalas AS a FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL`, [bank])
      .map((x) => [x.d, Number(x.a)]),
    ready: ready(),
  };
  // (الواقع: السطر الحيّ الوحيد هو المزوَّر ['حوالة واردة سالم المصطنع', 100000]، والاقتراح «الجاهز» قسط سالم، وحذف سطر ماجد مرفوع)
  expect(view).toEqual({ live: [['حوالة واردة ماجد المصطنع', 100000]], ready: [expect.stringContaining('ماجد المصطنع')] });
  O.close(); clerk.db.close();
});
