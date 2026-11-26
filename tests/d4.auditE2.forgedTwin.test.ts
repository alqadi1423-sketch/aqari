/**
 * المدقق E2 · الجولة السادسة عشرة · على 50556c3 · عضوٌ بـ«البنوك ٢» (يقرأ كشفاً ويحفظ سطوره، ولا يطابق) يُنشئ «توأماً» لسطر إيداعٍ مفتوح
 * ببصمته نفسها ووقت إنشاءٍ أقدم وبيانٍ يسمّي مستأجراً آخر، فيحذف جهاز المالك السطر الحقيقي بقاعدة التوأم ويرفع حذفه · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditE2.forgedTwin.test.ts
 *
 * E2-2 · متوسط · src/sync/engine.ts:1022-1032 (statementLineFix: مرور التوأم يرتّب السطور بـ lineRank «المفتوح بعد المطابَق، ثم الأقدم
 * إنشاءً، ثم الأصغر معرّفاً» ويحذف ما لم يُبقِه keepInOrder ويرفعه جهاز المالك تصحيحاً) وengine.ts:1098 (lineRank بـ created_at كما كتبه
 * العضو) مع engine.ts:1390-1403 (FROZEN_COLS: وقائع السطر مجمَّدة عند «تعديل» العضو وحده، والسطر الجديد لا يُفحص) وsrc/domain/access/
 * rulesGen.ts:182-185 (blobShapeOk: سطر الكشف الجديد ممن له البنوك ٢ مفتوحٌ بلا حركة، ولا شيء عن بصمته أو وقت إنشائه):
 * المالك يقرأ كشف أكتوبر وفيه حوالة ماجد (1,000) فيُقترح لها قسط ماجد «جاهزاً» (الاسم في البيان) · موظف البنوك (البنوك ٢) يكتب سطراً
 * جديداً بالبصمة نفسها في كشفٍ يكتبه بتاريخ إنشاءٍ قديم، وبيانه «حوالة واردة سالم المصطنع» · جهاز المالك يقبل الكشف والسطر (إنشاءٌ بلا
 * مطابقة)، ثم يرى سطرين حيّين بالبصمة نفسها فيُبقي «الأقدم إنشاءً» (المزوَّر) ويحذف سطره الحقيقي ويرفع حذفه إلى الأجهزة كلها: الإيداع
 * باقٍ في التقرير بمبلغه فلا فرق يدلّ على شيء، لكن بيانه صار سالماً، واقتراح التحصيل «الجاهز» صار قسط سالم.
 * لماذا يهم: هو أثر B٢-٩ («وقائع السطر من البنك لا يعدّلها عضو») بطريق الإنشاء بدل التعديل، ويكفيه أدنى صلاحية كتابةٍ في الكشف: «اعتماد
 * الجاهزة» يسجّل مال ماجد تحصيلاً لسالم، فيبقى ماجد مطالَباً بما دفع ويُسدَّد قسط سالم بلا مال · وتكراره ممكنٌ لكل إيداعٍ مفتوح.
 * السلوك الصحيح: سطرٌ يكتبه عضوٌ بالبصمة نفسها لسطرٍ يعرفه جهاز المالك لا يُزيحه بوقت إنشاءٍ يكتبه هو: على جهاز المالك يبقى الإيداع
 * بوقائعه كما قُرئت (سطرٌ حيٌّ واحد ببيان ماجد) ويبقى اقتراحه «الجاهز» قسط ماجد · (لا يمسّ X١ وX٢: يبقى سطرٌ واحد لكل بصمة.)
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditC2.mt940Twins.test.ts */
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

test('E2-2 · [متوسط] موظف البنوك ٢ يكتب توأماً أقدم ببيانٍ آخر: على جهاز المالك يبقى إيداع ماجد بوقائعه واقتراحه «الجاهز» قسط ماجد', async () => {
  const ORG = 'owner-e2-2';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع E2-2', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع E2-2' });
  for (const [n, tenant] of [['1', 'ماجد المصطنع'], ['2', 'سالم المصطنع']]) {
    confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'E22-' + n }), {
      tenant, idNumber: '100000320' + n, phone: '050000320' + n, valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
  }
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة ماجد المصطنع', '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(O, bank, g, { name: 'oct-e2-2.csv', hash: 'e2-2-oct' });
  const ready = () => collectionSuggestions(O, bank).filter((s) => s.level === 'ready').map((s) => s.label);
  expect(ready()).toEqual([expect.stringContaining('ماجد المصطنع')]);
  await ownerSync();
  const clerk = memberDevice(r, ORG, 'member-e2-2', { banks: 2 });
  await clerk.sync(); await clerk.sync();

  // الموظف يكتب كشفاً وسطراً بالبصمة نفسها، أقدم إنشاءً، وبيانه يسمّي سالماً (مفتوحٌ بلا حركة: ما يجيزه «البنوك ٢»)
  const L = clerk.db.get<{ key: string }>(`SELECT line_key AS key FROM bank_statement_lines`)!;
  const old = '2020-01-01T00:00:00.000Z';
  clerk.db.run(`INSERT INTO bank_statements (id, bank_id, period_from, period_to, opening_halalas, closing_halalas, file_name, file_hash, line_count, mapping, verified, shared_keys, created_at)
    VALUES ('st_e22_forged', ?, '2026-10-01', '2026-10-31', 0, 100000, 'oct.csv', 'e2-2-forged', 1, '', 1, ?, ?)`, [bank, JSON.stringify([L.key]), old]);
  clerk.db.run(`INSERT INTO bank_statement_lines (id, statement_id, bank_id, line_key, date, value_date, descr, ref, amount_halalas, balance_halalas, created_at)
    VALUES ('sl_e22_forged', 'st_e22_forged', ?, ?, '2026-10-02', NULL, 'حوالة واردة سالم المصطنع', NULL, 100000, 100000, ?)`, [bank, L.key, old]);
  await clerk.sync();
  await ownerSync(); await ownerSync();

  const view = {
    live: O.all<{ d: string; a: number }>(`SELECT descr AS d, amount_halalas AS a FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL`, [bank])
      .map((x) => [x.d, Number(x.a)]),
    ready: ready(),
  };
  // (الواقع: السطر الحيّ الوحيد هو المزوَّر ['حوالة واردة سالم المصطنع', 100000]، والاقتراح «الجاهز» قسط سالم، وحذف السطر الحقيقي مرفوع)
  expect(view).toEqual({ live: [['حوالة واردة ماجد المصطنع', 100000]], ready: [expect.stringContaining('ماجد المصطنع')] });
  O.close(); clerk.db.close();
});
