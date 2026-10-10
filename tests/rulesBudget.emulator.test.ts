/**
 * اختبار ميزانية القواعد (قرار المالك 2026-10-10: «لكل نوع كتابة عضو شائعة… يفشل إن تجاوز ٨٥٪ من الحد») على محاكي Firestore ·
 * بيانات مصطنعة.
 *
 * القواعد تقيّم الطلب الواحد بألف تعبيرٍ على الأكثر، وطلب commit يمرّ بتقييمٍ تُستدعى فيه حتى دوال الفروع المتروكة، فعدّ التغطية
 * لا يقيس النسبة مباشرة. فيُحمَّل على المحاكي نسخةٌ من القواعد في أول فحص كل صف (validOrgRow) حِملٌ يعادل ١٥٪ من الحد،
 * ثم تجري أجهزة الأعضاء عمليات التطبيق نفسها وتزامن: إن لم يُرفض شيء فكل كتابةٍ دون ٨٥٪ من الحد.
 * المعايرة (المحاكي 2026-10-10): الحد يقابل نحو ١٨٥ مقارنةً في دوالٍ من عشر (١٨٠ تُقبل و١٩٠ تُرفض)، فالحِمل ٢٨ مقارنة.
 * BUDGET_PAD_TERMS يغيّر الحِمل لقياس هامش كل قسم في التقرير (٢٨ ≈ ١٥٪، ٤٦ ≈ ٢٥٪، ٦٥ ≈ ٣٥٪، ٨٣ ≈ ٤٥٪).
 *   firebase emulators:exec --only firestore,storage --project demo-aqari "npx jest -i tests/rulesBudget.emulator.test.ts"
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FirestoreRemote } from '@/cloud/firestore';
import type { DB } from '@/db/adapter';
import { memberTokens, fullReadTables } from '@/sync/acl';
import { SYNC_TABLES } from '@/db/syncTables';
import { readAccess, readMembership, saveMembership, type Membership } from '@/services/access';
import { sendInvite, findInvites, acceptInvite } from '@/services/org';
import { putAttachment } from '@/files/store';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import type { Perms } from '@/domain/access/sections';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const OWNER = 'BUDGET-OWNER';
const OWNER_EMAIL = 'budget-owner@example.test';
const d = HOST ? describe : describe.skip;
const PAD_TERMS = Number(process.env.BUDGET_PAD_TERMS ?? 28);

function token(uid: string, email: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const base = (uid: string, email: string) => ({ projectId: PROJECT, uid, idToken: async () => token(uid, email), baseUrl: 'http://' + HOST });
const tables = SYNC_TABLES.map((t) => t.name);
const denials: string[] = [];
const capture = (async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init);
  if (res.status === 403 && String(url).endsWith(':commit')) {
    const text = await res.clone().text();
    denials.push(text.includes('1000 expressions') ? 'LIMIT' : 'LOGIC ' + text.slice(0, 200));
  }
  return res;
}) as typeof fetch;
function deviceRemote(db: DB, uid: string, email: string): FirestoreRemote {
  const m = readMembership(db);
  if (m) {
    return new FirestoreRemote({ ...base(uid, email), org: m.org, fetchImpl: capture,
      memberTokens: () => memberTokens(readAccess(db)), fullReadTables: () => fullReadTables(readAccess(db), tables), access: () => readAccess(db) });
  }
  return new FirestoreRemote({ ...base(uid, email), org: uid, access: () => readAccess(db) });
}

/** القواعد كما في المستودع، وفي أول فحص كل صف حِملٌ بعدد PAD_TERMS من المقارنات (دوالٌ من عشر كالمعايرة) */
export function paddedRules(src: string, terms: number): string {
  if (terms <= 0) return src;
  const fns: string[] = [];
  const calls: string[] = [];
  for (let i = 0; i * 10 < terms; i++) {
    const n = Math.min(10, terms - i * 10);
    fns.push(`    function budgetPad${i}(x) {\n      return ${Array.from({ length: n }, (_, j) => `x == ${900000 + i * 100 + j}`).join(' || ')};\n    }`);
    calls.push(`budgetPad${i}(x)`);
  }
  const pad = `${fns.join('\n')}\n    function budgetPad(x) {\n      return ${calls.join(' || ')} || x == -1;\n    }\n`;
  const anchor = '    function validOrgRow(rowId) {\n      let r = request.resource.data;\n      return ';
  if (!src.includes(anchor)) throw new Error('validOrgRow anchor');
  return src.replace(anchor, () => pad + anchor + 'budgetPad(-1) && ');
}
async function putRules(content: string): Promise<void> {
  const res = await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('rules ' + res.status + ' ' + text.slice(0, 300));
}

/** BUDGET_COV=1: فرق التغطية لكل دالة حول مزامنة القسم (للتشخيص وحده) */
async function coverageByFn(): Promise<Map<string, number>> {
  const j = (await (await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}:ruleCoverage`)).json()) as {
    rules: { files: Array<{ content: string }> }; report?: Record<string, unknown> };
  const src = j.rules.files[0].content.split('\n');
  const fnAt = (l: number) => { for (let i = l - 1; i >= 0; i--) { const m = /function\s+(\w+)\(/.exec(src[i]); if (m) return m[1]; } return '?'; };
  const out = new Map<string, number>();
  type N = { sourcePosition: { line: number }; values?: Array<{ count: number }>; children?: N[] };
  const walk = (n: N) => {
    const c = (n.values ?? []).reduce((x, v) => x + v.count, 0);
    if (c) { const f = fnAt(n.sourcePosition.line); out.set(f, (out.get(f) ?? 0) + c); }
    (n.children ?? []).forEach(walk);
  };
  for (const v of Object.values(j.report ?? {})) walk(v as N);
  return out;
}
const covDiffs: Record<string, Array<[string, number]>> = {};

const dirs: string[] = [];
const newEnv = (): TestBackupEnv => { const dir = tempDir('aq-budget-'); dirs.push(dir); fs.mkdirSync(dir, { recursive: true }); return makeBackupEnv(dir); };
const fe = (e: TestBackupEnv) => ({ db: e.db, fs: e.fs, hasher: e.hasher!, attachmentsDir: e.attachmentsDir });
const bytesOf = (seed: number, n = 4_000) => new Uint8Array(n).map((_, k) => (k * 17 + seed * 13) % 251);

d('ميزانية القواعد: كتابات الأعضاء الشائعة تحت ٨٥٪ من حدّ الألف تعبير', () => {
  const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  let owner: TestBackupEnv;
  let C1 = ''; let U1 = '';
  const results: Array<{ section: string; pushed: number; rejected: number; reasons: string[]; denials: string[] }> = [];

  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    await putRules(paddedRules(RULES, PAD_TERMS));
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const { enableSync, syncOnce, setFilesSync } = await import('@/sync/engine');
    owner = newEnv();
    addProperty(owner.db, { id: 'BP1', name: 'عقار الميزانية الأول' });
    addProperty(owner.db, { id: 'BP2', name: 'عقار الميزانية الثاني' });
    U1 = addUnit(owner.db, 'BP1', { unit_no: 'B-1' });
    // وحدةٌ شاغرة يعقد عليها عضو العقود
    addUnit(owner.db, 'BP1', { id: 'BU-FREE', unit_no: 'B-7' });
    C1 = confirmContract(owner.db, contractInput(U1, { tenant: 'مستأجر ميزانية أول', idNumber: '1000008001', phone: '0500008001' }));
    confirmContract(owner.db, contractInput(addUnit(owner.db, 'BP2', { unit_no: 'B-2' }), { tenant: 'مستأجر ميزانية ثانٍ', idNumber: '1000008002', phone: '0500008002' }));
    enableSync(owner.db, OWNER);
    owner.db.run(`INSERT INTO sync_state (k, v) VALUES ('org', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [OWNER]);
    setFilesSync(owner.db, true);
    const r = await syncOnce(owner.db, deviceRemote(owner.db, OWNER, OWNER_EMAIL), 'dev-owner-b');
    expect(r.rejected).toBe(0);
    expect(r.pending).toBe(0);
  }, 120_000);

  afterAll(async () => {
    // القواعد كما هي لبقية ملفات المحاكي
    await putRules(RULES);
    for (const x of dirs) rmrf(x);
    // جدول الهوامش في المخرَج للتقرير
    console.log('BUDGET ' + JSON.stringify({ padTerms: PAD_TERMS, results }));
    if (process.env.BUDGET_COV) fs.writeFileSync(process.env.BUDGET_COV, JSON.stringify(covDiffs));
  });

  /** عضوٌ بجهازٍ حقيقي: دعوة، قبول، سحب، ثم عملياته، ثم مزامنة لا يُرفض فيها شيء */
  async function asMember(section: string, perms: Perms, props: string[] | 'all', work: (env: TestBackupEnv) => Promise<void> | void): Promise<void> {
    const { setSyncState, setCapture, syncOnce, setFilesSync } = await import('@/sync/engine');
    const uid = 'B-' + section.toUpperCase();
    const email = uid.toLowerCase() + '@example.test';
    const orgR = new FirestoreRemote({ ...base(OWNER, OWNER_EMAIL), org: OWNER });
    await sendInvite(orgR, OWNER, { email, perms, allProps: props === 'all', props: props === 'all' ? [] : props }, 'منشأة الميزانية', OWNER_EMAIL);
    const env = newEnv();
    const plain = new FirestoreRemote(base(uid, email));
    const inv = await findInvites(plain, email);
    const m: Membership = await acceptInvite(env.db, plain, OWNER, uid, inv[0].doc);
    saveMembership(env.db, m);
    setSyncState(env.db, 'org', m.org);
    setSyncState(env.db, 'uid', uid);
    setSyncState(env.db, 'cursor', null);
    env.db.run(`DELETE FROM sync_outbox`);
    setCapture(env.db, true);
    setFilesSync(env.db, true);
    await syncOnce(env.db, deviceRemote(env.db, uid, email), 'dev-' + uid);
    denials.length = 0;
    await work(env);
    const cov0 = process.env.BUDGET_COV ? await coverageByFn() : null;
    const r = await syncOnce(env.db, deviceRemote(env.db, uid, email), 'dev-' + uid);
    if (cov0) {
      const cov1 = await coverageByFn();
      covDiffs[section] = [...cov1].map(([f, c]): [string, number] => [f, c - (cov0.get(f) ?? 0)]).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 25);
    }
    const reasons = env.db.all<{ tbl: string; reason: string }>(`SELECT tbl, reason FROM sync_rejects`).map((x) => x.tbl + ': ' + x.reason.slice(0, 160));
    results.push({ section, pushed: r.pushed, rejected: reasons.length, reasons, denials: [...denials] });
    expect({ section, reasons, denials }).toEqual({ section, reasons: [], denials: [] });
    expect(r.pushed).toBeGreaterThan(0);
  }

  test('العقارات: وحدةٌ جديدة وتعديلها ومرفقها', async () => {
    await asMember('props', { props: 3 }, ['BP1'], async (env) => {
      const { addUnit } = await import('./helpers/fixtures');
      const u = addUnit(env.db, 'BP1', { unit_no: 'B-9' });
      env.db.run(`UPDATE units SET floor = '2' WHERE id = ?`, [u]);
      await putAttachment(fe(env), bytesOf(1), { entityType: 'unit', entityId: u, kind: 'صورة', originalName: 'وحدة.jpg', mime: 'image/jpeg' });
    });
  });

  test('العقود: عقدٌ جديد بمستأجرٍ جديد وتأمينه ومرفقه', async () => {
    await asMember('contracts', { contracts: 3, props: 1, tenants: 2 }, ['BP1'], async (env) => {
      const { contractInput } = await import('./helpers/fixtures');
      const { confirmContract } = await import('@/domain/contracts/service');
      const c = confirmContract(env.db, contractInput('BU-FREE', { tenant: 'مستأجر عضو العقود', idNumber: '1000008011', phone: '0500008011', depositHalalas: 50000 }));
      await putAttachment(fe(env), bytesOf(2), { entityType: 'contract', entityId: c, kind: 'عقد', originalName: 'عقد.pdf', mime: 'application/pdf' });
    });
  });

  test('التحصيل: دفعة إيجار وقيدها وسندها', async () => {
    await asMember('collect', { collect: 2, contracts: 1, props: 1 }, ['BP1'], async (env) => {
      const { recordRentPayment } = await import('@/domain/contracts/service');
      const inst = env.db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [C1])!.id;
      const pay = recordRentPayment(env.db, C1, { installmentId: inst, period: 'الأولى', date: '2026-01-06', lines: [{ method: 'cash', amountHalalas: 1000 }], discountHalalas: 0, notes: '' });
      await putAttachment(fe(env), bytesOf(3), { entityType: 'payment', entityId: pay, kind: 'سند', originalName: 'سند.jpg', mime: 'image/jpeg' });
    });
  });

  test('المستأجرون: تعديل مستأجر', async () => {
    await asMember('tenants', { tenants: 3, props: 1 }, ['BP1'], async (env) => {
      const t = env.db.get<{ id: string }>(`SELECT id FROM tenants LIMIT 1`)!.id;
      env.db.run(`UPDATE tenants SET phone = '0500008099' WHERE id = ?`, [t]);
    });
  });

  test('الصيانة: الوحدة تحت الصيانة', async () => {
    await asMember('maintenance', { maintenance: 2, props: 1 }, ['BP1'], (env) => {
      env.db.run(`UPDATE units SET under_maintenance = 1 WHERE id = ?`, [U1]);
    });
  });

  test('الاستلام: مرفق العقد', async () => {
    await asMember('handover', { handover: 2, contracts: 1, props: 1 }, ['BP1'], async (env) => {
      await putAttachment(fe(env), bytesOf(4), { entityType: 'contract', entityId: C1, kind: 'محضر', originalName: 'محضر.pdf', mime: 'application/pdf' });
    });
  });

  test('المكتبة: ملف مكتبة', async () => {
    await asMember('library', { library: 2 }, ['BP1'], async (env) => {
      await putAttachment(fe(env), bytesOf(5), { entityType: 'library', entityId: '', kind: 'أخرى', originalName: 'دليل.pdf', mime: 'application/pdf' });
    });
  });

  test('الدفتر: قيدٌ يدوي مرحّل', async () => {
    await asMember('ledger', { ledger: 3, props: 1 }, 'all', async (env) => {
      const { postEntry } = await import('@/domain/accounting/post');
      postEntry(env.db, { date: '2026-02-01', memo: 'قيد يدوي مصطنع', lines: [{ account: '1100', debit: 500, credit: 0 }, { account: '3100', debit: 0, credit: 500 }] });
    });
  });
});
