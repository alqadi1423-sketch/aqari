/**
 * ق٠-٨ · الجوال الافتراضي بصورة أندرويد المفتوحة، وفحص «لا اتصال بقوقل» بتسجيل حركة المحاكي (الشرط ١٣ · F-الاستقلال-عن-قوقل.md §٦ و§٨).
 * scripts/ci/noGoogle.js يقرأ pcap من emulator -tcpdump ويُسقط العمل إن ظهر نطاق قوقل من التطبيق بعد علامة run.sh.
 * التسجيلات مصطنعة (tests/helpers/pcapBuild.ts)، ونسختان منها في tests/fixtures/q0_8 يعيد البنّاء توليدهما بايتاً ببايت.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  pcapFile, eth, ipv4, ipv6, udp, dnsQuery, dnsFrame, tlsFrames, cleanCapture, googleCapture, MARKER as BUILD_MARKER,
} from './helpers/pcapBuild';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ng = require('../scripts/ci/noGoogle.js');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures/q0_8');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const hosts = (buf: Buffer) => ng.extractNames(ng.parsePcap(buf)).events.map((e: { host: string; kind: string }) => e.kind + ':' + e.host);

describe('نطاقات قوقل', () => {
  test.each([
    'www.google.com', 'google.com.sa', 'firestore.googleapis.com', 'firebaseinstallations.googleapis.com', 'fonts.gstatic.com',
    'aqari-ec12e.firebaseio.com', 'aqari.firebaseapp.com', 'app-measurement.com', 'settings.crashlytics.com', 'redirector.gvt1.com',
    'ad.doubleclick.net', 'time.android.com', 'aqari.web.app', 'dns.google', 'WWW.GOOGLE.COM.',
  ])('%s من قوقل', (h) => expect(ng.isGoogleHost(h)).toBe(true));

  test.each(['tile.openstreetmap.org', 'nominatim.openstreetmap.org', 'example.com', 'notgoogle.com', 'googly.example.org', ''])(
    '%s ليس من قوقل', (h) => expect(ng.isGoogleHost(h)).toBe(false));

  test('الأصناف: نقاط النظام، والمؤجَّل باسمه، وما سواهما من التطبيق', () => {
    expect(ng.classify('connectivitycheck.gstatic.com')).toBe('system');
    expect(ng.classify('abc123-dnsotls-ds.metric.gstatic.com')).toBe('system');
    expect(ng.classify('firebaselogging.googleapis.com')).toBe('pending');
    expect(ng.classify('firestore.googleapis.com')).toBe('app');
    expect(ng.classify('www.google.com')).toBe('app'); // فحص الاتصال البديل في أندرويد يُطفأ في run.sh، فلا يُستثنى
    expect(ng.classify('tile.openstreetmap.org')).toBeNull();
    // المؤجَّل ناقل سجلات ML Kit وحده (F-2): لا Firestore ولا الدخول ولا Drive، فالحزمة في الجوال الافتراضي بلا إعداد قوقل
    expect(ng.PENDING.map((p: { host: string }) => p.host).sort()).toEqual(['firebaselogging-pa.googleapis.com', 'firebaselogging.googleapis.com']);
  });
});

describe('قراءة الحركة', () => {
  test('حزمة DNS مكتوبة بايتاتها يدوياً (Ethernet · IPv4 · UDP 53 · سؤال A عن www.google.com)', () => {
    const hex =
      'd4c3b2a1020004000000000000000000ffff000001000000' + // ترويسة pcap
      '00000000000000004a0000004a000000' + // سجل الحزمة: ٧٤ بايتاً
      '525400123456525400123457' + '0800' + // Ethernet
      '4500003c1a2b000040110000' + '0a00020f' + '0a000203' + // IPv4 من 10.0.2.15 إلى 10.0.2.3
      'd4310035' + '00280000' + // UDP 54321 → 53
      '123401000001000000000000' + '03777777' + '06676f6f676c65' + '03636f6d00' + '00010001'; // DNS
    expect(hosts(Buffer.from(hex, 'hex'))).toEqual(['dns:www.google.com']);
  });

  test('SNI من مصافحةٍ مقسومة على مقطعين بغير ترتيبهما، ورقم التسلسل يلتفّ بينهما', () => {
    const buf = pcapFile(tlsFrames('firebaseinstallations.googleapis.com', { split: true, reorder: true, padding: 1500 }));
    expect(hosts(buf)).toEqual(['sni:firebaseinstallations.googleapis.com']);
  });

  test('صيغ التسجيل: نانو ثانية، وترتيب بايتات كبير، وIP خام، وIPv6، ووسم VLAN', () => {
    const q = (n: string) => ipv4('10.0.2.16', '10.0.2.3', 17, udp(40001, 53, dnsQuery(n)));
    const q6 = (n: string) => ipv6('fec0::15', 'fec0::3', 17, udp(40002, 53, dnsQuery(n, 9, 28)));
    expect(hosts(pcapFile([eth(q('a.gstatic.com'))], { ns: true, bigEndian: true }))).toEqual(['dns:a.gstatic.com']);
    expect(hosts(pcapFile([q('b.gstatic.com'), q6('c.gstatic.com')], { linktype: 101 }))).toEqual(['dns:b.gstatic.com', 'dns:c.gstatic.com']);
    expect(hosts(pcapFile([eth(q6('d.gstatic.com'), true)]))).toEqual(['dns:d.gstatic.com']);
  });

  test('آخر حزمةٍ مبتورة (المحاكي أُغلق وهو يكتب) لا تُسقط القراءة', () => {
    const full = pcapFile([dnsFrame('one.example.com'), dnsFrame('two.example.com')]);
    const p = ng.parsePcap(full.subarray(0, full.length - 10));
    expect(p.truncated).toBe(true);
    expect(p.packets).toHaveLength(1);
  });

  test('ما ليس pcap يُرفض باسمه: pcapng، وملفٌ قصير، وتوقيعٌ غريب', () => {
    expect(() => ng.parsePcap(Buffer.from('0a0d0d0a' + '00'.repeat(28), 'hex'))).toThrow(/pcapng/);
    expect(() => ng.parsePcap(Buffer.alloc(4))).toThrow(/pcap/);
    expect(() => ng.parsePcap(Buffer.alloc(40, 1))).toThrow(/pcap/);
  });
});

describe('الحكم', () => {
  test('تسجيلٌ نظيف ينجح: قوقل في الإقلاع قبل العلامة يُذكر ولا يُحكم به، وفحص اتصال النظام يُذكر', () => {
    const r = ng.analyze({ pcapBuf: cleanCapture(), mode: 'enforce' });
    expect(r.verdict).toBe('pass');
    expect(r.lines[0]).toBe('no-google pass · mode enforce');
    expect(r.lines).toContain('boot www.google.com (dns,sni)');
    expect(r.lines.some((l: string) => l.startsWith('system connectivitycheck.gstatic.com (dns)'))).toBe(true);
    expect(r.lines.some((l: string) => l.startsWith('app '))).toBe(false);
  });

  test('قوقل من التطبيق يُسقط: سؤال DNS، وSNI بلا سؤال، وHost في HTTP', () => {
    const r = ng.analyze({ pcapBuf: googleCapture(), mode: 'enforce' });
    expect(r.verdict).toBe('fail');
    expect(r.lines).toEqual(expect.arrayContaining([
      'app firestore.googleapis.com (dns)', 'app www.google.com (sni)', 'app fonts.gstatic.com (http)',
    ]));
    expect(r.lines.find((l: string) => l.startsWith('problem '))).toMatch(/firestore\.googleapis\.com fonts\.gstatic\.com www\.google\.com$/);
  });

  test('المؤجَّل (ML Kit) يُذكر ولا يُسقط في enforce، ويُسقط في strict · وreport لا يُسقط أبداً', () => {
    const buf = pcapFile([dnsFrame(BUILD_MARKER), dnsFrame('firebaselogging.googleapis.com', 5)]);
    const enforce = ng.analyze({ pcapBuf: buf, mode: 'enforce' });
    expect(enforce.verdict).toBe('pass');
    expect(enforce.lines.some((l: string) => l.startsWith('pending firebaselogging.googleapis.com (dns) · '))).toBe(true);
    expect(ng.analyze({ pcapBuf: buf, mode: 'strict' }).verdict).toBe('fail');
    expect(ng.analyze({ pcapBuf: googleCapture(), mode: 'report' }).verdict).toBe('report');
  });

  test('لا نظافة بلا دليل: غياب التسجيل، أو تسجيلٌ لا يُقرأ، أو غياب العلامة يُسقط', () => {
    expect(ng.analyze({ pcapBuf: null, mode: 'enforce' }).verdict).toBe('fail');
    expect(ng.analyze({ pcapBuf: Buffer.from('not a capture'), mode: 'enforce' }).verdict).toBe('fail');
    const noMarker = ng.analyze({ pcapBuf: pcapFile([dnsFrame('tile.openstreetmap.org')]), mode: 'enforce' });
    expect(noMarker.verdict).toBe('fail');
    expect(noMarker.lines.join('\n')).toMatch(/علامة النافذة/);
    expect(() => ng.analyze({ pcapBuf: cleanCapture(), mode: 'lenient' })).toThrow(/وضعٌ غير معروف/);
  });
});

describe('الملفات المصطنعة وسطر الأوامر', () => {
  test('tests/fixtures/q0_8 يعيد البنّاء توليدها بايتاً ببايت', () => {
    expect(fs.readFileSync(path.join(FIX, 'clean.pcap')).equals(cleanCapture())).toBe(true);
    expect(fs.readFileSync(path.join(FIX, 'google.pcap')).equals(googleCapture())).toBe(true);
  });

  const cli = (args: string[], env: Record<string, string> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-q08-'));
    const out = path.join(dir, 'no-google.txt');
    const sum = path.join(dir, 'step-summary.md');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/noGoogle.js'), ...args, '--out', out],
      { encoding: 'utf8', env: { ...process.env, NO_GOOGLE_MODE: '', GITHUB_STEP_SUMMARY: sum, ...env } });
    const res = { status: r.status, out: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '', summary: fs.existsSync(sum) ? fs.readFileSync(sum, 'utf8') : '' };
    fs.rmSync(dir, { recursive: true, force: true });
    return res;
  };

  test('الملف النظيف ينجح والملف ذو قوقل يُسقط، والنتيجة في الملف وخلاصة الخطوة', () => {
    const clean = cli(['--pcap', path.join(FIX, 'clean.pcap')]);
    expect(clean.status).toBe(0);
    expect(clean.out.split('\n')[0]).toBe('no-google pass · mode enforce');
    const bad = cli(['--pcap', path.join(FIX, 'google.pcap')]);
    expect(bad.status).toBe(1);
    expect(bad.out).toMatch(/^no-google fail · mode enforce\n/);
    expect(bad.summary).toMatch(/app firestore\.googleapis\.com \(dns\)/);
    // الوضع من NO_GOOGLE_MODE كما في سير العمل
    expect(cli(['--pcap', path.join(FIX, 'google.pcap')], { NO_GOOGLE_MODE: 'report' }).status).toBe(0);
    // ملفٌ غائب فشلٌ يُكتب لا انهيارٌ صامت
    const missing = cli(['--pcap', path.join(FIX, 'absent.pcap')]);
    expect(missing.status).toBe(1);
    expect(missing.out).toMatch(/^no-google fail/);
  });
});

describe('الجوال الافتراضي', () => {
  const wf = read('.github/workflows/android-e2e.yml');
  const run = read('e2e/run.sh');

  test('صورة أندرويد المفتوحة لا صورة قوقل، والمحاكي يسجّل حركته في الملف الذي يفحصه العمل', () => {
    expect(wf).toMatch(/^\s+target: default$/m);
    expect([...wf.matchAll(/^\s+target: (\S+)$/gm)].map((m) => m[1])).toEqual(['default']);
    const cap = /-tcpdump \$\{\{ runner\.temp \}\}\/(\S+)/.exec(wf);
    expect(cap).not.toBeNull();
    expect(wf).toContain(`node scripts/ci/noGoogle.js --pcap "$RUNNER_TEMP/${cap![1]}" --mode "$NO_GOOGLE_MODE" --out e2e-out/no-google.txt`);
    expect(wf).toMatch(/^\s+NO_GOOGLE_MODE: enforce$/m);
    // الفحص بعد التدفقات وقبل الخلاصة، ويجري ولو فشل تدفق
    const iEmu = wf.indexOf('reactivecircus/android-emulator-runner');
    const iCheck = wf.indexOf('- name: لا اتصال بقوقل');
    expect(iEmu).toBeGreaterThan(0);
    expect(iCheck).toBeGreaterThan(iEmu);
    expect(wf.indexOf('- name: الخلاصة')).toBeGreaterThan(iCheck);
    expect(wf.slice(iCheck, iCheck + 80)).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/);
    // التسجيل لا يُنشر في ci-results: e2e-out وحده هناك
    expect(wf).not.toMatch(/cp [^\n]*emu-net\.pcap/);
  });

  test('run.sh يطفئ فحص اتصال أندرويد بقوقل ثم يرسل العلامة قبل تثبيت التطبيق', () => {
    const iOff = run.indexOf('captive_portal_mode 0');
    const iMark = run.indexOf(`ping -c 1 -W 2 ${ng.MARKER}`);
    const iInstall = run.indexOf('adb install');
    expect(iOff).toBeGreaterThan(0);
    expect(run).toContain('private_dns_mode off');
    expect(iMark).toBeGreaterThan(iOff);
    expect(iInstall).toBeGreaterThan(iMark);
    expect(BUILD_MARKER).toBe(ng.MARKER);
  });

  test('منتقي الصور في ١١ ب بمعرّفٍ يطابق حزمته في الصورة المفتوحة وصورة قوقل', () => {
    const flow = read('e2e/maestro/11b-qr-purchase.yaml');
    const ids = [...flow.matchAll(/id: "([^"]*icon_thumbnail)"/g)].map((m) => JSON.parse('"' + m[1] + '"') as string);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      const re = new RegExp('^' + id + '$');
      expect(re.test('com.android.providers.media.module:id/icon_thumbnail')).toBe(true);
      expect(re.test('com.google.android.providers.media.module:id/icon_thumbnail')).toBe(true);
    }
  });

  test('الخلاصة تفشل بفشل الفحص أو غيابه، وتنجح بنجاحه أو بوضع التقرير', () => {
    const summary = (noGoogle: string | null) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-q08s-'));
      fs.mkdirSync(path.join(dir, 'e2e-out'));
      fs.writeFileSync(path.join(dir, 'e2e-out/status.txt'), '00-smoke pass 12s\n01-property pass 30s\n');
      if (noGoogle !== null) fs.writeFileSync(path.join(dir, 'e2e-out/no-google.txt'), noGoogle);
      const r = spawnSync(process.execPath, [path.join(ROOT, 'e2e/summary.js')], { cwd: dir, encoding: 'utf8' });
      const text = fs.readFileSync(path.join(dir, 'e2e-out/summary.txt'), 'utf8');
      fs.rmSync(dir, { recursive: true, force: true });
      return { status: r.status, text };
    };
    const pass = summary('no-google pass · mode enforce\ncapture x\n');
    expect(pass.status).toBe(0);
    expect(pass.text).toMatch(/^success true$/m);
    expect(pass.text).toMatch(/^no-google pass · mode enforce$/m);
    expect(summary('no-google report · mode report\n').status).toBe(0);
    const fail = summary('no-google fail · mode enforce\napp firestore.googleapis.com (dns)\n');
    expect(fail.status).toBe(1);
    expect(fail.text).toMatch(/^success false$/m);
    const missing = summary(null);
    expect(missing.status).toBe(1);
    expect(missing.text).toMatch(/^no-google missing$/m);
  });
});
