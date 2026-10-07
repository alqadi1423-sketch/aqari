/**
 * قواعد الأمان على محاكي Firestore الرسمي · بعميل REST الذي يستعمله التطبيق نفسه.
 * يعمل حين يكون المحاكي قائماً (FIRESTORE_EMULATOR_HOST) ويُتخطّى غير ذلك، فحزمة الاختبار
 * العادية لا تحتاج شبكة. تشغيله:
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest tests/firestoreRules.emulator.test.ts"
 */
import { FirestoreRemote, docToFields } from '@/cloud/firestore';
import type { RemoteDoc } from '@/sync/types';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const d = HOST ? describe : describe.skip;

/** رمز Firebase غير موقَّع كما يقبله المحاكي · فيه uid صاحبه */
function token(uid: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const client = (uid: string, asUid = uid) =>
  new FirestoreRemote({ projectId: PROJECT, uid, idToken: async () => token(asUid), baseUrl: 'http://' + HOST });

const entry = (status: string, extra: Record<string, unknown> = {}): RemoteDoc => ({
  id: 'journal_entries__E1', t: 'journal_entries', k: 'E1', u: '2026-10-01T10:00:00.000Z', dev: 'devA', del: false,
  d: { id: 'E1', no: 'JE-0001', date: '2026-10-01', memo: 'الأصل', status, reversed_by: null, ...extra },
  lines: [
    { id: 'L1', entry_id: 'E1', account_code: '1100', debit_halalas: 1000, credit_halalas: 0 },
    { id: 'L2', entry_id: 'E1', account_code: '4200', debit_halalas: 0, credit_halalas: 1000 },
  ],
});

d('قواعد Firestore · users/{uid}', () => {
  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  });

  test('صاحب الحساب يكتب ويقرأ صفوفه · والمبالغ تعود أعداداً صحيحة', async () => {
    const a = client('U1');
    const doc: RemoteDoc = { id: 'contract_payments__P1', t: 'contract_payments', k: 'P1', u: 'x', dev: 'devA', del: false,
      d: { id: 'P1', gross_halalas: 248000, discount_halalas: 22000, net_halalas: 226000 } };
    expect(await a.write([doc])).toEqual([{ ok: true, code: 'OK', message: undefined }]);
    const { docs } = await a.pull(null, 50);
    const got = docs.find((x) => x.id === 'contract_payments__P1')!;
    expect(got.d).toEqual(doc.d);
    expect(Number.isInteger(got.d!.net_halalas)).toBe(true);
    expect(got.ts).toBeTruthy(); // وقت الخادم
  });

  test('لا قراءة ولا كتابة إلا لصاحب uid', async () => {
    const intruder = client('U1', 'U2');   // يحمل رمز U2 ويطلب مسار U1
    const w = await intruder.write([{ id: 'tenants__T1', t: 'tenants', k: 'T1', u: 'x', dev: 'd', del: false, d: { id: 'T1' } }]);
    expect(w[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    await expect(intruder.pull(null, 10)).rejects.toThrow(/403|PERMISSION_DENIED/);
    // بلا دخول أصلاً: طلب بلا رمز
    const anon = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users/U1:runQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'rows' }] } }),
    });
    expect(anon.status).toBe(403);
  });

  test('القيد المرحّل: إنشاء نعم · تعديل لا · ربط القيد العكسي مرة واحدة فقط', async () => {
    const a = client('U1');
    expect((await a.write([entry('مرحّل')]))[0].ok).toBe(true);
    const edit = entry('مرحّل', { memo: 'معدَّل' });
    expect((await a.write([edit]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    const lines = entry('مرحّل');
    lines.lines![0].debit_halalas = 9999;
    expect((await a.write([lines]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect((await a.write([entry('مرحّل', { reversed_by: 'E2' })]))[0].ok).toBe(true);
    expect((await a.write([entry('مرحّل', { reversed_by: 'E3' })]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('قيد مرحّل بلا حقل reversed_by أصلاً: ربط قيده العكسي يُقبل مرة واحدة · وما سواه يُرفض', async () => {
    const a = client('U1');
    const bare = entry('مرحّل');
    bare.id = 'journal_entries__E5'; bare.k = 'E5';
    const withoutField: Record<string, unknown> = { ...bare.d!, id: 'E5' };
    delete withoutField.reversed_by;
    bare.d = withoutField as typeof bare.d;
    expect('reversed_by' in withoutField).toBe(false);
    expect((await a.write([bare]))[0].ok).toBe(true);
    // تعديل البيان على القيد نفسه يبقى مرفوضاً
    expect((await a.write([{ ...bare, d: { ...withoutField, memo: 'معدَّل' } as typeof bare.d }]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // الربط الأول يُقبل · والثاني يُرفض
    expect((await a.write([{ ...bare, d: { ...withoutField, reversed_by: 'E6' } as typeof bare.d }]))[0].ok).toBe(true);
    expect((await a.write([{ ...bare, d: { ...withoutField, reversed_by: 'E7' } as typeof bare.d }]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('سطور القيد لا صفوف مستقلة لها: rows/journal_lines__* مرفوض · وجدول خارج المزامنة مرفوض · وlines على غير قيد مرفوض', async () => {
    const a = client('U1');
    const line: RemoteDoc = { id: 'journal_lines__L1', t: 'journal_lines', k: 'L1', u: 'x', dev: 'd', del: false,
      d: { id: 'L1', entry_id: 'E1', account_code: '1100', debit_halalas: 9999, credit_halalas: 0 } };
    expect((await a.write([line]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    const other: RemoteDoc = { id: 'settings__k', t: 'settings', k: 'k', u: 'x', dev: 'd', del: false, d: { k: 'k', v: '1' } };
    expect((await a.write([other]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    const smuggled: RemoteDoc = { id: 'tenants__T7', t: 'tenants', k: 'T7', u: 'x', dev: 'd', del: false, d: { id: 'T7' },
      lines: [{ id: 'L9', entry_id: 'E1', account_code: '1100', debit_halalas: 1, credit_halalas: 0 }] };
    expect((await a.write([smuggled]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    // وما سبق كله لا يمسّ الجداول المزامَنة
    expect((await a.write([{ ...smuggled, lines: undefined }]))[0].ok).toBe(true);
  });

  test('المسودة تُعدَّل · ولا حذف لأي صف · وسجل العمليات لا يُعدَّل', async () => {
    const a = client('U1');
    const draft = { ...entry('قيد الإنشاء'), id: 'journal_entries__E9', k: 'E9' };
    draft.d = { ...draft.d!, id: 'E9' };
    expect((await a.write([draft]))[0].ok).toBe(true);
    expect((await a.write([{ ...draft, d: { ...draft.d!, memo: 'تعديل مسودة' } }]))[0].ok).toBe(true);
    const del = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users/U1/rows/journal_entries__E9`,
      { method: 'DELETE', headers: { Authorization: 'Bearer ' + token('U1') } });
    expect(del.status).toBe(403);
    const log: RemoteDoc = { id: 'audit_log__A1', t: 'audit_log', k: 'A1', u: 'x', dev: 'd', del: false, d: { id: 'A1', entity_name: 'أ' } };
    expect((await a.write([log]))[0].ok).toBe(true);
    expect((await a.write([{ ...log, d: { id: 'A1', entity_name: 'ب' } }]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('مبلغ بالهللات غير صحيح · أو معرّف لا يطابق الجدول والمفتاح: مرفوض', async () => {
    const a = client('U1');
    const frac: RemoteDoc = { id: 'contract_payments__P2', t: 'contract_payments', k: 'P2', u: 'x', dev: 'd', del: false,
      d: { id: 'P2', net_halalas: 2260.5 } };
    expect((await a.write([frac]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    const wrongId: RemoteDoc = { id: 'tenants__X', t: 'tenants', k: 'Y', u: 'x', dev: 'd', del: false, d: { id: 'Y' } };
    expect((await a.write([wrongId]))[0]).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(Object.keys(docToFields(frac))).toEqual(['t', 'k', 'd', 'u', 'dev', 'del']);
  });

  test('من طرف إلى طرف: جهازان يتزامنان عبر المحاكي · وتعديل المرحّل يُعزل ولا يحبس الطابور', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract, recordRentPayment } = await import('@/domain/contracts/service');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    const { getMeta } = await import('@/repos/settings');
    const a = memDb(); const b = memDb();
    enableSync(a, 'U9'); enableSync(b, 'U9');
    const p = addProperty(a); const u = addUnit(a, p, { rent: 248000 });
    const cid = confirmContract(a, contractInput(u, { tenant: 'رهف التجريبية', valueHalalas: 248000 * 12, depositHalalas: 0, idNumber: '1022222222' }));
    const inst = a.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
    recordRentPayment(a, cid, { installmentId: inst, period: 'يناير', date: '2026-01-05', discountHalalas: 22000, notes: '',
      discountKind: 'بعد الاستحقاق', lines: [{ method: 'cash', amountHalalas: 226000 }] });
    const ra = client('U9'); const rb = client('U9');
    await syncOnce(a, ra, getMeta(a, 'device_id')!);
    // عبث بقيد مرحّل في أ ثم تعديل عادي · الأول يُرفض في السحابة والثاني يمرّ في الدفعة نفسها
    const je = a.get<{ id: string }>(`SELECT id FROM journal_entries WHERE status = 'مرحّل' LIMIT 1`)!.id;
    a.run(`UPDATE journal_entries SET memo = 'معدَّل' WHERE id = ?`, [je]);
    a.run(`UPDATE tenants SET phone = '0599999999'`);
    const rep = await syncOnce(a, ra, getMeta(a, 'device_id')!);
    expect(rep.pending).toBe(0);
    await syncOnce(b, rb, getMeta(b, 'device_id')!);
    expect(b.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = ?`, [inst])!.p).toBe(226000);
    expect(b.get<{ p: string }>(`SELECT phone AS p FROM tenants`)!.p).toBe('0599999999');
    expect(b.get<{ m: string }>(`SELECT memo AS m FROM journal_entries WHERE id = ?`, [je])!.m).not.toBe('معدَّل');
    a.close(); b.close();
  });

  test('السحب بعد المؤشر يعيد ما كُتب بعده فقط وبالترتيب', async () => {
    const a = client('U3');
    await a.write([{ id: 'tenants__A', t: 'tenants', k: 'A', u: 'x', dev: 'd', del: false, d: { id: 'A' } }]);
    const first = await a.pull(null, 10);
    await a.write([{ id: 'tenants__B', t: 'tenants', k: 'B', u: 'x', dev: 'd', del: false, d: { id: 'B' } }]);
    const next = await a.pull(first.next, 10);
    expect(next.docs.map((x) => x.id)).toEqual(['tenants__B']);
  });
  test('«حذف حسابي»: الحذف ممنوع بلا طلب · والطلب بوقت الخادم يفتح ساعةً يحذف فيها صاحبه كل شيء ولا يفتحها غيره', async () => {
    const owner = client('DEL1');
    await owner.write([entry('مرحّل'), { id: 'audit_log__AX', t: 'audit_log', k: 'AX', u: 'x', dev: 'd', del: false, d: { id: 'AX', entity_name: 'أ' } }]);
    await owner.reserveBlocks([{ series: 'JE', size: 10, floor: 0, gap: 0 }]);
    const base = 'http://' + HOST + '/v1/projects/' + PROJECT + '/databases/(default)/documents';
    const commit = (uid: string, asUid: string, writes: unknown[]) => fetch(base + ':commit', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(asUid) },
      body: JSON.stringify({ writes }),
    });
    // بلا طلب: حذف صفٍّ مرفوض
    expect((await commit('DEL1', 'DEL1', [{ delete: 'projects/' + PROJECT + '/databases/(default)/documents/users/DEL1/rows/journal_entries__E1' }])).status).toBe(403);
    // طلبٌ بوقتٍ يكتبه الجهاز (مستقبلاً) مرفوض · وطلبٌ لحساب غيره مرفوض
    const name = (u: string) => 'projects/' + PROJECT + '/databases/(default)/documents/users/' + u + '/meta/deletion';
    expect((await commit('DEL1', 'DEL1', [{ update: { name: name('DEL1'), fields: { at: { timestampValue: '2099-01-01T00:00:00Z' } } } }])).status).toBe(403);
    expect((await commit('DEL1', 'INTRUDER', [{ update: { name: name('DEL1'), fields: {} },
      updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }] }])).status).toBe(403);
    // صاحبه يحذف كل شيء: القيد المرحّل وسجل العمليات ومستندات meta
    expect(await owner.deleteAllData()).toBe(2);
    expect((await owner.pull(null, 10)).docs).toEqual([]);
    const meta = await fetch(base + '/users/DEL1/meta', { headers: { Authorization: 'Bearer ' + token('DEL1') } });
    expect(((await meta.json()) as { documents?: unknown[] }).documents ?? []).toEqual([]);
  });
});

d('قواعد Firestore · لغة المستخدم في users/{uid}', () => {
  test('صاحب الحساب يكتب لغته ويقرؤها · وغيره لا يقرؤها ولا يكتبها', async () => {
    const { getCloudLang, putCloudLang } = await import('@/cloud/userPrefs');
    const at = (uid: string, asUid = uid) => ({ projectId: PROJECT, uid, idToken: async () => token(asUid), baseUrl: 'http://' + HOST });
    await putCloudLang(at('L1'), { pref: 'en', at: '2026-01-05T00:00:00.000Z' });
    expect(await getCloudLang(at('L1'))).toEqual({ pref: 'en', at: '2026-01-05T00:00:00.000Z' });
    await expect(getCloudLang(at('L1', 'L2'))).rejects.toThrow(/403/);
    await expect(putCloudLang(at('L1', 'L2'), { pref: 'ar', at: '2026-01-06T00:00:00.000Z' })).rejects.toThrow(/403/);
    expect(await getCloudLang(at('L9'))).toBeNull();
  });
});
