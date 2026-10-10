/**
 * المراجعات الخارجية «ثالثاً أ ١١» (قرار المالك 2026-10-09): «الجهاز الذي عمل محلياً ثم بدأ المزامنة لا ينتج رقماً مكرراً» ·
 * ثبت أن دمج بيانات جهازٍ عمل بلا حساب في منشأةٍ قائمة يكرر أرقام الفواتير والقيود فيرفض كلُّ جهازٍ وارد الآخر، والقيد المرحّل لا
 * يُعاد ترقيمه · فالربط يُرفض لحسابٍ له منشأة (localBindAllowed على المحاكي في invites.emulator)، وزره لا يظهر وسببه ظاهر
 */
import * as fs from 'node:fs';
import { FirestoreRemote } from '@/cloud/firestore';
import { localBindAllowed } from '@/services/org';
import * as path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('الربط يفحص المنشأة القائمة قبل دمج بيانات الجهاز · والزر لا يظهر لصاحب منشأة', () => {
  const cloud = read('src/services/cloud.ts');
  const i = cloud.indexOf('export async function bindUnboundToAccount(');
  expect(i).toBeGreaterThan(-1);
  const fn = cloud.slice(i, cloud.indexOf('\n}\n', i));
  expect(fn.indexOf('localBindAllowed(')).toBeGreaterThan(-1);
  expect(fn.indexOf('localBindAllowed(')).toBeLessThan(fn.indexOf('enableSync('));
  expect(fn.indexOf('claimLocalBind(')).toBeGreaterThan(-1);
  expect(fn.indexOf('claimLocalBind(')).toBeLessThan(fn.indexOf('enableSync('));
  const gate = read('src/ui/AuthGate.tsx');
  expect(gate).toMatch(/cloud\.ownOrg \? <Note>\{t\('bind\.orgHasData'\)\}<\/Note> : \(/);
});

test('خطأ الشبكة أو الخادم لا يُعدّ «لا منشأة» فيفتح الربط (المتحقق المستقل) · والغياب الصريح (404) يفتحه', async () => {
  const r = (impl: typeof fetch) => new FirestoreRemote({ projectId: 'demo-x', uid: 'U-X', idToken: async () => 't', baseUrl: 'http://127.0.0.1:1', fetchImpl: impl });
  const offline = (async () => { throw new TypeError('Network request failed'); }) as unknown as typeof fetch;
  const unavailable = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
  const absent = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
  await expect(localBindAllowed(r(offline), 'U-X', 'dev-a')).rejects.toThrow();
  await expect(localBindAllowed(r(unavailable), 'U-X', 'dev-a')).rejects.toThrow();
  expect(await localBindAllowed(r(absent), 'U-X', 'dev-a')).toBe(true);
});
