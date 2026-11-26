/**
 * المدقق E2 · الجولة السادسة عشرة · على 50556c3 · قراءتان مختلفتان للحركة نفسها (كشف PDF وتصدير Excel ببيانٍ أطول · U١٨) تأخذان معرّف السطر
 * نفسه (البنك والبصمة · Y٣)، فيرفض جهاز المالك سطر العضو «وقائعَ معدَّلة» وتسقط معه مطابقته · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditE2.secondExport.test.ts
 *
 * E2-5 · منخفض · src/sync/engine.ts:1390-1404 (collectionRowCheck: «descr» و«ref» من FROZEN_COLS، وصفّ العضو بمعرّف سطرٍ قائمٍ هنا «تعديلٌ»
 * يُرفض كله) مع src/domain/bankStatement/store.ts:56 (معرّف السطر «sl» من البنك والبصمة وحدهما، والبصمة بلا البيان · dedupe.ts:23-25):
 * المالك يقرأ كشف أكتوبر PDF وفيه «حوالة واردة ماجد المصطنع» 1,000 · والمحصِّل (البنوك ٣ والتحصيل ٣) يقرأ على جهازه تصدير Excel للشهر
 * نفسه، وبيانه أطول («… رقم 7731 من بنك مصطنع»)، فالبصمة والمعرّف واحدان · يعتمد الإيداع لقسط ماجد ويرفع · جهاز المالك يقبل القيد والدفعة
 * والحركة، ويرفض صفّ السطر كله لأن بيانه غير بيانه هنا، بسببٍ عن الدفعات («مبالغ الدفعة وروابطها لا تتغير بعد إنشائها») · فالسطر عند
 * المالك مفتوحٌ «في الكشف وحده» وحركة التحصيل «في الدفاتر وحدها»، وعند المحصِّل وفي السحابة مطابَق: الأجهزة مختلفة بلا تعارضٍ يُرى، وفي
 * «المرفوض» عند المالك سطرٌ بسببٍ لا يدلّ عليه.
 * لماذا يهم: القراءة من صيغتين للفترة نفسها مسارٌ مدعوم (U١٨: «الحركة نفسها بتصديرٍ ببيانٍ أطول بصمتها نفسها»)، وB٢-٩ جمّد الوقائع ضد
 * التزوير لا ضد قراءةٍ ثانية · والمالك يعيد المطابقة يدوياً أو يبقى تقريره خلاف تقرير محصِّله، ويرى رفضاً لا يفهمه.
 * السلوك الصحيح: قراءةٌ أخرى للسطر نفسه لا تُعدّ تعديلاً لوقائعه: يبقى على جهاز المالك بيانه كما قرأه (B٢-٩)، وتُقبل مطابقة المحصِّل،
 * فالسطر مطابَقٌ بحركة التحصيل ولا شيء في «المرفوض» لسطر الكشف.
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
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';

/** جهاز عضوٍ حقيقي (عضويةٌ على جهازه، وكتابته بكاتبه) كما في tests/d4.auditC2.mt940Twins.test.ts */
function memberDevice(r: MemoryRemote, org: string, uid: string, perms: Access['perms']) {
  const M: Access = { owner: false, uid, perms, allProps: true, props: [] };
  const db = memDb();
  enableSync(db, uid);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org, profile: { name: 'محصّل مصطنع' } })]);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', ?)`, [org]);
  const sync = async () => {
    Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, M).doc });
    try { return await syncOnce(db, r, getMeta(db, 'device_id')!); }
    finally { delete (r as { memberMode?: boolean }).memberMode; delete (r as { annotate?: unknown }).annotate; }
  };
  return { db, sync };
}

const oct = (descr: string) => {
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', descr, '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  return g;
};

test('E2-5 · [منخفض] المالك يقرأ PDF والمحصِّل تصدير Excel ببيانٍ أطول ويعتمد الإيداع: على جهاز المالك السطر مطابَقٌ ولا رفض لسطر الكشف', async () => {
  const ORG = 'owner-e2-5';
  const r = new MemoryRemote();
  const O = memDb();
  enableSync(O, ORG);
  const ownerSync = () => syncOnce(O, r, getMeta(O, 'device_id')!);
  const bank = addBank(O, 'بنك مصطنع E2-5', 0);
  const prop = addProperty(O, { name: 'عقار مصطنع E2-5' });
  confirmContract(O, contractInput(addUnit(O, prop, { unit_no: 'E25-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000003501', phone: '0500003501', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  await ownerSync();
  const collector = memberDevice(r, ORG, 'member-e2-5', { banks: 3, collect: 3 });
  await collector.sync(); await collector.sync();

  saveStatement(O, bank, oct('حوالة واردة ماجد المصطنع'), { name: 'oct-e2-5.pdf', hash: 'e2-5-pdf' });
  saveStatement(collector.db, bank, oct('حوالة واردة ماجد المصطنع رقم 7731 من بنك مصطنع'), { name: 'oct-e2-5.xlsx', hash: 'e2-5-xlsx' });
  // البصمة نفسها فالمعرّف نفسه على الجهازين
  const id = O.get<{ id: string }>(`SELECT id FROM bank_statement_lines`)!.id;
  expect(collector.db.get<{ id: string }>(`SELECT id FROM bank_statement_lines`)!.id).toBe(id);
  const s = collectionSuggestions(collector.db, bank);
  expect(s.map((x) => x.line.id)).toEqual([id]);
  const { txId } = approveCollection(collector.db, id, s[0].target);
  await collector.sync();
  await ownerSync(); await ownerSync();

  const line = O.get<{ status: string; tx: string | null; descr: string }>(`SELECT status, bank_tx_id AS tx, descr FROM bank_statement_lines WHERE id = ?`, [id])!;
  const view = {
    status: line.status,
    onCollectionTx: line.tx === txId,
    descr: line.descr,
    lineRejects: O.all<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE tbl = 'bank_statement_lines'`).map((x) => x.reason),
  };
  // (الواقع: السطر مفتوحٌ بلا حركة، وفي المرفوض «قيد التحصيل مرفوض · مبالغ الدفعة وروابطها لا تتغير بعد إنشائها»)
  expect(view).toEqual({ status: 'matched', onCollectionTx: true, descr: 'حوالة واردة ماجد المصطنع', lineRejects: [] });
  O.close(); collector.db.close();
});
