/**
 * ق٠-٢ (F-7): الخط من ملفات التطبيق لا من حزمة @expo-google-fonts.
 * الحزمة كانت تضمّن روابط fonts.gstatic.com في كود التطبيق من ملف metadata.json فيها.
 * الخط IBM Plex Sans Arabic برخصة OFL، وملفاته الثلاثة المستعملة في assets/fonts مع الرخصة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|json)$/.test(e.name)) out.push(p);
  }
  return out;
};
const CODE = [...walk('src'), ...walk('app')];

const FAMILIES = ['IBMPlexSansArabic_400Regular', 'IBMPlexSansArabic_500Medium', 'IBMPlexSansArabic_700Bold'];

test('لا استيراد من @expo-google-fonts في src ولا app', () => {
  const hits = CODE.filter((f) => read(f).includes('@expo-google-fonts'));
  expect(hits).toEqual([]);
});

test('لا نص gstatic في src ولا app ولا package.json ولا package-lock.json', () => {
  const hits = [...CODE, 'package.json', 'package-lock.json'].filter((f) => read(f).includes('gstatic'));
  expect(hits).toEqual([]);
});

test('حزمة الخط محذوفة من package.json وpackage-lock.json', () => {
  expect(read('package.json')).not.toContain('@expo-google-fonts');
  // تبقى @expo-google-fonts/material-symbols في القفل تبعيةً لـexpo-symbols، تُستورد ملفاتها مباشرة بلا metadata
  expect(read('package-lock.json')).not.toContain('ibm-plex-sans-arabic');
});

test('ملفات الخط الثلاثة ورخصتها في assets/fonts', () => {
  for (const fam of FAMILIES) {
    const p = path.join(ROOT, 'assets', 'fonts', `${fam}.ttf`);
    expect(fs.existsSync(p)).toBe(true);
    // ملف TrueType حقيقي: يبدأ بالتوقيع 0x00010000
    const head = fs.readFileSync(p).subarray(0, 4);
    expect(head.toString('hex')).toBe('00010000');
  }
  const lic = path.join(ROOT, 'assets', 'fonts', 'OFL.txt');
  expect(fs.existsSync(lic)).toBe(true);
  expect(fs.readFileSync(lic, 'utf8')).toContain('SIL Open Font License');
});

/** مفاتيح خريطة useFonts في app/_layout.tsx مع الملف الذي يحمّله كل مفتاح */
const loadedMap = (): Record<string, string> => {
  const s = read('app/_layout.tsx');
  const call = s.match(/useFonts\(\{([\s\S]*?)\}\)/);
  expect(call).not.toBeNull();
  const out: Record<string, string> = {};
  for (const m of call![1].matchAll(/(\w+)\s*:\s*require\(\s*'([^']+)'\s*\)/g)) out[m[1]] = m[2];
  return out;
};

test('_layout يحمّل الملفات الثلاثة بـrequire من assets/fonts بأسماء العائلات نفسها', () => {
  const s = read('app/_layout.tsx');
  expect(s).toMatch(/from 'expo-font'/);
  const map = loadedMap();
  expect(Object.keys(map).sort()).toEqual([...FAMILIES].sort());
  for (const fam of FAMILIES) expect(map[fam]).toBe(`../assets/fonts/${fam}.ttf`);
});

test('كل اسم عائلة مستعمل في الأنماط موجود في الخريطة المحمّلة', () => {
  const map = loadedMap();
  const used = new Set<string>();
  for (const f of CODE) {
    if (f === path.join('app', '_layout.tsx')) continue;
    for (const m of read(f).matchAll(/['"`](IBMPlexSansArabic_\w+)['"`]/g)) used.add(m[1]);
  }
  // ثوابت الخط في السمة يجب أن تبقى كما هي
  const theme = read('src/ui/theme.ts');
  expect(theme).toContain("export const FONT = 'IBMPlexSansArabic_400Regular'");
  expect(theme).toContain("export const FONT_MED = 'IBMPlexSansArabic_500Medium'");
  expect(theme).toContain("export const FONT_BOLD = 'IBMPlexSansArabic_700Bold'");
  expect(used.size).toBeGreaterThan(0);
  for (const fam of used) expect(Object.keys(map)).toContain(fam);
});
