/**
 * المراجعات الخارجية «ثالثاً أ ١» (قرار المالك 2026-10-09) · توسيع رؤية الملف في Storage: العضو لا يضيف رمز عقارٍ أو قسمٍ ليس
 * له حق الكتابة فيه · اختبار سلبي يثبت الرفض وإيجابي يثبت أن الإضافة المشروعة تعمل (القاعدة ٩٨) · بيانات وملفات مصطنعة.
 *   firebase emulators:exec --only firestore,storage --project demo-aqari "npx jest -i tests/storageTokens.emulator.test.ts"
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { encodeFields } from '@/cloud/firestore';
import { memberTokens } from '@/sync/acl';
import { objectName, statObject, uploadObject, addTokens, type StorageTarget } from '@/cloud/storage';
import { nodeStorageIO } from './helpers/nodeStorageIO';

const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const ST_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const BUCKET = 'demo-aqari.appspot.com';
const OWNER = 'ST-OWNER';
const MEMBER = 'ST-MEM';
const d = FS_HOST && ST_HOST ? describe : describe.skip;

function token(uid: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email: uid.toLowerCase() + '@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const target = (uid: string): StorageTarget => ({ base: 'http://' + ST_HOST, bucket: BUCKET, org: OWNER, idToken: async () => token(uid) });

d('توسيع رؤية الملف (ثالثاً أ ١)', () => {
  let name = '';
  const perm = { collect: 2, ledger: 1, claims: 2 } as const;

  beforeAll(async () => {
    await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const res = await fetch(`http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${OWNER}/members/${MEMBER}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(OWNER) },
      body: JSON.stringify({ fields: encodeFields({ email: 'st-mem@example.test', perm, all: false, props: ['P1'],
        tokens: memberTokens({ owner: false, perms: perm, allProps: false, props: ['P1'] }) }) }),
    });
    expect(res.status).toBe(200);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-sttok-'));
    const file = path.join(dir, 'f.bin');
    const bytes = Buffer.from('ملف مصطنع لاختبار الرموز ' + Date.now());
    fs.writeFileSync(file, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    name = objectName(OWNER, sha, 'bin');
    const md5 = createHash('md5').update(bytes).digest('base64');
    await uploadObject(nodeStorageIO, target(OWNER), name, file, { g: ['collect|P1', 'collect|@'], op: null, sha256: sha, md5, contentType: 'application/octet-stream' });
  });

  const add = async (tok: string) => {
    const cur = (await statObject(nodeStorageIO, target(OWNER), name))!;
    try { await addTokens(nodeStorageIO, target(MEMBER), name, cur, [tok]); return 'ok'; } catch { return 'denied'; }
  };

  test('سلبي: رمز عقارٍ آخر، وقسمٍ يقرؤه ولا يكتب فيه، و«@» لقسمٍ ليس له، وقسمٍ غير معروف، و«*»', async () => {
    expect(await add('collect|P2')).toBe('denied');
    expect(await add('ledger|P1')).toBe('denied');
    expect(await add('props|@')).toBe('denied');
    expect(await add('xyz|P1')).toBe('denied');
    expect(await add('claims|*')).toBe('denied');
  });

  test('إيجابي: رمز قسمٍ يكتب فيه في عقاره، و«@» لقسمٍ يكتب فيه (مرفقه في قسمه يحمله)', async () => {
    expect(await add('claims|P1')).toBe('ok');
    expect(await add('claims|@')).toBe('ok');
  });

  // المتحقق المستقل على 1fe4557 · وقرار المالك «أو ربط مرفق حقيقي»: رموز صفّ مرفقٍ لهذا الملف ببصمته
  const adminRow = async (k: string, d: Record<string, unknown>, g: string[], pids: string[]) => {
    const res = await fetch(`http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/orgs/${OWNER}/rows/attachments__${k}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ fields: encodeFields({ t: 'attachments', k, u: '1', dev: 'd', del: false, d: { id: k, ...d }, g, pids }) }),
    });
    expect(res.status).toBe(200);
  };
  const shaOf = (n: string) => n.split('/').pop()!.split('.')[0];
  const addLinked = async (toks: string[], att: string) => {
    const cur = (await statObject(nodeStorageIO, target(OWNER), name))!;
    try { await addTokens(nodeStorageIO, target(MEMBER), name, cur, toks, att); return 'ok'; } catch { return 'denied'; }
  };

  test('بربط مرفقٍ حقيقي: المحصّل يرفق ملف المالك بحركة بنك فيضمّ «banks|P1» · ولا يضمّ ما ليس في صفّ المرفق ولا بمرفق ملفٍ آخر', async () => {
    await adminRow('ATT-BANK', { sha256: shaOf(name), entity_type: 'bank_tx' }, ['banks|@', 'banks|P1', 'collect|@', 'collect|P1'], ['P1']);
    await adminRow('ATT-OTHER', { sha256: 'f'.repeat(64), entity_type: 'bank_tx' }, ['banks|@', 'banks|P1'], ['P1']);
    expect(await add('banks|P1')).toBe('denied');
    expect(await addLinked(['banks|P1', 'banks|@'], 'ATT-OTHER')).toBe('denied');
    expect(await addLinked(['banks|P1', 'ledger|P2'], 'ATT-BANK')).toBe('denied');
    expect(await addLinked(['banks|P1', 'banks|@'], 'ATT-BANK')).toBe('ok');
  });

  test('الجولة ٢ للمتحقق: الربط لا يوسّع ملفاً قائماً إلى «كل العقارات» ولا بأقسامٍ ليست من قرّاء جهته', async () => {
    await adminRow('ATT-FORGED', { sha256: shaOf(name), entity_type: 'bank_tx' }, ['maintenance|P1', 'handover|P1'], ['P1']);
    expect(await addLinked(['maintenance|P1', 'handover|P1'], 'ATT-FORGED')).toBe('denied');
    await adminRow('ATT-WIDE', { sha256: shaOf(name), entity_type: '' }, ['library|*', 'contracts|*'], ['*']);
    expect(await addLinked(['contracts|*'], 'ATT-WIDE')).toBe('denied');
    expect(await addLinked(['library|*'], 'ATT-WIDE')).toBe('denied');
  });

  test('الإنشاء كالإضافة: ملفٌ جديد برموز عقارٍ آخر يُرفض · وبرموز صفّ مرفقه يُقبل', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-sttok2-'));
    const up = async (label: string, g: string[], att?: string) => {
      const file = path.join(dir, label + '.bin');
      const bytes = Buffer.from('ملف مصطنع جديد ' + label + ' ' + Date.now());
      fs.writeFileSync(file, bytes);
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (att) await adminRow(att, { sha256: sha, entity_type: att.startsWith('ATT-LIB') ? '' : 'payment' }, g, att.startsWith('ATT-LIB') ? ['*'] : ['P1']);
      try {
        await uploadObject(nodeStorageIO, target(MEMBER), objectName(OWNER, sha, 'bin'), file,
          { g, op: 'collect', sha256: sha, md5: createHash('md5').update(bytes).digest('base64'), contentType: 'application/octet-stream', ...(att ? { att } : {}) });
        return 'ok';
      } catch { return 'denied'; }
    };
    expect(await up('forged', ['collect|P1', 'ledger|P2', 'banks|P2', 'reports|@'])).toBe('denied');
    expect(await up('wide', ['collect|*'])).toBe('denied');
    expect(await up('own', ['collect|P1', 'collect|@'])).toBe('ok');
    expect(await up('linked', ['collect|@', 'collect|P1', 'ledger|@', 'ledger|P1', 'reports|@', 'reports|P1'], 'ATT-NEW1')).toBe('ok');
    // الجولة ٢ للمتحقق: صفّ المرفق يكتبه العضو فلا يسوّغ وحده · أقسامٌ ليست من قرّاء الدفعة، وعقارٌ آخر، و«*» لغير ملف مكتبة
    expect(await up('sections', ['maintenance|P1', 'handover|P1', 'collect|P1'], 'ATT-NEW2')).toBe('denied');
    expect(await up('otherprop', ['ledger|P2', 'collect|P1'], 'ATT-NEW3')).toBe('denied');
    expect(await up('widepay', ['collect|*', 'ledger|*'], 'ATT-NEW4')).toBe('denied');
    expect(await up('widelib', ['contracts|*', 'library|*'], 'ATT-LIB1')).toBe('denied');
    // وملف مكتبةٍ جديد برموز المكتبة يُقبل
    expect(await up('library', ['library|*', 'library|@'], 'ATT-LIB2')).toBe('ok');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
