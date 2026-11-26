/**
 * ق٠-٦ · الجزء الثاني: خادم الهوية بلا قوقل (server/auth · F §٥.١ ضوابط (أ) وتصميمها · س٦ (أ) وس٥ (أ)) · وحدةٌ خالصة على Node
 * بـWebCrypto وحدها، وتخزينٌ في الذاكرة، وساعة خادمٍ مصطنعة يحرّكها الاختبار · أسماءٌ وأرقامٌ مصطنعة كلها، ولا شيء يُنشر.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import {
  createAuthServer, MemoryAuthStorage, crockford, normalizeCode, sha256Hex,
  ACCESS_TTL_MS, INVITE_TTL_MS, LINK_TTL_MS, CODE_ATTEMPTS, CODE_WINDOW_MS, LOCK_RESET_LIMIT, LOCK_RESET_WINDOW_MS, FRESH_TTL_MS,
  REFRESH_GRACE_MS, INVITE_CODE_LENGTH,
  type AuthServer, type Tokens, type Fail,
} from '../server/auth';

const H = 3_600_000;
const SETUP = 'SETUP-CODE-MASNOO-2026-ABCDEFGH';
const SIGNING = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 255);
const devKey = (n: number) => 'k' + String(n).padStart(3, '0') + '_'.repeat(4) + 'A'.repeat(40);

function world(o: { setupCode?: string } = {}) {
  const clock = { now: 1_790_000_000_000 };
  const storage = new MemoryAuthStorage();
  const srv = createAuthServer({ storage, clock: () => clock.now, signingKey: SIGNING, setupCode: o.setupCode ?? SETUP });
  return { srv, clock, storage };
}
const ok = <T,>(r: T): Exclude<T, Fail> => {
  if ((r as Fail).ok === false) throw new Error('رُفض: ' + JSON.stringify(r));
  return r as Exclude<T, Fail>;
};
async function owner(srv: AuthServer) {
  const r = ok(await srv.bootstrapOwner({ setupCode: SETUP, uid: 'uid-owner-masnoo', name: 'مالك مصطنع', deviceKey: devKey(1), source: 'ip-owner' }));
  return r;
}
async function member(srv: AuthServer, own: Tokens, n = 2, uid = 'uid-member-' + n) {
  const inv = ok(await srv.createInvite(own.accessToken, { uid, name: 'عضو مصطنع ' + n, phone: '0500000' + String(n).padStart(3, '0'), role: 'staff' }));
  return { inv, joined: ok(await srv.redeemInvite({ code: inv.code, deviceKey: devKey(n), source: 'ip-m' + n })) };
}

describe('تأسيس المالك', () => {
  test('رمز التأسيس يُنشئ المالك بمعرّفه القديم ويربط جهازه ويعطي رمز طوارئ يُعرض مرة · ولا يُعاد استعماله', async () => {
    const { srv } = world();
    const r = await owner(srv);
    expect(r.uid).toBe('uid-owner-masnoo');
    expect(r.role).toBe('owner');
    expect(r.emergencyCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(ok(await srv.verifyAccess(r.tokens.accessToken))).toMatchObject({ uid: 'uid-owner-masnoo', deviceId: r.deviceId, role: 'owner' });
    const again = await srv.bootstrapOwner({ setupCode: SETUP, uid: 'uid-thief', name: 'x', deviceKey: devKey(9), source: 'ip-x' });
    expect(again).toMatchObject({ ok: false, status: 409, code: 'owner_exists' });
  });

  test('رمز تأسيسٍ خاطئ يُرفض · وخمس محاولات في الساعة لكل مصدر ثم يُحجب ولو صحّ الرمز', async () => {
    const { srv, clock } = world();
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      expect(await srv.bootstrapOwner({ setupCode: 'WRONG-' + i, uid: 'u', name: 'x', deviceKey: devKey(1), source: 'ip-a' })).toMatchObject({ ok: false, status: 403 });
    }
    const blocked = await srv.bootstrapOwner({ setupCode: SETUP, uid: 'uid-owner-masnoo', name: 'x', deviceKey: devKey(1), source: 'ip-a' });
    expect(blocked).toMatchObject({ ok: false, status: 429, code: 'rate_limited' });
    expect((blocked as Fail).waitMs).toBeGreaterThan(0);
    clock.now += CODE_WINDOW_MS + 1;
    expect((await srv.bootstrapOwner({ setupCode: SETUP, uid: 'uid-owner-masnoo', name: 'x', deviceKey: devKey(1), source: 'ip-a' })).ok).toBe(true);
  });

  test('رمز تأسيسٍ قصيرٌ في الإعداد يُرفض عند البناء · ومفتاح توقيعٍ أقصر من ٣٢ بايتاً', () => {
    expect(() => createAuthServer({ storage: new MemoryAuthStorage(), clock: () => 0, signingKey: SIGNING, setupCode: 'short' })).toThrow();
    expect(() => createAuthServer({ storage: new MemoryAuthStorage(), clock: () => 0, signingKey: new Uint8Array(8), setupCode: SETUP })).toThrow();
  });

  test('استرداد المالك: رمز الطوارئ مرةً واحدة يربط جهازاً جديداً ويعطي رمز طوارئ جديداً · ثم رمز تأسيسٍ جديد من لوحة Cloudflare', async () => {
    const w = world();
    const first = await owner(w.srv);
    const rec = ok(await w.srv.recoverOwner({ code: first.emergencyCode, deviceKey: devKey(5), source: 'ip-new' }));
    expect(rec.uid).toBe('uid-owner-masnoo');
    expect(rec.deviceId).not.toBe(first.deviceId);
    expect(rec.emergencyCode).not.toBe(first.emergencyCode);
    // رمز الطوارئ لا يُستعمل مرتين · ورمز التأسيس المستعمل لا يسترد
    expect(await w.srv.recoverOwner({ code: first.emergencyCode, deviceKey: devKey(6), source: 'ip-new' })).toMatchObject({ ok: false, status: 403 });
    expect(await w.srv.recoverOwner({ code: SETUP, deviceKey: devKey(6), source: 'ip-new' })).toMatchObject({ ok: false, status: 403 });
    // ضاع الجوال ورمز الطوارئ معاً: يضع المالك رمز تأسيسٍ جديداً في إعداد الخادم (المرجع الأخير)
    const srv2 = createAuthServer({ storage: w.storage, clock: () => w.clock.now, signingKey: SIGNING, setupCode: SETUP + '-NEW-2026' });
    const viaSetup = ok(await srv2.recoverOwner({ code: SETUP + '-NEW-2026', deviceKey: devKey(7), source: 'ip-new2' }));
    expect(viaSetup.uid).toBe('uid-owner-masnoo');
    expect(await srv2.recoverOwner({ code: SETUP + '-NEW-2026', deviceKey: devKey(8), source: 'ip-new2' })).toMatchObject({ ok: false, status: 403 });
    // والمالك يُشعَر بكل ذلك
    const kinds = ok(await srv2.listNotifications(viaSetup.tokens.accessToken)).items.map((n) => n.kind);
    expect(kinds.filter((k) => k === 'owner_recovered').length).toBe(2);
  });
});

describe('رمز الدعوة', () => {
  test('١٢ محرفاً كروكفورد (٦٠ بتاً) · يُحفظ بصمته وحدها · يربط جوال العضو بمعرّفه القديم · ويُشعَر المالك', async () => {
    const { srv, storage } = world();
    const own = (await owner(srv)).tokens;
    const { inv, joined } = await member(srv, own, 2, 'uid-firebase-old-2');
    expect(inv.code).toMatch(new RegExp('^[' + crockford + ']{' + INVITE_CODE_LENGTH + '}$'));
    expect(INVITE_CODE_LENGTH * 5).toBe(60);
    expect(inv.expiresAt - (inv.expiresAt - INVITE_TTL_MS)).toBe(72 * H);
    // لا يُحفظ الرمز نفسه في أي مكان، بل بصمته
    const dump = JSON.stringify(storage.dump());
    expect(dump).not.toContain(inv.code);
    expect(dump).toContain(await sha256Hex(inv.code));
    expect(dump).not.toContain(devKey(2));
    expect(joined).toMatchObject({ uid: 'uid-firebase-old-2', role: 'staff' });
    const notes = ok(await srv.listNotifications(own.accessToken)).items;
    expect(notes.some((n) => n.kind === 'new_device' && n.uid === 'uid-firebase-old-2' && n.deviceId === joined.deviceId)).toBe(true);
  });

  test('الكتابة تتسامح في المسافات والشرطات وحالة الحروف والأرقام الهندية · ورمزٌ لاستعمالٍ واحد', async () => {
    const { srv } = world();
    const own = (await owner(srv)).tokens;
    const inv = ok(await srv.createInvite(own.accessToken, { uid: 'uid-m3', name: 'عضو', phone: '0500000003', role: 'staff' }));
    const typed = inv.code.toLowerCase().replace(/(.{4})/g, '$1 ').trim().replace(/ /, '-');
    expect(normalizeCode(typed)).toBe(inv.code);
    ok(await srv.redeemInvite({ code: typed, deviceKey: devKey(3), source: 'ip-1' }));
    expect(await srv.redeemInvite({ code: inv.code, deviceKey: devKey(4), source: 'ip-2' })).toMatchObject({ ok: false, status: 403, code: 'used' });
  });

  test('صلاحيته ٧٢ ساعة بساعة الخادم · وما بعدها يُرفض', async () => {
    const { srv, clock } = world();
    const own = (await owner(srv)).tokens;
    const a = ok(await srv.createInvite(own.accessToken, { uid: 'uid-a', name: 'أ', phone: '0500000010', role: 'staff' }));
    const b = ok(await srv.createInvite(own.accessToken, { uid: 'uid-b', name: 'ب', phone: '0500000011', role: 'staff' }));
    clock.now += INVITE_TTL_MS - 1000;
    ok(await srv.redeemInvite({ code: a.code, deviceKey: devKey(10), source: 'ip-a' }));
    clock.now += 2000;
    // ساعة الخادم تُقرّر · الطلب لا يحمل وقتاً يُصدَّق
    expect(await srv.redeemInvite({ code: b.code, deviceKey: devKey(11), source: 'ip-b' })).toMatchObject({ ok: false, status: 403, code: 'expired' });
  });

  test('القوة الغاشمة: خمس محاولات في الساعة لكل مصدر ثم يُحجب ولو صحّ الرمز · ومصدرٌ آخر لا يتأثر', async () => {
    const { srv, clock } = world();
    const own = (await owner(srv)).tokens;
    const inv = ok(await srv.createInvite(own.accessToken, { uid: 'uid-m', name: 'عضو', phone: '0500000020', role: 'staff' }));
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const guess = (i + '').padStart(INVITE_CODE_LENGTH, '0');
      expect(await srv.redeemInvite({ code: guess, deviceKey: devKey(20), source: 'ip-attacker' })).toMatchObject({ ok: false, status: 403, code: 'invalid' });
    }
    expect(await srv.redeemInvite({ code: inv.code, deviceKey: devKey(20), source: 'ip-attacker' })).toMatchObject({ ok: false, status: 429 });
    // نصّ عشوائي وطول خاطئ يُحسبان محاولة أيضاً
    expect(await srv.redeemInvite({ code: '!!', deviceKey: devKey(21), source: 'ip-attacker' })).toMatchObject({ ok: false, status: 429 });
    clock.now += CODE_WINDOW_MS / 2;
    expect((await srv.redeemInvite({ code: inv.code, deviceKey: devKey(20), source: 'ip-attacker' })).ok).toBe(false);
    ok(await srv.redeemInvite({ code: inv.code, deviceKey: devKey(22), source: 'ip-member' }));
  });

  test('العضو لا يصدر دعوة · والمالك يسحب دعوةً قبل استعمالها', async () => {
    const { srv } = world();
    const own = (await owner(srv)).tokens;
    const { joined } = await member(srv, own);
    expect(await srv.createInvite(joined.tokens.accessToken, { uid: 'uid-x', name: 'x', phone: '0500000099', role: 'staff' })).toMatchObject({ ok: false, status: 403 });
    const inv = ok(await srv.createInvite(own.accessToken, { uid: 'uid-y', name: 'ي', phone: '0500000098', role: 'staff' }));
    ok(await srv.revokeInvite(own.accessToken, inv.inviteId));
    expect(await srv.redeemInvite({ code: inv.code, deviceKey: devKey(30), source: 'ip-y' })).toMatchObject({ ok: false, status: 403 });
    // ومعرّف المالك لا يُعطى عضواً
    expect(await srv.createInvite(own.accessToken, { uid: 'uid-owner-masnoo', name: 'x', phone: '0500000097', role: 'staff' })).toMatchObject({ ok: false, status: 409 });
  });

  test('طلبان معاً بالرمز نفسه (جوالان أو إعادة إرسال): يُربط واحدٌ وحده', async () => {
    const { srv } = world();
    const own = (await owner(srv)).tokens;
    const inv = ok(await srv.createInvite(own.accessToken, { uid: 'uid-race', name: 'عضو', phone: '0500000030', role: 'staff' }));
    const both = await Promise.all([1, 2].map((i) => srv.redeemInvite({ code: inv.code, deviceKey: devKey(70 + i), source: 'ip-r' + i })));
    expect(both.filter((r) => r.ok).length).toBe(1);
    expect(both.find((r) => !r.ok)).toMatchObject({ ok: false, status: 403, code: 'used' });
    // وتبديل رمز التحديث معاً: واحدٌ يُبدَّل والآخر يُعامَل ردّاً ضاع (خلال المهلة) لا سرقة
    const done = both.find((r) => r.ok) as Exclude<(typeof both)[number], Fail>;
    const pair = await Promise.all([srv.refresh({ refreshToken: done.tokens.refreshToken }), srv.refresh({ refreshToken: done.tokens.refreshToken })]);
    expect(pair.every((r) => r.ok)).toBe(true);
    expect((await srv.verifyAccess(done.tokens.accessToken)).ok).toBe(true);
  });

  test('مفتاح جهازٍ ضعيف يُرفض (أقل من ٢٥٦ بتاً)', async () => {
    const { srv } = world();
    const own = (await owner(srv)).tokens;
    const inv = ok(await srv.createInvite(own.accessToken, { uid: 'uid-m', name: 'عضو', phone: '0500000021', role: 'staff' }));
    expect(await srv.redeemInvite({ code: inv.code, deviceKey: 'short', source: 'ip' })).toMatchObject({ ok: false, status: 400 });
  });
});

describe('الجلسة: رمز دخولٍ لساعة · ورمز تحديثٍ يُبدَّل عند كل استعمال', () => {
  test('رمز الدخول يعيش ساعةً بساعة الخادم · والعبث بحمولته أو توقيعه يُرفض', async () => {
    const { srv, clock } = world();
    const own = await owner(srv);
    const tok = own.tokens.accessToken;
    expect(own.tokens.accessExpiresAt - clock.now).toBe(ACCESS_TTL_MS);
    expect((await srv.verifyAccess(tok)).ok).toBe(true);
    const [v, payload, sig] = tok.split('.');
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
    forged.exp += 10 * H; forged.role = 'owner';
    expect(await srv.verifyAccess([v, Buffer.from(JSON.stringify(forged)).toString('base64url'), sig].join('.'))).toMatchObject({ ok: false, status: 401 });
    expect(await srv.verifyAccess(tok.slice(0, -2) + (tok.endsWith('AA') ? 'BB' : 'AA'))).toMatchObject({ ok: false, status: 401 });
    expect(await srv.verifyAccess('not.a.token')).toMatchObject({ ok: false, status: 401 });
    // مفتاح توقيعٍ آخر (خادمٌ مزيّف) لا يُقبل
    const other = createAuthServer({ storage: new MemoryAuthStorage(), clock: () => clock.now, signingKey: new Uint8Array(32).fill(9), setupCode: SETUP });
    expect(await other.verifyAccess(tok)).toMatchObject({ ok: false, status: 401 });
    clock.now += ACCESS_TTL_MS;
    expect(await srv.verifyAccess(tok)).toMatchObject({ ok: false, status: 401, code: 'expired' });
  });

  test('جوالٌ غاب أسابيع يجدّد جلسته بلا دخولٍ جديد · والرمز يُبدَّل · وبصمته وحدها في التخزين', async () => {
    const { srv, clock, storage } = world();
    const own = await owner(srv);
    clock.now += 6 * 7 * 24 * H;
    const next = ok(await srv.refresh({ refreshToken: own.tokens.refreshToken }));
    expect(next.refreshToken).not.toBe(own.tokens.refreshToken);
    expect(Buffer.from(next.refreshToken, 'base64url').length).toBe(32);
    expect((await srv.verifyAccess(next.accessToken)).ok).toBe(true);
    expect(JSON.stringify(storage.dump())).not.toContain(next.refreshToken);
  });

  test('إعادة استعمال رمز تحديثٍ مُبدَّل (سُرق): يُسحب الجهاز كله، ورموزه كلها 401، ويُشعَر المالك', async () => {
    const { srv, clock } = world();
    const own = await owner(srv);
    const { joined } = await member(srv, own.tokens);
    const stolen = joined.tokens.refreshToken;
    const legit = ok(await srv.refresh({ refreshToken: stolen }));
    clock.now += REFRESH_GRACE_MS + 1000;
    ok(await srv.refresh({ refreshToken: legit.refreshToken }).then((r) => r));
    // المهاجم يستعمل الرمز القديم بعد أن استُعمل خلفه
    expect(await srv.refresh({ refreshToken: stolen })).toMatchObject({ ok: false, status: 401, code: 'reuse' });
    const latest = await srv.refresh({ refreshToken: legit.refreshToken });
    expect(latest).toMatchObject({ ok: false, status: 401 });
    expect(await srv.verifyAccess(legit.accessToken)).toMatchObject({ ok: false, status: 401, code: 'revoked' });
    const kinds = ok(await srv.listNotifications(own.tokens.accessToken)).items.map((n) => n.kind);
    expect(kinds).toContain('refresh_reuse');
  });

  test('ردٌّ ضاع في الشبكة: الرمز نفسه يُعاد خلال المهلة وخلفه لم يُستعمل · يُعطى زوجٌ جديد ويُبطل الذي ضاع، بلا سحب', async () => {
    const { srv, clock } = world();
    const own = await owner(srv);
    const lost = ok(await srv.refresh({ refreshToken: own.tokens.refreshToken }));
    clock.now += 5_000;
    const retry = ok(await srv.refresh({ refreshToken: own.tokens.refreshToken }));
    expect(retry.refreshToken).not.toBe(lost.refreshToken);
    expect(await srv.refresh({ refreshToken: lost.refreshToken })).toMatchObject({ ok: false, status: 401 });
    ok(await srv.refresh({ refreshToken: retry.refreshToken }));
    // وبعد المهلة إعادةٌ = سرقة
    clock.now += REFRESH_GRACE_MS + 1;
    expect(await srv.refresh({ refreshToken: own.tokens.refreshToken })).toMatchObject({ ok: false, status: 401, code: 'reuse' });
  });

  test('رمز تحديثٍ لا يُعرف يُرفض بلا أثر', async () => {
    const { srv } = world();
    await owner(srv);
    expect(await srv.refresh({ refreshToken: Buffer.alloc(32, 1).toString('base64url') })).toMatchObject({ ok: false, status: 401, code: 'invalid' });
  });
});

describe('جهازٌ ثانٍ وسحب الأجهزة', () => {
  test('رمز ربطٍ قصير العمر من جهازٍ داخل يربط جوالاً ثانياً للحساب نفسه · لاستعمالٍ واحد · ويُشعَر المالك', async () => {
    const { srv, clock } = world();
    const own = await owner(srv);
    const link = ok(await srv.createLinkCode(own.tokens.accessToken));
    expect(link.expiresAt - clock.now).toBe(LINK_TTL_MS);
    const second = ok(await srv.redeemLinkCode({ code: link.code, deviceKey: devKey(40), source: 'ip-2nd' }));
    expect(second.uid).toBe('uid-owner-masnoo');
    expect(second.role).toBe('owner');
    expect(second.deviceId).not.toBe(own.deviceId);
    expect(await srv.redeemLinkCode({ code: link.code, deviceKey: devKey(41), source: 'ip-3rd' })).toMatchObject({ ok: false, status: 403, code: 'used' });
    const late = ok(await srv.createLinkCode(own.tokens.accessToken));
    clock.now += LINK_TTL_MS + 1;
    expect(await srv.redeemLinkCode({ code: late.code, deviceKey: devKey(42), source: 'ip-4th' })).toMatchObject({ ok: false, status: 403, code: 'expired' });
    const devices = ok(await srv.listDevices(own.tokens.accessToken)).items;
    expect(devices.filter((d) => d.uid === 'uid-owner-masnoo' && !d.revokedAt).length).toBe(2);
  });

  test('ضياع الجوال: المالك يسحب جهاز العضو فترجع طلباته 401 (مسار «أُزيلت عضويته») ولا يجدّد · والعضو لا يسحب جهاز غيره', async () => {
    const { srv } = world();
    const own = await owner(srv);
    const { joined } = await member(srv, own.tokens);
    const other = await member(srv, own.tokens, 3);
    expect(await srv.revokeDevice(joined.tokens.accessToken, other.joined.deviceId)).toMatchObject({ ok: false, status: 403 });
    ok(await srv.revokeDevice(own.tokens.accessToken, joined.deviceId));
    expect(await srv.verifyAccess(joined.tokens.accessToken)).toMatchObject({ ok: false, status: 401, code: 'revoked' });
    expect(await srv.refresh({ refreshToken: joined.tokens.refreshToken })).toMatchObject({ ok: false, status: 401, code: 'revoked' });
    expect(await srv.attestLockReset(joined.tokens.accessToken, { deviceKey: devKey(2) })).toMatchObject({ ok: false, status: 401 });
    // العضو يسحب جهازه هو
    ok(await srv.revokeDevice(other.joined.tokens.accessToken, other.joined.deviceId));
    expect((await srv.verifyAccess(other.joined.tokens.accessToken)).ok).toBe(false);
  });

  test('إزالة العضو تسحب أجهزته كلها', async () => {
    const { srv } = world();
    const own = await owner(srv);
    const { joined } = await member(srv, own.tokens);
    const link = ok(await srv.createLinkCode(joined.tokens.accessToken));
    const second = ok(await srv.redeemLinkCode({ code: link.code, deviceKey: devKey(50), source: 'ip' }));
    ok(await srv.removeMember(own.tokens.accessToken, 'uid-member-2'));
    for (const t of [joined.tokens.accessToken, second.tokens.accessToken]) expect(await srv.verifyAccess(t)).toMatchObject({ ok: false, status: 401 });
    expect(await srv.removeMember(own.tokens.accessToken, 'uid-owner-masnoo')).toMatchObject({ ok: false, status: 403 });
  });
});

describe('إشعار المالك', () => {
  test('للمالك وحده · ويُقرّ به', async () => {
    const { srv } = world();
    const own = await owner(srv);
    const { joined } = await member(srv, own.tokens);
    expect(await srv.listNotifications(joined.tokens.accessToken)).toMatchObject({ ok: false, status: 403 });
    const first = ok(await srv.listNotifications(own.tokens.accessToken)).items[0];
    expect(first).toMatchObject({ kind: 'new_device', uid: 'uid-owner-masnoo', seen: false });
    ok(await srv.ackNotification(own.tokens.accessToken, first.id));
    expect(ok(await srv.listNotifications(own.tokens.accessToken)).items[0].seen).toBe(true);
    expect(await srv.ackNotification(joined.tokens.accessToken, first.id)).toMatchObject({ ok: false, status: 403 });
  });
});

describe('«نسيت رمز القفل»: الخادم يشهد أنه الجوال المربوط · ثلاثٌ في ٢٤ ساعة بساعته', () => {
  test('الشهادة تحتاج مفتاح الجهاز نفسه · والحدّ بساعة الخادم وحدها · والمالك يُشعَر بكلٍّ', async () => {
    const { srv, clock } = world();
    const own = await owner(srv);
    const { joined } = await member(srv, own.tokens);
    // رمز الدخول وحده لا يكفي: مفتاح الجهاز المربوط
    expect(await srv.attestLockReset(joined.tokens.accessToken, { deviceKey: devKey(99) })).toMatchObject({ ok: false, status: 403 });
    const t0 = clock.now;
    for (let i = 0; i < LOCK_RESET_LIMIT; i++) {
      const a = ok(await srv.attestLockReset(joined.tokens.accessToken, { deviceKey: devKey(2) }));
      expect(a.serverMs).toBe(clock.now);
      expect(typeof a.ticket).toBe('string');
      clock.now += 1000;
    }
    const fourth = await srv.attestLockReset(joined.tokens.accessToken, { deviceKey: devKey(2) });
    expect(fourth).toMatchObject({ ok: false, status: 429, code: 'limit' });
    expect((fourth as Fail).waitMs).toBe(t0 + LOCK_RESET_WINDOW_MS - clock.now);
    const resets = ok(await srv.listNotifications(own.tokens.accessToken)).items.filter((n) => n.kind === 'lock_reset');
    expect(resets.length).toBe(LOCK_RESET_LIMIT);
    expect(resets.every((n) => n.uid === 'uid-member-2' && n.deviceId === joined.deviceId)).toBe(true);
  });

  test('انحراف ساعة الجهاز لا أثر له: لا يقبل الخادم وقتاً من الطلب، ويُرفع الحدّ بمرور يومٍ بساعته وحدها', async () => {
    const { srv, clock } = world();
    const own = await owner(srv);
    const fresh = async () => ok(await srv.refresh({ refreshToken: own.tokens.refreshToken }));
    let tok = await fresh();
    for (let i = 0; i < LOCK_RESET_LIMIT; i++) ok(await srv.attestLockReset(tok.accessToken, { deviceKey: devKey(1) }));
    // طلبٌ يدّعي أن الوقت بعد يومين (حقلٌ زائد يتجاهله الخادم)
    const claim = { deviceKey: devKey(1), now: clock.now + 48 * H, clientMs: clock.now + 48 * H } as unknown as { deviceKey: string };
    expect(await srv.attestLockReset(tok.accessToken, claim)).toMatchObject({ ok: false, status: 429 });
    clock.now += LOCK_RESET_WINDOW_MS - 2 * H;
    tok = ok(await srv.refresh({ refreshToken: tok.refreshToken }));
    expect(await srv.attestLockReset(tok.accessToken, { deviceKey: devKey(1) })).toMatchObject({ ok: false, status: 429 });
    clock.now += 2 * H + 1;
    // رمز الدخول نفسه انتهى بساعة الخادم (ساعة) فيُجدَّد
    expect(await srv.attestLockReset(tok.accessToken, { deviceKey: devKey(1) })).toMatchObject({ ok: false, status: 401, code: 'expired' });
    tok = ok(await srv.refresh({ refreshToken: tok.refreshToken }));
    expect((await srv.attestLockReset(tok.accessToken, { deviceKey: devKey(1) })).ok).toBe(true);
  });

  test('الحدّ للحساب لا للجهاز: جوالٌ ثانٍ للحساب نفسه لا يضاعفه', async () => {
    const { srv } = world();
    const own = await owner(srv);
    const link = ok(await srv.createLinkCode(own.tokens.accessToken));
    const second = ok(await srv.redeemLinkCode({ code: link.code, deviceKey: devKey(60), source: 'ip' }));
    for (let i = 0; i < LOCK_RESET_LIMIT; i++) ok(await srv.attestLockReset(own.tokens.accessToken, { deviceKey: devKey(1) }));
    expect(await srv.attestLockReset(second.tokens.accessToken, { deviceKey: devKey(60) })).toMatchObject({ ok: false, status: 429 });
  });
});

describe('«حذف حسابي» بإثباتٍ حديث', () => {
  test('العضو: إثباتٌ لغرض الحذف بمفتاح الجهاز ثم الحذف · فتُسحب أجهزته ويُشعَر المالك · والإثبات لا يُستعمل مرتين', async () => {
    const { srv } = world();
    const own = await owner(srv);
    const { joined } = await member(srv, own.tokens);
    expect(await srv.deleteAccount(joined.tokens.accessToken, { ticket: 'x.y.z' })).toMatchObject({ ok: false, status: 401 });
    expect(await srv.freshProof(joined.tokens.accessToken, { deviceKey: devKey(99), purpose: 'deleteAccount' })).toMatchObject({ ok: false, status: 403 });
    const p = ok(await srv.freshProof(joined.tokens.accessToken, { deviceKey: devKey(2), purpose: 'deleteAccount' }));
    ok(await srv.deleteAccount(joined.tokens.accessToken, { ticket: p.ticket }));
    expect(await srv.verifyAccess(joined.tokens.accessToken)).toMatchObject({ ok: false, status: 401 });
    expect(await srv.deleteAccount(joined.tokens.accessToken, { ticket: p.ticket })).toMatchObject({ ok: false, status: 401 });
    const kinds = ok(await srv.listNotifications(own.tokens.accessToken)).items.map((n) => n.kind);
    expect(kinds).toContain('account_deleted');
  });

  test('الإثبات لغيره لا يصلح: شهادة القفل، وإثبات عضوٍ آخر، وإثباتٌ مضت مدته بساعة الخادم', async () => {
    const { srv, clock } = world();
    const own = await owner(srv);
    const a = await member(srv, own.tokens, 2);
    const b = await member(srv, own.tokens, 3);
    const lock = ok(await srv.attestLockReset(a.joined.tokens.accessToken, { deviceKey: devKey(2) }));
    expect(await srv.deleteAccount(a.joined.tokens.accessToken, { ticket: lock.ticket })).toMatchObject({ ok: false, status: 403 });
    const pb = ok(await srv.freshProof(b.joined.tokens.accessToken, { deviceKey: devKey(3), purpose: 'deleteAccount' }));
    expect(await srv.deleteAccount(a.joined.tokens.accessToken, { ticket: pb.ticket })).toMatchObject({ ok: false, status: 403 });
    const pa = ok(await srv.freshProof(a.joined.tokens.accessToken, { deviceKey: devKey(2), purpose: 'deleteAccount' }));
    clock.now += FRESH_TTL_MS + 1;
    const tok = ok(await srv.refresh({ refreshToken: a.joined.tokens.refreshToken }));
    expect(await srv.deleteAccount(tok.accessToken, { ticket: pa.ticket })).toMatchObject({ ok: false, status: 403, code: 'stale' });
  });

  test('المالك: حذف حسابه يحذف المنشأة كلها فتُسحب أجهزة الجميع · ورمز التأسيس نفسه لا يعيد إنشاءها', async () => {
    const { srv } = world();
    const own = await owner(srv);
    const { joined } = await member(srv, own.tokens);
    const p = ok(await srv.freshProof(own.tokens.accessToken, { deviceKey: devKey(1), purpose: 'deleteAccount' }));
    ok(await srv.deleteAccount(own.tokens.accessToken, { ticket: p.ticket }));
    for (const t of [own.tokens.accessToken, joined.tokens.accessToken]) expect((await srv.verifyAccess(t)).ok).toBe(false);
    expect(await srv.bootstrapOwner({ setupCode: SETUP, uid: 'uid-owner-masnoo', name: 'x', deviceKey: devKey(1), source: 'ip' })).toMatchObject({ ok: false, status: 403 });
  });
});

describe('قابل للنقل إلى Workers', () => {
  const dir = join(__dirname, '..', 'server', 'auth');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  test('لا يستورد غير ملفاته · ولا Buffer ولا process ولا وحدات Node', () => {
    for (const f of files) {
      const s = readFileSync(join(dir, f), 'utf8');
      for (const m of s.matchAll(/from\s+'([^']+)'/g)) expect([f, m[1]]).toEqual([f, expect.stringMatching(/^\.\//)]);
      expect([f, /\b(Buffer|process|require)\b/.test(s.replace(/\/\*[^]*?\*\/|\/\/.*$/gm, ''))]).toEqual([f, false]);
    }
  });

  test('يُفحص نوعه بمكتبة العامل وحدها (WebWorker بلا DOM ولا Node)', () => {
    const cfg = ts.readConfigFile(join(__dirname, '..', 'server', 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, join(__dirname, '..', 'server'));
    expect(parsed.options.lib).toEqual(expect.arrayContaining(['lib.webworker.d.ts']));
    expect(parsed.options.types).toEqual([]);
    const prog = ts.createProgram(parsed.fileNames, parsed.options);
    const diags = ts.getPreEmitDiagnostics(prog).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diags).toEqual([]);
    expect(parsed.fileNames.some((f) => f.endsWith('server/auth/server.ts'))).toBe(true);
  });
});
